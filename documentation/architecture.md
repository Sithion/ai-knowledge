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
│  18 tools (knowledge +   │    │  │ (WebView)  │→│ sidecar      │ │
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
                         ──→ @cognistore/shared     (sidecar: root barrel — Zod schemas + constants)

@cognistore/dashboard (browser bundle) ──→ @cognistore/shared/constants   (subpath ONLY)
```

All cross-package dependencies use `workspace:*` protocol via pnpm.

**The frontend may import `@cognistore/shared`, but only through a subpath.** The dashboard's React
code is the one consumer of a workspace package that ships to a browser, and the package root barrel
(`packages/shared/src/index.ts`) re-exports `utils/validation.ts`, which imports **zod** — pulling the
root into the bundle drags a server-side validation dependency into the app for a handful of string
literals. `packages/shared/package.json` therefore declares a `./constants` export (the first subpath
this monorepo exposes) resolving to `dist/constants/index.js`, which depends only on the plain enums in
`types/knowledge.ts`. The rule for any future frontend import from a workspace package: **add a
narrow subpath export next to the value, never widen the root barrel**, and keep the subpath's
transitive imports free of runtime dependencies. (Subpath resolution requires
`moduleResolution: "bundler"` or `node16`, which the root `tsconfig.json` already sets for every
package.)

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

**Status vocabulary — single source of truth:** `PLAN_STATUS_VALUES` in
`packages/shared/src/constants/defaults.ts` (derived from the `KnowledgeStatus` enum, ordered as the
dashboard renders its filter chips). Everything that validates or filters a plan status imports it:
the MCP tool schemas, the `GET /api/plans` route, the repository's `IN`-clause guard and the
dashboard's chips. Two copies of the literals necessarily live outside TypeScript and must be updated
with it: the `CHECK(status IN (...))` constraint on the `plans` table, in **both**
`packages/core/src/db/migrate.ts` (`EMBEDDED_MIGRATIONS`) and
`packages/core/src/db/migrations/0.9.0.sql`.

> **Naming caveat (known debt):** the enum backing this vocabulary is called `KnowledgeStatus`, but
> `knowledge_entries` has no `status` column — the enum is used *exclusively* for plans (`Plan.status`,
> `PlanChainEntry.status`, `createPlanSchema`/`updatePlanSchema`). Read `KnowledgeStatus` as "plan
> status" until it is renamed; a rename is a mechanical change confined to the workspace, since
> `@cognistore/shared` is `private` and reaches consumers only inlined in the published MCP bundle.

**Plan status lifecycle enforcement:** Agents (via MCP) can transition plans through `draft` -> `active` -> `completed` but cannot set `archived` status. Archiving is a user-only action available from the dashboard on completed plans.

**Plan status guards** (enforced in `knowledge.service.ts`):
- Auto-activate: when any task moves to `in_progress`, plan transitions from `draft` to `active`
- Auto-complete tasks: when plan is set to `completed`, all pending/in_progress tasks auto-complete
- Reactivation: if a task is updated on a `completed` plan, plan reactivates to `active`

```
Write: createPlan(title, content, tags, scope, source, tasks?, relatedKnowledgeIds?, parentPlanId?)
  0. Resolve parentPlanId → derive root_plan_id (parent's root, or the parent itself)
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

**Plan lineage (chains):** a plan created without `parentPlanId` is the ORIGINAL of an effort and stores `parent_plan_id = NULL, root_plan_id = NULL` ("NULL means I am the root"). Every follow-up plan — including one created by a subagent — passes `parentPlanId`, and the service derives and caches `root_plan_id` so a whole chain is one indexed lookup (`WHERE root_plan_id = ?`). `getPlanChain` reads it from any member.

*Invariants every consumer must honor.* There is no foreign key (SQLite cannot add one via `ALTER TABLE`) and several paths write these columns — the HTTP `PUT` route, import, concurrent MCP server processes — so: (1) `parent_plan_id` may dangle, (2) cycles may exist in data, (3) `root_plan_id` may drift, (4) chains may be truncated by the caps. `better-sqlite3` is synchronous, so one unbounded walk would hang the sidecar and every MCP server sharing the database. All traversal therefore lives in one module (`packages/core/src/services/plan-lineage.ts`) and is bounded by a visited set plus `PLAN_CHAIN_MAX_DEPTH` / `PLAN_CHAIN_MAX_ENTRIES`; write-time validation is a convenience, never the guard. *Rejected alternative:* dropping `root_plan_id` and deriving chains with a recursive CTE — cheaper to maintain, but it gives up the indexed chain read used by `listPlans` enrichment, and a column cannot be removed from SQLite later without a table rebuild.

*Validation choke point:* lineage is validated in `KnowledgeService`, not at the tool layer — `sdk.updatePlan` runs no schema, and the MCP server, SDK and dashboard `PUT` route all converge on the service.

*Cross-scope chains are allowed:* dedup is scope-filtered but a chain is not, so a subagent working in another scope can extend the chain. Each chain entry carries its own `scope` so the crossing is visible.

**Protocol-text debt:** the createPlan protocol is spelled out in three independently maintained places — `templates/configs/_base-instructions.md` (compiled to three platform files), `SYSTEM_KNOWLEDGE_CONTENT` in `apps/dashboard/server/index.ts`, and the three `cognistore-plan/SKILL.md` files — plus the hook message strings. Every protocol change pays this tax, and the tool-count strings in the docs have already drifted apart once. Worth generating the seeded text from the SoT at build time; not done in the lineage change.

**Enforcement is advisory outside Claude Code:** only the claude-code hooks can suggest `parentPlanId` (from session-keyed `/tmp` markers) and inject the effort id when a subagent is dispatched. Copilot and OpenCode carry the rule as instruction text only. The system's resilience to unlinked or runaway plans rests on dedup plus the chain caps, not on the text being obeyed.

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
| Plan lineage shape | `parent_plan_id` + denormalized `root_plan_id`, no foreign key | `ALTER TABLE` cannot add an FK in SQLite, so the graph is unenforced by definition. The cached root buys a one-index chain read; the cost is that the service maintains it on create, re-parent, delete and import, and that it may drift (readers fall back to a bounded parent walk). Rejected: recursive CTE only — cheaper to maintain but gives up the indexed read, and an unused column cannot be dropped later without a table rebuild |
| Lineage traversal placement | One module, `packages/core/src/services/plan-lineage.ts`, always bounded | `better-sqlite3` is synchronous: one unbounded walk over a cyclic chain hangs the sidecar and every MCP server on the same file. Caps (`PLAN_CHAIN_MAX_DEPTH`, `PLAN_CHAIN_MAX_ENTRIES`) are the guard; write-time validation is only a convenience |
| Lineage validation placement | `KnowledgeService` | MCP server, SDK and the dashboard `PUT` route all converge there and only the route runs a Zod schema — the service is the single choke point they share |
| Upgrade execution owner | `UpgradePage` POSTs `/api/upgrade/run`; the boot sequence only decides which screen to show | Until v2.4.1 `App.tsx` ran the upgrade silently behind the loading screen and fell back to the upgrade screen only on failure, so a long run (re-embed, artifact redeploy) was indistinguishable from a frozen app. The screen that shows the operation now owns it — the same shape as `SetupPage`. Consequence to respect: nothing else may start an upgrade (the startup self-heal deliberately re-deploys artifacts only, under its own `.artifacts-version` marker), and `POST /api/upgrade/run` must stay idempotent for the boot, since a second window or a StrictMode remount will POST it again. Rejected: keeping the silent run and only adding a progress screen for the failure path — two runners for one operation, with the visible one exercised least |
| Upgrade replay guard | `.version` marker equality plus the boot's last result, held in the sidecar process | A duplicate `POST /api/upgrade/run` must not repeat a re-embed or an npx cache wipe, but a *degraded* run (a `skipped` step still writes `.version`) must stay retryable, so the cached result is replayed only when every step was `success`/`warning`; `noop: true` distinguishes "already current, nothing ran" from "ran with no steps". The state is intentionally process-local and lost on restart — the marker on disk is what survives. Rejected: persisting the last result next to `.version` — durable state for a question only a live window asks |
| Plan status vocabulary SoT | `PLAN_STATUS_VALUES` in `@cognistore/shared`, derived from the `KnowledgeStatus` enum | The literals had drifted into private copies (a `const` tuple in the MCP server, an array in `PlansPage`, the route's absent check) while the `plans` `CHECK` constraint stayed authoritative — so an unknown status silently returned an empty list instead of failing. One exported tuple + an `isPlanStatus` guard makes every validator quote the same list. Deriving from the enum rather than re-typing the strings avoids a second definition inside the package that already owns the vocabulary; the tuple fixes only the ORDER, which is also the dashboard's chip order. Rejected: a Zod schema as the SoT — it would put zod on the path of anything that merely needs the values, including the browser |
| Plan status validation depth | Validated at the HTTP boundary (400), in the repository (throw) and by the SQL `CHECK` — all quoting one list | Deliberate layering, not duplicated policy: the boundary check owns the *HTTP contract* (naming the offending value beats an empty 200), the repository check protects `core`'s own public surface from callers that never pass through a route, and the `CHECK` is the last word for any writer of the file. Because all three read `PLAN_STATUS_VALUES` (or must be edited with it), there is one policy with three enforcement points. Rejected: trusting the route alone — `KnowledgeService` is consumed directly by the SDK and the MCP server, not only over HTTP |
| Frontend access to workspace packages | Narrow subpath exports (`@cognistore/shared/constants`), never the root barrel | The root barrel re-exports the Zod validation module; importing it from React ships a server-side validation dependency to the browser to obtain four string literals. The subpath is a bundle boundary made explicit in `package.json` rather than left to tree-shaking luck. Rejected: duplicating the constants in the frontend (the drift this change exists to remove) and splitting `shared` into two packages (a published-package-shaped solution to a bundling problem) |
| Upgrade progress payload | `{step, status}` only — never `message` | `GET /api/upgrade/progress` is unauthenticated, like every sidecar route (loopback bind + a local-origin CORS allow-list is the app's accepted posture). A `DeployStep.message` carries raw `e.message` text from filesystem errors — absolute paths, and with them the OS username — plus template paths and the globally-installed MCP version. The projection is what keeps the poll payload harmless; the full messages ride the `POST /api/upgrade/run` response the app already consumes. Rejected: publishing the whole step — one field's convenience against every future disclosure review |

## Directory Structure

```
cognistore/
├── apps/
│   ├── dashboard/              # Tauri v2 desktop application
│   │   ├── src/                # React frontend
│   │   │   ├── pages/          # HomePage, PlansPage, StatsPage, TokenConsumptionPage, WidgetsPage,
│   │   │   │                   #   ProvidersPage, SettingsPage + the boot screens SetupPage, UpgradePage
│   │   │   ├── components/     # Layout (nav shell), UpdateChecker, ConfirmModal, knowledge modals/cards
│   │   │   ├── store/          # Redux Toolkit (statsSlice)
│   │   │   ├── i18n/           # Translations (EN, ES, PT)
│   │   │   └── api/            # HTTP client for Fastify sidecar
│   │   ├── server/             # Fastify sidecar
│   │   │   ├── index.ts        # API routes (setup, CRUD, stats, health, uninstall); calls start() at import
│   │   │   ├── cleanup-routes.ts     # Cleanup cycle routes + scheduling predicate
│   │   │   ├── upgrade-progress.ts   # Upgrade step vocabulary, progress store, poll projection
│   │   │   ├── mcp-entry.ts          # MCP entry generation + deployed-version bookkeeping
│   │   │   ├── settings.ts           # settings.json read/write (honours COGNISTORE_HOME)
│   │   │   └── llm-merge.ts          # Duplicate-merge prompt + response validation
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
│   │           ├── cleanup-merge.ts  # Pure, LLM-free merge policy (shared by producer + apply path)
│   │           └── plan-lineage.ts   # Bounded plan-chain traversal (visited set + depth/entry caps)
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
