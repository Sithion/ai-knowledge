# API Reference (Fastify Sidecar)

## Overview

The Fastify sidecar server exposes a REST API consumed by the React frontend. It runs on `localhost:3210+` (dynamic port) and is only accessible locally.

**File:** `apps/dashboard/server/index.ts`

## Health & Status

### GET /api/health

Check database and Ollama connectivity.

**Response:**
```json
{
  "database": { "connected": true, "path": "~/.cognistore/knowledge.db" },
  "ollama": { "connected": true, "host": "http://localhost:11434" }
}
```

### GET /api/setup/status

Check if all setup components are installed and ready.

**Response:**
```json
{
  "node": true,
  "ollama": true,
  "database": true,
  "model": true,
  "mcpConfig": true,
  "sdkReady": true
}
```

## Knowledge CRUD

**System entry filtering:** All GET endpoints for knowledge entries automatically exclude `type=system` entries from results. System entries are managed exclusively by the setup/upgrade pipeline and are not visible in the dashboard.

### GET /api/knowledge/recent

List recent knowledge entries (excludes system entries).

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `limit` | number | 20 | Max entries to return |

**Response:** `KnowledgeEntry[]`

### POST /api/knowledge/search

Semantic search across knowledge entries.

**Body:**
```json
{
  "query": "React performance optimization",
  "tags": ["react"],
  "type": "pattern",
  "scope": "workspace:my-project",
  "limit": 10,
  "threshold": 0.3
}
```

All fields except `query` are optional.

This endpoint counts as real usage: every returned local entry has its `last_read_at` / `read_count`
updated (see [Database Layer](./database.md#knowledge_entries-relational-table)). The flag is forced
server-side and cannot be set or suppressed from the body. Browsing endpoints
(`GET /api/knowledge/recent`, `GET /api/knowledge/:id`) do not count as reads.

**Response (local only):** `{ entry: KnowledgeEntry, similarity: number }[]`

**Federated:** add `"includeExternal": true` (or `"providers": ["id", ...]`) to also query external
knowledge providers. When external search is active — including via the global
`alwaysSearchExternalProviders` setting — the response shape becomes:

```json
{
  "local": [{ "entry": {}, "similarity": 0.0 }],
  "external": [
    { "providerId": "company-wiki", "providerName": "Company Wiki",
      "results": [{ "title": "", "content": "", "url": "", "score": 0.0 }], "tookMs": 142 },
    { "providerId": "docs-mcp", "providerName": "Docs MCP",
      "results": [], "error": "timeout after 5000ms", "tookMs": 5001 }
  ]
}
```

Local results are ranked as before; external results stay sectioned by source (never merged). A failed
provider yields a section with `error` and `results: []`, isolated from local and other providers. See
[External Knowledge Providers](./providers/providers-config.md).

### GET /api/knowledge/:id

Get a single entry by ID.

**Response:** `KnowledgeEntry`

### POST /api/knowledge

Create a new knowledge entry.

**Body:**
```json
{
  "title": "React.memo for list items",
  "content": "Use React.memo for expensive list items",
  "tags": ["react", "performance", "memo"],
  "type": "pattern",
  "scope": "global",
  "source": "code-review",
  "confidenceScore": 0.9,
  "agentId": "claude-code"
}
```

Required: `title`, `content`, `tags`, `type`, `scope`, `source`

**Response:** `KnowledgeEntry`

### PUT /api/knowledge/:id

Update an existing entry. Only include fields to change. Returns `403 Forbidden` if attempting to change `type` or `content` on a system entry (`type=system`).

**Body:**
```json
{
  "content": "Updated content",
  "tags": ["new", "tags"]
}
```

**Response:** `KnowledgeEntry`

### DELETE /api/knowledge/:id

Delete an entry and its embedding. Returns `403 Forbidden` if the entry has `type=system` (system entries are protected and cannot be deleted).

**Response:** `{ success: true }`

**Error (system entry):**
```json
{
  "error": "System knowledge entries cannot be deleted",
  "statusCode": 403
}
```

## Cleanup Reports

The periodic cleanup cycle proposes entries for removal and near-duplicate groups
for consolidation. **Nothing is deleted without an explicit approval call.**

Approving re-checks the entry still qualifies at that moment, so an entry that
was read, un-tagged or marked `keep` after the report was generated is skipped
rather than deleted. All mutating routes below reject requests from a foreign
`Origin`.

### GET /api/cleanup/report

The latest report with its candidates, plus the cleanup settings the UI renders.

**Response:**
```json
{
  "report": {
    "id": "uuid",
    "createdAt": "2026-08-04T16:15:11.180Z",
    "status": "open",
    "stats": {
      "unreadDays": 180,
      "dupThreshold": 0.92,
      "counts": { "deprecated": 1, "unread": 0, "duplicateGroups": 2, "removableEntries": 4 },
      "unreadGate": "read tracking started 0d ago; unread detection activates 2027-01-31"
    }
  },
  "candidates": [
    { "id": "uuid", "category": "deprecated", "entryIds": ["uuid"], "payload": { "title": "…" }, "status": "pending" }
  ],
  "settings": { "cleanupEnabled": true, "cleanupIntervalDays": 10, "cleanupUnreadDays": 180 }
}
```

`stats.unreadGate` is present when unread detection suppressed itself — either
read tracking is younger than the unread window, or no read has been recorded
recently (which is what an outdated MCP server looks like). `report` is `null`
when no report has ever been generated.

### GET /api/cleanup/pending-count

Just the number of pending candidates, for the dashboard banner to poll.

**Response:** `{ "pendingCount": 3 }`

### POST /api/cleanup/report/run

Generate a report now instead of waiting for the cycle. Idempotent: while a
report is open it is returned rather than duplicated.

**Response:** `{ "created": true, "report": { … } }`

### POST /api/cleanup/candidates/:id/preview

Draft the merged entry for a `duplicate_group` candidate so it can be reviewed.
Uses the local Ollama chat model, falling back to a deterministic concatenation
when the model is unavailable.

**The first call may download the model** (~2GB), so allow a long timeout.

**Response:**
```json
{
  "draft": { "title": "Merged title", "content": "Merged body" },
  "usedLlm": true,
  "tags": ["alpha", "beta"]
}
```

`tags` is advisory — the apply route recomputes them server-side from the
entries themselves, so a client cannot choose the merged entry's tags.

**Errors:** `400` for a non-duplicate candidate, `409` when fewer than two
members still exist.

### POST /api/cleanup/candidates/:id/approve

Apply a candidate: delete the entries (`deprecated` / `unread`), or merge the
group into its newest member and delete the rest (`duplicate_group`).

**Body — required for `duplicate_group` only:**
```json
{ "draft": { "title": "…", "content": "…" }, "usedLlm": true }
```

A consolidation **cannot** be approved without a draft: the merged text must be
one the user actually saw, since approving deletes the other members.

**Response:** `{ "deleted": 2, "skipped": 0, "errors": [] }` for removals,
`{ "canonicalId": "uuid", "deleted": 1, "errors": [] }` for consolidations.

**Errors:** `400` when a consolidation has no draft, `404` unknown candidate,
`409` when the candidate is no longer pending (already applied or dismissed by
another window) or the canonical entry changed since the report was generated.

### POST /api/cleanup/candidates/:id/dismiss

Decline a candidate. Only a pending candidate can be dismissed — dismissing an
applied one would erase it from the report's removal tally.

**Response:** `{ "dismissed": true }` · **Errors:** `404`, `409`

### POST /api/cleanup/report/:id/close

Seal a report. Remaining pending candidates are dismissed and the number of
entries actually removed while it was open is recorded.

**Response:** `{ "removed": 3 }`

A report left open for more than twice the configured interval is closed
automatically on the next cycle, so an ignored report cannot block future ones.

## Statistics & Metrics

### GET /api/stats

Aggregated entry counts.

**Response:**
```json
{
  "total": 150,
  "byType": [
    { "type": "pattern", "count": 45 },
    { "type": "fix", "count": 38 }
  ],
  "byScope": [
    { "scope": "global", "count": 80 },
    { "scope": "workspace:my-app", "count": 70 }
  ]
}
```

### GET /api/metrics

Detailed metrics for the stats dashboard.

**Response:**
```json
{
  "database": { "size": "2.4 MB", "path": "~/.cognistore/knowledge.db" },
  "activity": { "last24h": 12, "last7d": 45 },
  "activityByDay": [
    { "date": "2026-03-17", "count": 8 },
    { "date": "2026-03-16", "count": 4 }
  ],
  "heatmap": [
    { "date": "2026-03-17", "count": 8 },
    { "date": "2025-12-18", "count": 0 }
  ],
  "typeDistribution": [
    { "type": "pattern", "count": 45 }
  ]
}
```

- `activityByDay`: Last 15 days of activity
- `heatmap`: Last 90 days (daily counts for contribution heatmap)

### GET /api/tags

List all unique tags.

**Response:** `string[]`

## External Knowledge Providers

CRUD for `~/.cognistore/providers.json`. Secret **values** are never sent through these routes — only a
`secretRef`; values go to the OS keychain via the Tauri `set_provider_secret` command. See
[providers-config.md](./providers/providers-config.md) and [security.md](./providers/security.md).

### GET /api/providers

Read the current providers config.

**Response:** `{ "version": 1, "providers": ProviderEntry[] }`

### POST /api/providers

Add a provider (zod-validated `ProviderEntry`). Writes atomically (tmp + rename).

**Body:** a `ProviderEntry` (`id`, `name`, `kind`, `enabled`, and a matching `http` or `mcp` block).
**Response:** the created `ProviderEntry`.

### PUT /api/providers/:id

Update a provider (partial `ProviderEntry`).

**Response:** the updated `ProviderEntry`.

### DELETE /api/providers/:id

Remove a provider from the config.

**Response:** `{ "removed": boolean }` (the dashboard also clears the provider's keychain entry).

### POST /api/providers/:id/test

Instantiate the provider and run its `testConnection` (8 s timeout), then dispose it.

**Response:** `{ "ok": boolean, "message"?: string }`

## Setup Endpoints

### POST /api/setup/node

Install or detect Node.js v24.

### POST /api/setup/ollama

Install Ollama (brew on macOS, curl on Linux).

### POST /api/setup/ollama-start

Start `ollama serve` as background daemon. Waits up to 15 seconds for readiness.

### POST /api/setup/database

Create SQLite database with schema and indices.

### POST /api/setup/model

Pull `nomic-embed-text` embedding model via Ollama API.

### POST /api/setup/configure

Inject MCP configs, instruction markers, and AI skills into all supported clients.

### POST /api/setup/complete

Finalize setup and re-initialize the SDK.

## Upgrade

### POST /api/upgrade/run

Run the upgrade pipeline. Compares `~/.cognistore/.version` with the running app version. On mismatch, re-deploys all artifacts: database migrations, agent instructions (recompiled from `_base-instructions.md`), MCP configs, skills/hooks, OpenCode plugins, and system knowledge entries.

`~/.cognistore/.version` is written **only** when the app version is known and no step failed — a half-finished upgrade is not recorded as complete, and an unknown version is never persisted.

**Response (success):**
```json
{
  "success": true,
  "fromVersion": "2.4.0",
  "toVersion": "2.4.1",
  "results": [
    { "step": "database", "status": "success", "message": "Schema up to date" },
    { "step": "version", "status": "success", "message": "v2.4.1" }
  ]
}
```

`results[].status` is `success`, `warning`, `skipped` or `error`; `success` is `true` when every step is `success` or `warning`.

`results[].step` is one of the names in the `DeployStepName` union declared in `apps/dashboard/server/upgrade-progress.ts` — the source of truth for the step vocabulary. `reembed` and `integrity` are conditional (an embedding-dimension change and an embedding shortfall respectively), so a healthy upgrade emits nine steps and at most eleven.

**Already up to date:** before doing any work the handler re-reads `~/.cognistore/.version`, so a duplicate request — a second window, a StrictMode remount, or a request that just waited out an in-flight deploy — never repeats the upgrade:

- Marker already equals the running app version and an upgrade completed this boot with every step `success` or `warning` → returns that run's `results` verbatim (messages included), without repeating any work.
- Marker already equals the running app version but that run was **degraded** — a `skipped` step; `.version` is written whenever nothing hard-errored — → the upgrade **runs again**. A failed result is never replayed from the cache, so retrying stays meaningful (a `reembed` skipped because Ollama was still starting can succeed on the second attempt).
- Marker already equals the running app version and nothing ran this boot → returns

  ```json
  { "success": true, "noop": true, "fromVersion": "2.4.1", "toVersion": "2.4.1", "results": [] }
  ```

  Treat `noop` as "nothing to do", not as a completed upgrade with no steps.
- Otherwise the upgrade runs normally. This includes the case where the app version is unknown (`0.0.0`): nothing is ever short-circuited on an unresolved version.

**Concurrency:** if a deploy is already running (startup self-heal or `/api/redeploy`), the request **waits** for it and then applies the check above — the upgrade it was waiting for may well have been the one it wanted.

A `409 Upgrade already in progress` is returned only when another deploy holds the lock without an awaitable promise — in practice a concurrent `/api/redeploy`.

### GET /api/upgrade/progress

Live view of the upgrade `POST /api/upgrade/run` is performing, for a client that wants to show progress while it waits. Poll it (the upgrade screen polls every 750 ms).

**Response:**
```json
{
  "running": true,
  "startedAt": "2026-08-06T12:00:00.000Z",
  "fromVersion": "2.4.0",
  "toVersion": "2.4.1",
  "currentStep": "reembed",
  "steps": [
    { "step": "database", "status": "success" }
  ]
}
```

- `steps` mirrors the `results` of the in-flight run, **without `message`**. Step messages embed raw filesystem errors — absolute paths, and with them the OS username — plus template paths and the globally-installed MCP version. This endpoint is unauthenticated like every route here, so it publishes names and statuses only; the full messages come back with the `POST` response the app already consumes.
- `currentStep` names the phase about to run, and is `null` while the artifact steps run (they are published individually as they complete) and once the run ends.
- **No readiness guard:** this endpoint never returns `503`, deliberately — it has to answer while the `database` step has the SDK torn down. It reads in-memory state only.
- **Between runs** it keeps `running: false` with the previous run's `steps` still populated, so a client that connects late can still render what happened. `startedAt` identifies which run a snapshot describes: latch it to tell a fresh snapshot from a stale one. Before the first run of the process it answers `running: false` with `startedAt` and `fromVersion` `null` and `steps: []`; `toVersion` is always the running app version, run or no run.
- The startup self-heal deliberately publishes nothing here — only user-visible upgrades do.

### POST /api/redeploy

Re-deploy on-disk artifacts without touching the database, embeddings or the version markers: agent instructions, MCP configs, skills and global hooks. Shares the same `redeployArtifacts()` routine as `/api/upgrade/run` and the startup self-heal.

Missing templates are reported as `error` steps (the call no longer reports success regardless of outcome).

**Response:**
```json
{
  "success": true,
  "results": [
    { "step": "instructions-claude", "status": "success" },
    { "step": "mcp-configs", "status": "success" }
  ]
}
```

Returns `409 A deploy is already in progress` when another deploy holds the lock.

### Startup self-heal

The sidecar re-deploys the same artifacts at launch, without any HTTP call, when all of the following hold:

- `COGNISTORE_MANAGED=1` (set only by the Tauri shell — see [Tauri sidecar](./tauri-sidecar.md#environment-variables))
- the app version resolved (not `0.0.0`)
- it is not a first install (`~/.cognistore/.version` or `~/.cognistore/.artifacts-version` exists)
- `~/.cognistore/.artifacts-version` differs from the running version

On success it writes `~/.cognistore/.artifacts-version`. That marker is intentionally separate from `.version`, which stays owned by `/api/upgrade/run` (the only path that also re-embeds and re-checks embedding integrity). Both markers live inside `~/.cognistore/` and are removed by uninstall with the directory.

## Export & Import

### GET /api/export

Unified data export. Returns a JSON file with selected data types.

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `include` | string | `knowledge,plans` | Comma-separated data types to include |

**Response:** JSON file download (`cognistore-export.json`)
```json
{
  "version": "1.0.7",
  "exportedAt": "2026-03-24T12:00:00.000Z",
  "knowledge": [{ "title": "...", "content": "...", "tags": [...], ... }],
  "plans": [{ "title": "...", "content": "...", "tasks": [...], ... }]
}
```

### POST /api/import

Unified data import. Accepts the export format and selectively imports data.

**Body:**
```json
{
  "include": ["knowledge", "plans"],
  "knowledge": [{ "title": "...", "content": "...", "tags": [...], ... }],
  "plans": [{ "title": "...", "content": "...", "tasks": [...], ... }]
}
```

**Response:**
```json
{
  "knowledge": { "imported": 10, "skipped": 2, "errors": [] },
  "plans": { "imported": 3, "skipped": 0, "errors": [] }
}
```

System-type entries are automatically converted to `pattern` type on import.

## Uninstall

### POST /api/uninstall

Full teardown: remove configs, skills, data, Ollama, and self-delete app. See [Setup & Uninstall](./setup-uninstall.md) for details.

## Plans CRUD

### GET /api/plans

List plans with optional status filter.

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `limit` | number | 20 | Max plans to return |
| `status` | string | — | Filter by status: `draft`, `active`, `completed`, `archived` |

**Response:** `Plan[]`

### POST /api/plans

Create a new plan.

**Body:**
```json
{
  "title": "Migration to v2 API",
  "content": "Step-by-step migration plan...",
  "tags": ["migration", "api"],
  "scope": "workspace:my-app",
  "source": "planning-session",
  "tasks": [
    { "description": "Audit current endpoints", "priority": "high" },
    { "description": "Write migration scripts", "priority": "medium" }
  ],
  "relatedKnowledgeIds": ["uuid-1", "uuid-2"],
  "parentPlanId": "uuid-of-the-plan-this-continues"
}
```

Required: `title`, `content`, `tags`, `scope`, `source`

Optional `parentPlanId` links the plan into an existing chain. Omitted, the plan becomes the ORIGINAL (root) of a new chain. A parent that does not exist does not fail the request — the plan is created as a root.

**Response:** `Plan`

### PUT /api/plans/:id

Update a plan. Only include fields to change. The `archived` status can only be set from the dashboard (not via MCP) — agents are restricted to `draft`, `active`, and `completed` transitions.

**Body:**
```json
{
  "status": "active",
  "title": "Updated title",
  "parentPlanId": "uuid-of-another-plan"
}
```

`parentPlanId` re-links the plan into another chain; `null` unlinks it, making it the ORIGINAL of its own chain. Unlike `POST /api/plans`, re-linking is strict: pointing a plan at itself, at one of its own descendants, or at a `parentPlanId` that does not exist returns **400** with an explanatory message.

**Response:** `Plan`

### DELETE /api/plans/:id

Delete a plan and all associated tasks and relations. Only the target plan is deleted — the lineage around it is repaired in the same transaction: children are re-parented to the deleted plan's parent, and deleting a chain's ORIGINAL promotes each direct child to the root of its own subtree.

**Response:** `{ success: true }`

### GET /api/plans/:id/chain

Get the full lineage chain the plan belongs to. Accepts any member: the chain's root is resolved first, so a leaf returns the whole chain.

**Response:**
```json
{
  "rootPlanId": "uuid-of-original",
  "chain": [
    { "id": "uuid-of-original", "title": "...", "status": "completed", "scope": "workspace:my-app", "parentPlanId": null, "depth": 0, "isCurrent": false },
    { "id": "uuid-child", "title": "...", "status": "active", "scope": "workspace:my-app", "parentPlanId": "uuid-of-original", "depth": 1, "isCurrent": true }
  ],
  "truncated": false
}
```

Ordered root-first, then by depth (ties broken by creation time). Plan content is never included. `truncated: true` means the chain hit the traversal caps (depth 64, 500 entries).

> **Export/import:** lineage is **instance-local** and does not travel. `GET /api/export` projects an explicit field list for plans (`title`, `content`, `tags`, `scope`, `source`, `status`, `createdAt`, `tasks`) that omits `parentPlanId` / `rootPlanId`, and `POST /api/import` strips them if present anyway — plan ids are regenerated on import, so a foreign id would either dangle or graft onto an unrelated local chain. Imported plans always arrive as standalone ORIGINALs.

### GET /api/plans/:id/relations

Get knowledge entries linked to a plan.

**Response:** `{ entry: KnowledgeEntry, relationType: "input" | "output" }[]`

### POST /api/plans/:id/relations

Link a knowledge entry to a plan. Silently skips system knowledge entries (`type=system`) — returns success but does not create the relation.

**Body:**
```json
{
  "knowledgeId": "uuid-of-entry",
  "relationType": "input"
}
```

**Response:** `{ success: true }`

## Plan Tasks

### GET /api/plans/:planId/tasks

List tasks for a plan, ordered by position.

**Response:** `PlanTask[]`

### POST /api/plans/:planId/tasks

Add a task to a plan.

**Body:**
```json
{
  "description": "Write unit tests",
  "priority": "high",
  "notes": null
}
```

**Response:** `PlanTask`

### PUT /api/plans/tasks/:taskId

Update a task (status, description, priority, notes).

**Body:**
```json
{
  "status": "completed",
  "notes": "All tests passing"
}
```

**Response:** `PlanTask`

### DELETE /api/plans/tasks/:taskId

Delete a task. Used by the dashboard's per-task delete button, which branches on `deleted`.

**Response:** `{ "deleted": true }` — `deleted` is `false` when no task with that id existed (still `200`, not `404`).

## Error Handling

### Degraded Mode (503)

If the SDK fails to initialize on startup, the server enters degraded mode:

- All knowledge endpoints return `503 Service Unavailable`
- Setup and health endpoints remain available
- SDK re-initialization retried every 10 seconds
- Once SDK initializes, all endpoints become available

### Standard Error Response

```json
{
  "error": "Entry not found",
  "statusCode": 404
}
```
