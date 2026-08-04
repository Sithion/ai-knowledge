# Architecture Overview

## System Context

CogniStore is a desktop application that provides AI coding agents with persistent semantic memory. It runs entirely on the user's machine — no cloud services, no API keys, no data leaving the laptop.

The system consists of three runtime subsystems:

1. **Desktop Application** — Tauri v2 shell wrapping a React frontend + Fastify sidecar process
2. **MCP Server** — Standalone npm package consumed by AI clients (Claude Code, Copilot, OpenCode) via stdio transport
3. **Shared Libraries** — Monorepo packages for database, embeddings, SDK, and config management

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     AI Coding Agents                             │
│         (Claude Code / GitHub Copilot / OpenCode)                │
└──────────────┬───────────────────────────────────────────────────┘
               │ MCP stdio transport
               ▼
┌──────────────────────────┐    ┌──────────────────────────────────┐
│  @cognistore/mcp-server│    │  Tauri Desktop App               │
│  (npx, standalone)       │    │  ┌────────────┐ ┌──────────────┐ │
│                          │    │  │ React UI   │ │ Fastify      │ │
│  14 tools (knowledge +   │    │  │ (WebView)  │→│ sidecar      │ │
│  plans + tasks + health) │    │  └────────────┘ └──────┬───────┘ │
│                          │    │                        │         │
│                          │    └────────────────────────┼─────────┘
│                          │                             │
│                          │                             │
└──────────┬───────────────┘                             │
           │                                             │
           ▼                                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                      @cognistore/sdk                           │
│              (unified entry point for all consumers)             │
└──────────┬──────────────────────────────────┬────────────────────┘
           │                                  │
           ▼                                  ▼
┌──────────────────────┐          ┌────────────────────────────────┐
│  @cognistore/core  │          │  @cognistore/embeddings      │
│  SQLite + sqlite-vec │          │  Ollama HTTP client (the only  │
│  Drizzle ORM         │          │  one): embeddings + chat       │
└──────────┬───────────┘          └──────────┬─────────────────────┘
           │                                 │
           ▼                                 ▼
┌──────────────────────┐          ┌────────────────────────────────┐
│  ~/.cognistore/    │          │  Ollama (localhost:11434)       │
│  knowledge.db        │          │  Native, auto-installed         │
└──────────────────────┘          └────────────────────────────────┘
```

## Package Dependency Graph

```
@cognistore/mcp-server ──→ @cognistore/sdk
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            @cognistore/core  @cognistore/embeddings  @cognistore/providers
                    │               │               │
                    ▼               ▼               ▼
            @cognistore/shared  @cognistore/shared  @cognistore/shared

@cognistore/dashboard ──→ @cognistore/sdk        (the normal path: all DB access)
                         ──→ @cognistore/config
                         ──→ @cognistore/providers
                         ──→ @cognistore/core       (policy helpers only, see below)
                         ──→ @cognistore/embeddings (Ollama chat transport)
```

All cross-package dependencies use `workspace:*` protocol via pnpm.

The sidecar reaches knowledge data **only** through `@cognistore/sdk`, which owns the single lazily
initialised `KnowledgeService` instance for the process. Its direct edges to `core` and `embeddings`
are deliberately narrow and must stay that way:

- `core` — only the **pure, LLM-free merge policy** (`services/cleanup-merge.ts`). Never the
  repository or a second `KnowledgeService`.
- `embeddings` — only the Ollama **transport** (`OllamaChatClient`). `@cognistore/embeddings` is the
  product's single Ollama boundary (host resolution, model availability, the streaming pull); a second
  HTTP client in the sidecar would drift from it and would be unreachable from the MCP server, which
  only ever sees the SDK.

**Ollama is a single boundary, two capabilities:** `OllamaEmbeddingClient` (embeddings, used on every
read and write) and `OllamaChatClient` (JSON-constrained chat completions). The chat client is
generation-only — it knows nothing about knowledge entries or merge rules.

`@cognistore/providers` is the external-knowledge federation layer (HTTP-contract and MCP-client
providers, `ProviderManager` fan-out, secret resolution). It depends only on `@cognistore/shared`;
`core` likewise depends only on `shared` and receives a `FederatedProviderSource` by injection — so
there is no dependency cycle between `core` and `providers`. See
[External Knowledge Providers](./providers/providers-config.md).

## Data Flow

### Write Path (addKnowledge)

```
1. MCP client sends addKnowledge(title, content, tags, type, scope, source)
2. MCP server validates input with Zod schema (packages/shared)
3. SDK.add() delegates to KnowledgeService.add()
4. Service joins tags into text → sends to Ollama /api/embeddings
5. Ollama returns 768-dimensional float32 vector
6. Repository generates UUIDv4 + ISO timestamps
7. INSERT into knowledge_entries table (Drizzle ORM)
8. INSERT embedding into knowledge_embeddings virtual table (sqlite-vec)
9. Return { id, title, content, tags, type, scope, source, createdAt }
```

### Read Path (getKnowledge)

```
1. MCP client sends getKnowledge(query, options?)
2. Query text → Ollama embedding → 768-dim vector
3. sqlite-vec KNN search returns (limit * 5) candidates with cosine distances
4. Filter candidates: scope (always includes global), tags, type, expiration
5. Convert: similarity = 1 - distance
6. Filter by threshold (default 0.3), sort descending, limit results
7. Return [{ entry, similarity }]
```

### Federated Read Path (getKnowledge with external providers)

Opt-in (`includeExternal`/`providers` params, or the global `alwaysSearchExternalProviders` setting).
Local and external run **concurrently** with per-provider failure isolation; results stay **sectioned
by source** (never merged or cross-ranked).

```
1. SDK.getKnowledgeFederated(query, options?, { providers? })
2. Start the local read path (above) AND ProviderManager.fanOut(query, k, timeout) in parallel
3. fanOut runs each ENABLED provider via runOne():
   - per-provider AbortController, chained to the parent signal + a setTimeout (default 5 s)
   - try/catch: a throw/timeout becomes a section with { error, results: [] } — never rejects
   - results capped (~8 KB/result, ~64 KB/section)
4. Await both → { local: SearchResult[], external: ExternalSection[] }
5. Callers render sections separately; the MCP response adds an `externalNote` (UNTRUSTED) warning
```

Secrets for providers are resolved at request time from `COGNISTORE_PROVIDER_SECRET__*` env vars
(injected by the Rust sidecar from the OS keychain) via `EnvSecretStore`. See
[providers/security.md](./providers/security.md).

### Update Path (updateKnowledge)

```
1. Fetch existing entry by ID
2. If tags changed → re-embed via Ollama
3. Increment version field (version = version + 1)
4. UPDATE knowledge_entries + replace embedding if changed
```

### System Knowledge

System knowledge entries (`type=system`) are a special class of mandatory entries seeded during setup. They contain protocol instructions that agents must follow (e.g., knowledge-first workflow, plan persistence rules). Key properties:

- **Seeded on setup** — Created by the setup wizard as part of the configure step
- **Injected via hook** — `UserPromptSubmit` hooks read system entries from the database and inject them as a `[COGNISTORE-PROTOCOL]` system message at the start of every agent session
- **Hidden from dashboard** — The frontend filters out `type=system` entries from all views (knowledge list, stats, search results)
- **Undeletable** — The `deleteKnowledge` tool and `DELETE /api/knowledge/:id` endpoint reject requests targeting system entries. The `updateKnowledge` tool also rejects type or content changes to system entries
- **Excluded from bulk operations** — Import, export, and bulk delete operations skip system entries
- **Excluded from plan relations** — `addPlanRelation` silently skips system entries to prevent agents from linking protocol instructions to plans

### Plans (Separate Entity)

Plans are stored in their own `plans` table with a separate `plans_embeddings` virtual table. They are linked to knowledge entries via `plan_relations` and have associated `plan_tasks` for todo tracking. The plan lifecycle is: `draft` -> `active` -> `completed` -> `archived`.

**Plan status lifecycle enforcement:** Agents (via MCP) can transition plans through `draft` -> `active` -> `completed` but cannot set `archived` status. Archiving is a user-only action available from the dashboard on completed plans.

**Plan status guards** (enforced in `knowledge.service.ts`):
- Auto-activate: when any task moves to `in_progress`, plan transitions from `draft` to `active`
- Auto-complete tasks: when plan is set to `completed`, all pending/in_progress tasks auto-complete
- Reactivation: if a task is updated on a `completed` plan, plan reactivates to `active`

```
Write: createPlan(title, content, tags, scope, source, tasks?, relatedKnowledgeIds?)
  1. Validate input → INSERT into plans table
  2. If tasks provided → INSERT each into plan_tasks
  3. If relatedKnowledgeIds → INSERT into plan_relations (type=input)
  4. Embed tags → INSERT into plans_embeddings

Task Flow: addPlanTask / updatePlanTask / listPlanTasks
  - Tasks ordered by position (auto-calculated)
  - Status: pending → in_progress → completed
  - Priority: low / medium / high

Batch: addKnowledge (array) / updatePlanTasks
  - addKnowledge: accepts a single entry or an array of entries (each with optional planId)
  - updatePlanTasks: update multiple tasks at once (batch status changes)
```

### Knowledge Retention & Cleanup (groundwork)

> **Status:** schema, read tracking, detection and merge policy only. There are no HTTP routes, no
> scheduler and no UI yet, so the cleanup cycle is not reachable from the app. The only behaviour that
> changes today is that two call sites record reads.

The knowledge base previously only ever grew. The retention model adds three layers, each placed
deliberately:

**1. Read tracking (signal).** `knowledge_entries.last_read_at` / `read_count` are written by
`KnowledgeRepository.markRead()` and by nothing else — never by `update()`, so a read can never be
confused with an edit and cannot perturb `updated_at`, `version`, staleness detection or
duplicate-group canonical ordering. Tracking is **opt-in per call** through `SearchOptions.trackRead`
(declared on the interface *and* in `searchOptionsSchema`, since the Zod object strips unknown keys at
the SDK boundary). Exactly two call sites opt in: the MCP `getKnowledge` tool and the dashboard's
`POST /api/knowledge/search` (forced server-side, so a client can neither forge nor suppress it).
Browsing endpoints, the MCP knowledge-context resource, internal scans and re-embeds must not opt in —
if everything counted as a read, nothing would ever be unread. The mark is dispatched off the response
path (`setImmediate`, best-effort) because `better-sqlite3` is synchronous and the sidecar and MCP
server contend for the same file.

**2. Detection (`packages/core`).** `KnowledgeService.generateCleanupReport()` proposes three
categories — `deprecated` (tag), `unread` (window, with the `keep` tag as an escape hatch) and
`duplicate_group` (high-threshold KNN). It only *describes*; it deletes nothing and calls no model.
Unread detection is double-gated on a domain fact stored in the `cleanup_meta` table
(`read_tracking_since`, written by the migration) rather than on `schema_version` — migration
bookkeeping is not a business fact — plus a liveness check, because a user still running a pre-2.4.0
MCP server records no reads at all and would otherwise see every heavily-used entry flagged.

**3. Policy (`packages/core/src/services/cleanup-merge.ts`).** Pure and LLM-free. It lives in core for
a **trust-boundary** reason, not a testing one: consolidation is applied through an HTTP route, so any
rule enforced only in the producing module can be bypassed by a hand-made request. The merged entry's
tags are always **derived** from the re-fetched members at apply time (union minus the `deprecated` /
`keep` control tags), so a client can never choose them and rig the next cycle. A model only ever
proposes a title and a body.

Layer 3 is why the generative-LLM dependency does not leak downward:

```
apps/dashboard/server/llm-merge.ts     prompt construction + fallback orchestration only
        │
        ├──→ @cognistore/embeddings    OllamaChatClient.chatJson()  (transport)
        └──→ @cognistore/core          validateMergeDraft / deterministicMergeDraft (policy)

packages/core                          no Ollama, no settings, no HTTP — ever
```

The deterministic fallback (canonical entry verbatim + the others appended) is a first-class path, not
a degraded one: the non-canonical members are deleted on approval, so the fallback must lose no
information. Ollama being unavailable degrades the *prose*, never the *safety*.

The queue itself (`cleanup_reports`, `cleanup_candidates`) is accessed through raw prepared statements
rather than Drizzle, mirroring the `operations_daily` precedent: queue-shaped tables with JSON payload
columns. `knowledge_entries` stays on Drizzle. A unique partial index on `status = 'open'` enforces at
most one open report, so two concurrent generators collide on a constraint instead of producing two
competing reports, and a conditional `UPDATE ... WHERE status = 'pending'` makes the state transition
itself the lock for apply.

### Instruction Compilation System

Agent instruction templates are compiled from a single source of truth:

```
apps/dashboard/templates/configs/
├── _base-instructions.md          # Single source of truth for all platforms
├── compile-instructions.mjs       # Compiler script
├── claude-code-instructions.md    # Generated (gitignored)
├── copilot-instructions.md        # Generated (gitignored)
└── opencode-instructions.md       # Generated (gitignored)
```

The base file uses `<!-- IF:platform -->...<!-- ENDIF -->` conditionals for platform-specific sections. The compiler reads the base, evaluates conditionals, and writes the three platform-specific files. The build pipeline (`bundle-sidecar.mjs`) runs the compiler before copying templates to the sidecar bundle.

### OpenCode Plugin System

OpenCode receives enforcement through a TypeScript plugin at `apps/dashboard/templates/plugins/opencode/cognistore-plan-enforcement.ts` with three event handlers:

- `tool.execute.after` — Reminds the agent after Write/Edit/Bash tools to check plan tasks
- `session.end` — Reminds to check plan completion and capture knowledge
- `experimental.session.compacting` — Reminds to reload plan state after context compaction

The plugin is deployed to `~/.config/opencode/plugins/` during setup and managed via `ConfigManager.setupOpenCodePlugins()` / `removeOpenCodePlugins()`.

### Migration System

Database schema changes are managed through versioned SQL migration files:

```
packages/core/src/db/migrations/
├── 0.8.0.sql    # Base schema (knowledge_entries, operations_log)
├── 0.9.0.sql    # Plans table, plan_tasks, plan_relations, title column
├── 1.0.0.sql    # System knowledge type support
├── ...
├── 2.4.0.sql    # Read-tracking columns + cleanup report/candidate queue
└── meta/
    └── _journal.json
```

A `schema_version` table tracks which migrations have been applied. On startup, `createDbClient()` runs `runMigrations()` which detects the current version and applies pending migrations. Pre-migration databases (no `schema_version` table) are bootstrapped automatically.

**Every migration exists twice, and that is structural.** Two independent processes open the same
`~/.cognistore/knowledge.db`: the Fastify sidecar, which ships the `migrations/` directory, and the
bundled MCP server (`npx`), which does not and therefore runs the `EMBEDDED_MIGRATIONS` string map in
`db/migrate.ts`. Both stamp the same `schema_version`, so a drift between the two copies means one
machine ends up with two different schemas under one version number, and whichever process runs second
skips the migration it actually needed. Consequences to respect when adding a migration:

- Add the `.sql` file **and** the embedded string, with identical statements (comments may differ).
  `packages/tests/src/e2e/migration-parity.test.ts` locks the two together.
- The runner strips only whole comment lines and then splits on `;`. A semicolon inside a trailing
  comment or a string literal cuts a statement in half and aborts DB open for *both* processes.
- `EMBEDDED_MIGRATIONS` is re-exported from `@cognistore/core` solely so that parity test can see it.
  It is internal: `@cognistore/core` is a private workspace package with a single barrel export, so
  there is no published contract here — but nothing outside the test should consume it.

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Embedding target | Tags (not content) | Tags are concise semantic anchors; content can be long and noisy |
| Embedding model | nomic-embed-text (768d) | High quality (274MB), excellent accuracy for semantic search |
| Similarity threshold | 0.3 default | Tags produce lower similarity scores than full sentences |
| Database | SQLite + sqlite-vec | Zero-config, single file, no daemon, native vector ops |
| Ollama install | brew (macOS), curl (Linux) | No sudo required on macOS via Homebrew |
| App framework | Tauri v2 | Native desktop, small binary (~15MB), Rust backend |
| MCP distribution | npm (tsup bundle) | Workspace packages inlined, only native deps external |
| Sidecar model | Fastify as child process | Tauri WebView connects to localhost; avoids Tauri IPC complexity |
| State management | Redux Toolkit | Centralized stats/metrics state with async thunks |
| Generative LLM | Local Ollama chat (`llama3.2:3b`), pulled on demand | First generative dependency in the product (v2.4.0). Local-only, so the "nothing leaves the laptop" guarantee is unchanged. Small model + JSON-constrained output; used **only** to make a merged duplicate read better, never to decide what is deleted |
| LLM failure mode | Deterministic fallback, always available | The merge's inputs are deleted on approval, so the no-model path must lose no information. The model is an enhancement, never a dependency |
| LLM transport placement | `@cognistore/embeddings` | Single Ollama boundary (host, model availability, streaming pull); a sidecar-local client would drift and be invisible to the MCP server |
| Merge policy placement | `@cognistore/core`, pure | Apply happens over HTTP; rules enforced only in the producer are bypassable. Tags are derived at apply time so a client cannot inject the `deprecated`/`keep` control tags |
| Read tracking | Opt-in per call, two call sites | A retention signal, not an audit log. If browsing and internal scans counted, nothing would ever be unread |
| Cleanup queue storage | Raw prepared statements | Queue-shaped tables with JSON payloads, mirroring `operations_daily`; `knowledge_entries` stays on Drizzle |

## Directory Structure

```
cognistore/
├── apps/
│   ├── dashboard/              # Tauri v2 desktop application
│   │   ├── src/                # React frontend
│   │   │   ├── pages/          # HomePage, PlansPage, StatsPage, SettingsPage, SetupPage
│   │   │   ├── components/     # Sidebar, UpdateChecker, LanguageSelector
│   │   │   ├── store/          # Redux Toolkit (statsSlice)
│   │   │   ├── i18n/           # Translations (EN, ES, PT)
│   │   │   └── api/            # HTTP client for Fastify sidecar
│   │   ├── server/             # Fastify sidecar
│   │   │   └── index.ts        # API routes (setup, CRUD, stats, health, uninstall)
│   │   ├── src-tauri/          # Rust shell
│   │   │   ├── src/main.rs     # App entry, plugin registration, sidecar spawn
│   │   │   └── src/sidecar.rs  # Node.js finder, process spawner, port allocation
│   │   ├── templates/          # Bundled resources
│   │   │   ├── skills/         # AI skills for Claude Code, Copilot, and OpenCode
│   │   │   ├── plugins/        # OpenCode plugins (plan enforcement)
│   │   │   └── configs/        # Instruction templates (compiled from _base-instructions.md)
│   │   └── scripts/
│   │       └── bundle-sidecar.mjs  # Pre-build: copies server + deps for Tauri bundle
│   └── mcp-server/             # MCP server (published to npm)
│       ├── src/server.ts       # Tool registration + handlers
│       └── tsup.config.ts      # Bundler config (inlines workspace packages)
├── packages/
│   ├── shared/                 # Types, constants, Zod schemas
│   │   └── src/
│   │       ├── types.ts        # KnowledgeEntry, SDKConfig, etc.
│   │       ├── constants.ts    # DEFAULT_SQLITE_PATH, DEFAULT_OLLAMA_HOST, etc.
│   │       └── schemas.ts      # Zod validation schemas
│   ├── core/                   # Database layer
│   │   └── src/
│   │       ├── db/client.ts    # createDbClient(), migration runner, sqlite-vec loader
│   │       ├── db/schema/      # Drizzle table definitions + sqlite-vec virtual tables
│   │       ├── db/migrations/  # Versioned SQL migrations (0.8.0.sql, 0.9.0.sql)
│   │       ├── repositories/   # KnowledgeRepository (CRUD + vector search + cleanup queue)
│   │       └── services/       # KnowledgeService (embedding + persistence orchestration)
│   │           └── cleanup-merge.ts  # Pure, LLM-free merge policy (shared by producer + apply path)
│   ├── embeddings/             # Ollama client (the product's single Ollama boundary)
│   │   ├── src/client.ts       # OllamaEmbeddingClient (embed, ensureModel, healthCheck)
│   │   └── src/chat.ts         # OllamaChatClient (JSON-constrained chat completions)
│   ├── sdk/                    # Public SDK
│   │   └── src/sdk.ts          # KnowledgeSDK class (initialize, add, search, update, delete)
│   └── config/                 # Config injection
│       └── src/config-manager.ts  # Marker-based injection for Claude, Copilot, OpenCode
├── scripts/
│   ├── bump-version.sh         # Version bump across all packages + Cargo.toml + LICENSE
│   └── test-agents.sh          # Agent test battery (Docker Ollama, local DB, multi-client tests)
├── documentation/              # Technical documentation (this directory)
└── .github/
    └── workflows/
        ├── ci.yml              # PR checks: build + test + npm dry-run
        └── publish.yml         # Release: npm publish + Tauri binary builds
```
