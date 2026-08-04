# Database Layer

## Overview

The knowledge base uses **SQLite** with the **sqlite-vec** extension for vector similarity search. The database is managed through **Drizzle ORM** and stored as a single file at `~/.cognistore/knowledge.db`.

## Schema

### knowledge_entries (relational table)

**File:** `packages/core/src/db/schema/knowledge.ts`

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | TEXT PK | UUIDv4 | Unique identifier |
| `title` | TEXT NOT NULL | `''` | Short descriptive title |
| `content` | TEXT NOT NULL | — | Knowledge content (free text) |
| `tags` | TEXT NOT NULL | `'[]'` | JSON array of string tags |
| `type` | TEXT NOT NULL | — | One of: `decision`, `pattern`, `fix`, `constraint`, `gotcha`, `system` |
| `scope` | TEXT NOT NULL | — | `global` or `workspace:<project-name>` |
| `source` | TEXT NOT NULL | — | Origin of the knowledge (file, conversation, etc.) |
| `version` | INTEGER NOT NULL | `1` | Incremented on each update |
| `expires_at` | TEXT | NULL | ISO timestamp for TTL (optional) |
| `confidence_score` | REAL NOT NULL | `1.0` | 0.0–1.0 confidence rating |
| `related_ids` | TEXT | NULL | JSON array of related entry IDs |
| `agent_id` | TEXT | NULL | ID of the agent that created this entry |
| `platform` | TEXT | NULL | Auto-detected host platform: `claude-code`, `copilot`, `opencode` or `unknown` |
| `last_read_at` | TEXT | NULL | ISO timestamp of the last tracked retrieval. Written only by read tracking (`SearchOptions.trackRead`), never by edits — see below |
| `read_count` | INTEGER NOT NULL | `0` | Number of tracked retrievals since read tracking began |
| `created_at` | TEXT NOT NULL | — | ISO timestamp |
| `updated_at` | TEXT NOT NULL | — | ISO timestamp |

**Indices:**
- `idx_type` on `type`
- `idx_scope` on `scope`

**System entries (`type=system`):** Mandatory protocol entries seeded during setup. These entries are protected at the application layer:
- `deleteKnowledge` rejects deletion requests for system entries
- `updateKnowledge` rejects type or content changes to system entries
- Bulk operations (import, export, bulk delete) skip system entries
- `addPlanRelation` silently skips system entries (no error, no relation created)
- The dashboard frontend filters them out of all views and search results
- `UserPromptSubmit` hooks read system entries and inject them as `[COGNISTORE-PROTOCOL]` system messages

**Read tracking (`last_read_at` / `read_count`):** These columns are a retention signal, not an audit log. They are updated only when a search explicitly opts in via `SearchOptions.trackRead`, which today happens at exactly two call sites: agent retrieval through the MCP `getKnowledge` tool, and the dashboard's explicit search endpoint (`POST /api/knowledge/search`, which forces the flag server-side so a client cannot suppress or forge it). Browsing endpoints (`/api/knowledge/recent`, `/api/knowledge/:id`), the MCP knowledge-context resource, internal scans and re-embeds deliberately do **not** opt in. Marking a read never changes `updated_at` or `version` — a read is not an edit.

### knowledge_embeddings (virtual table)

**File:** `packages/core/src/db/schema/sqlite-vec.ts`

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_embeddings
USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[768] distance_metric=cosine
);
```

This is a **sqlite-vec** virtual table that stores 768-dimensional float32 vectors with cosine distance metric. It supports KNN (k-nearest-neighbor) queries.

### plans (relational table)

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | TEXT PK | UUIDv4 | Unique identifier |
| `title` | TEXT NOT NULL | — | Plan title |
| `content` | TEXT NOT NULL | — | Full plan content (steps, approach, considerations) |
| `tags` | TEXT NOT NULL | `'[]'` | JSON array of string tags |
| `scope` | TEXT NOT NULL | — | `global` or `workspace:<project-name>` |
| `status` | TEXT NOT NULL | `'draft'` | One of: `draft`, `active`, `completed`, `archived` |
| `source` | TEXT NOT NULL | `''` | Origin of the plan |
| `created_at` | TEXT NOT NULL | — | ISO timestamp |
| `updated_at` | TEXT NOT NULL | — | ISO timestamp |

**Indices:**
- `idx_plans_status` on `status`
- `idx_plans_scope` on `scope`

### plan_relations (join table)

Links plans to knowledge entries with a relation type.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK AUTOINCREMENT | Row ID |
| `plan_id` | TEXT NOT NULL FK → plans(id) ON DELETE CASCADE | Parent plan |
| `knowledge_id` | TEXT NOT NULL FK → knowledge_entries(id) ON DELETE CASCADE | Linked entry |
| `relation_type` | TEXT NOT NULL | `input` (consulted during planning) or `output` (created during execution) |
| `created_at` | TEXT NOT NULL | ISO timestamp |

**Constraints:** `UNIQUE(plan_id, knowledge_id, relation_type)`

**Indices:**
- `idx_plan_relations_plan` on `plan_id`
- `idx_plan_relations_knowledge` on `knowledge_id`

### plan_tasks (todo list per plan)

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | TEXT PK | UUIDv4 | Unique identifier |
| `plan_id` | TEXT NOT NULL FK → plans(id) ON DELETE CASCADE | Parent plan |
| `description` | TEXT NOT NULL | — | Task description |
| `status` | TEXT NOT NULL | `'pending'` | One of: `pending`, `in_progress`, `completed` |
| `priority` | TEXT NOT NULL | `'medium'` | One of: `low`, `medium`, `high` |
| `notes` | TEXT | NULL | Optional notes about progress or blockers |
| `position` | INTEGER NOT NULL | `0` | Sort order within the plan |
| `created_at` | TEXT NOT NULL | — | ISO timestamp |
| `updated_at` | TEXT NOT NULL | — | ISO timestamp |

**Indices:**
- `idx_plan_tasks_plan` on `plan_id`
- `idx_plan_tasks_status` on `status`

### plans_embeddings (virtual table)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS plans_embeddings
USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[768] distance_metric=cosine
);
```

Separate sqlite-vec virtual table for plan embeddings, identical structure to `knowledge_embeddings`.

### schema_version (migration tracking)

Tracks which SQL migrations have been applied.

| Column | Type | Description |
|--------|------|-------------|
| `version` | TEXT PK | Migration version (e.g., `0.8.0`, `0.9.0`) |
| `applied_at` | TEXT NOT NULL | ISO timestamp when migration was run |

## Migration System

**Files:** `packages/core/src/db/migrations/*.sql`, `packages/core/src/db/client.ts`

Schema changes are managed through versioned SQL migration files. On startup, `createDbClient()` calls `runMigrations()` which:

1. Creates the `schema_version` table if it does not exist
2. Reads all `.sql` files from the migrations directory, sorted by version
3. Skips migrations already recorded in `schema_version`
4. Executes pending migrations in order within a transaction
5. Records each applied migration in `schema_version`

For pre-migration databases (existing databases with no `schema_version` table but with `knowledge_entries`), the runner bootstraps by recording `0.8.0` as already applied and then running subsequent migrations.

**Note on system knowledge:** System knowledge entries (`type=system`) are seeded via application code in `server/index.ts` during the setup configure step, not via SQL migrations. This allows the content to be updated programmatically on upgrades without requiring new migration files.

**Note on schema_version bootstrap:** When the migration runner encounters an existing database that has no `schema_version` table, it creates the table and records `0.8.0` as already applied. This allows existing pre-migration databases to receive subsequent migrations without re-running the base schema.

```
packages/core/src/db/migrations/
├── 0.8.0.sql   # Base schema: knowledge_entries, operations_log
├── 0.9.0.sql   # Plans: plans, plan_relations, plan_tasks, title column
├── 1.0.0.sql   # System knowledge type support
└── meta/
    └── _journal.json
```

## Auto-Schema Creation

**File:** `packages/core/src/db/client.ts`

The `createDbClient()` function runs versioned migrations and then creates sqlite-vec virtual tables (idempotent). This means the MCP server can initialize from scratch without the setup wizard — the SDK will create the database and schema on first use.

## SQLite Configuration

| Pragma | Value | Purpose |
|--------|-------|---------|
| `journal_mode` | `WAL` | Write-Ahead Logging for concurrent reads |
| `busy_timeout` | `5000` | Wait 5s before SQLITE_BUSY error |
| `foreign_keys` | `ON` | Enforce referential integrity |

## Vector Search Implementation

**File:** `packages/core/src/repositories/knowledge.repository.ts`

### Similarity Search Algorithm

```
Input: query vector (768-dim), options (scope, tags, type, limit, threshold)

1. KNN Phase (sqlite-vec):
   SELECT id, distance FROM knowledge_embeddings
   WHERE embedding MATCH ?
   ORDER BY distance
   LIMIT (limit * 5)  -- oversample for post-filtering

2. Post-Filter Phase (application layer):
   - Fetch full entries for KNN results
   - Filter by scope (requested scope + always include global)
   - Filter by tags (if specified, entry tags must include all query tags)
   - Filter by type (if specified)
   - Filter by expiration (exclude expired entries)
   - Convert: similarity = 1 - distance
   - Filter by threshold (default 0.3)
   - Sort by similarity descending
   - Limit to requested count

3. Return: [{ entry, similarity }]
```

### Why Tags Are Embedded (Not Content)

Tags serve as semantic anchors — they are concise, intentional descriptors chosen by the agent. Content can be arbitrarily long and noisy, which dilutes embedding quality. By embedding tags:

- Search queries like "React performance" match entries tagged with `react`, `performance`, `optimization`
- Short tag text produces more focused, discriminative embeddings
- The `nomic-embed-text` model performs well on concise tag text for discriminative embeddings

### Embedding Generation

**File:** `packages/embeddings/src/client.ts`

```
Input: tags array → join with space → "react performance hooks"
POST http://localhost:11434/api/embeddings
Body: { model: "nomic-embed-text", prompt: "react performance hooks" }
Response: { embedding: [0.012, -0.045, ...] }  // 768 floats
```

## File Location

| Item | Path |
|------|------|
| Database file | `~/.cognistore/knowledge.db` |
| WAL file | `~/.cognistore/knowledge.db-wal` |
| SHM file | `~/.cognistore/knowledge.db-shm` |

The parent directory `~/.cognistore/` is created automatically by `createDbClient()` if it doesn't exist.
