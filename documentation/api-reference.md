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

**Response (success):**
```json
{
  "success": true,
  "from": "0.9.16",
  "to": "1.0.0",
  "steps": ["migrations", "instructions", "mcpConfigs", "skills", "plugins", "systemKnowledge"]
}
```

**Response (already up-to-date):**
```json
{
  "success": true,
  "message": "Already up to date"
}
```

**Response (concurrent request):**
```json
{
  "error": "Upgrade already in progress",
  "statusCode": 409
}
```

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
  "relatedKnowledgeIds": ["uuid-1", "uuid-2"]
}
```

Required: `title`, `content`, `tags`, `scope`, `source`

**Response:** `Plan`

### PUT /api/plans/:id

Update a plan. Only include fields to change. The `archived` status can only be set from the dashboard (not via MCP) — agents are restricted to `draft`, `active`, and `completed` transitions.

**Body:**
```json
{
  "status": "active",
  "title": "Updated title"
}
```

**Response:** `Plan`

### DELETE /api/plans/:id

Delete a plan and all associated tasks and relations.

**Response:** `{ success: true }`

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

### PUT /api/tasks/:id

Update a task (status, description, priority, notes).

**Body:**
```json
{
  "status": "completed",
  "notes": "All tests passing"
}
```

**Response:** `PlanTask`

### DELETE /api/tasks/:id

Delete a task.

**Response:** `{ success: true }`

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
