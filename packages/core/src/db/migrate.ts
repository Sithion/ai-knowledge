import type BetterSqlite3 from 'better-sqlite3';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Embedded migrations — used when .sql files are not available (e.g., bundled MCP server).
 * These MUST be kept in sync with the .sql files in the migrations/ directory.
 */
export const EMBEDDED_MIGRATIONS: Record<string, string> = {
  '0.8.0': `
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  confidence_score REAL NOT NULL DEFAULT 1.0,
  related_ids TEXT,
  agent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_type ON knowledge_entries(type);
CREATE INDEX IF NOT EXISTS idx_scope ON knowledge_entries(scope);

CREATE TABLE IF NOT EXISTS operations_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL CHECK(operation IN ('read', 'write')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_created_at ON operations_log(created_at);
CREATE INDEX IF NOT EXISTS idx_ops_operation ON operations_log(operation);
`,
  '0.9.0': `
ALTER TABLE knowledge_entries ADD COLUMN title TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'completed', 'archived')),
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
CREATE INDEX IF NOT EXISTS idx_plans_scope ON plans(scope);

CREATE TABLE IF NOT EXISTS plan_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  knowledge_id TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('input', 'output')),
  created_at TEXT NOT NULL,
  UNIQUE(plan_id, knowledge_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_plan_relations_plan ON plan_relations(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_relations_knowledge ON plan_relations(knowledge_id);

CREATE TABLE IF NOT EXISTS plan_tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
  notes TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan ON plan_tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_status ON plan_tasks(status);
`,
  '1.3.0': `
CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  project TEXT,
  session_id TEXT,
  message_id TEXT,
  occurred_at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_occurred ON token_usage (occurred_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_project ON token_usage (project);
CREATE INDEX IF NOT EXISTS idx_token_usage_source_model ON token_usage (source, model);

CREATE TABLE IF NOT EXISTS scan_state (
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  last_offset INTEGER NOT NULL DEFAULT 0,
  last_mtime TEXT NOT NULL,
  last_scanned_at TEXT NOT NULL,
  PRIMARY KEY (source, file_path)
);
`,
  // v2.0.0: Re-creates token_usage + scan_state for users whose old .deb recorded
  // 1.3.0 in schema_version but had consumption_samples/consumption_ingest_state
  // instead. IF NOT EXISTS makes this idempotent on fresh installs.
  '2.0.0': `
CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  project TEXT,
  session_id TEXT,
  message_id TEXT,
  occurred_at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_occurred ON token_usage (occurred_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_project ON token_usage (project);
CREATE INDEX IF NOT EXISTS idx_token_usage_source_model ON token_usage (source, model);

CREATE TABLE IF NOT EXISTS scan_state (
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  last_offset INTEGER NOT NULL DEFAULT 0,
  last_mtime TEXT NOT NULL,
  last_scanned_at TEXT NOT NULL,
  PRIMARY KEY (source, file_path)
);

ALTER TABLE plans ADD COLUMN plan_file_path TEXT;
`,
  '2.1.0': `
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id UNINDEXED, title, content, tags);
`,
  // v2.3.0: provenance tracking — platform (auto) + agent_id (caller) on entries and plans.
  // knowledge_entries.agent_id already exists since 0.8.0; only platform is new there.
  '2.3.0': `
ALTER TABLE knowledge_entries ADD COLUMN platform TEXT;
ALTER TABLE plans ADD COLUMN agent_id TEXT;
ALTER TABLE plans ADD COLUMN platform TEXT;
CREATE INDEX IF NOT EXISTS idx_knowledge_platform ON knowledge_entries(platform);
CREATE INDEX IF NOT EXISTS idx_plans_platform ON plans(platform);
CREATE INDEX IF NOT EXISTS idx_plans_agent ON plans(agent_id);
`,
  // v2.3.2: permanent, never-pruned daily rollup for the Activity chart, so
  // pruning operations_log can no longer erase chart history. Backfill from the
  // raw rows that still survive. MUST stay in sync with migrations/2.3.2.sql.
  '2.3.2': `
CREATE TABLE IF NOT EXISTS operations_daily (
  date   TEXT PRIMARY KEY,
  reads  INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO operations_daily (date, reads, writes)
  SELECT date(created_at),
         SUM(CASE WHEN operation = 'read'  THEN 1 ELSE 0 END),
         SUM(CASE WHEN operation = 'write' THEN 1 ELSE 0 END)
  FROM operations_log
  WHERE date(created_at) IS NOT NULL
  GROUP BY date(created_at)
  ON CONFLICT(date) DO UPDATE SET reads = excluded.reads, writes = excluded.writes;
`,
  // v2.4.0: per-entry read tracking + the 10-day cleanup report queue.
  // The STATEMENTS here must stay identical to migrations/2.4.0.sql (comments
  // may differ) — the sidecar runs the .sql files and the bundled MCP server
  // runs this copy, so a drift means two different schemas on one machine.
  // Enforced by the migration-parity test in packages/tests.
  //
  // PARSER CONTRACT (see step 5 below): only whole lines starting with two
  // dashes are stripped, then the rest is split on the semicolon character.
  // Never put a semicolon inside a comment or string literal here, and never
  // append a trailing comment to a statement line — either splits a statement
  // in half and aborts DB open for the sidecar AND every MCP server process.
  '2.4.0': `
ALTER TABLE knowledge_entries ADD COLUMN last_read_at TEXT;
ALTER TABLE knowledge_entries ADD COLUMN read_count INTEGER NOT NULL DEFAULT 0;

-- Fairness backfill: there is no historical read data to mine, so the unread
-- clock starts now for every pre-existing entry.
UPDATE knowledge_entries SET last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE last_read_at IS NULL;

-- Domain facts owned by the cleanup feature. Deliberately NOT schema_version.
CREATE TABLE IF NOT EXISTS cleanup_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO cleanup_meta (key, value) VALUES ('read_tracking_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- status: open or closed
CREATE TABLE IF NOT EXISTS cleanup_reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  stats TEXT NOT NULL DEFAULT '{}'
);

-- At most one open report at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cleanup_reports_open ON cleanup_reports(status) WHERE status = 'open';

-- category: deprecated, unread or duplicate_group
-- entry_ids: JSON array. For duplicate_group the canonical id comes first.
-- status: pending, applying, dismissed, applied or failed
CREATE TABLE IF NOT EXISTS cleanup_candidates (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES cleanup_reports(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  entry_ids TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  resolution TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cleanup_candidates_report ON cleanup_candidates(report_id, status);
`,
};

/**
 * Versioned migration runner for SQLite.
 * Uses .sql files from disk when available, falls back to embedded SQL.
 */
export function runMigrations(sqlite: BetterSqlite3.Database, migrationsDir: string): void {
  // 1. Ensure schema_version table exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  // 2. Get already-applied versions
  const applied = new Set(
    (sqlite.prepare('SELECT version FROM schema_version').all() as { version: string }[])
      .map((r) => r.version)
  );

  // 3. Bootstrap: detect existing DB from pre-migration era
  if (applied.size === 0) {
    const tableExists = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_entries'")
      .get();

    if (tableExists) {
      sqlite
        .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run('0.8.0', new Date().toISOString());
      applied.add('0.8.0');
      console.error('Migration: bootstrapped existing DB as v0.8.0');
    }
  }

  // 4. Build migration list — from disk files or embedded
  let migrations: { version: string; sql: string }[];

  if (existsSync(migrationsDir)) {
    // Disk-based: read .sql files (used by dashboard sidecar)
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => compareSemver(a.replace('.sql', ''), b.replace('.sql', '')));

    migrations = files.map((f) => ({
      version: f.replace('.sql', ''),
      sql: readFileSync(resolve(migrationsDir, f), 'utf-8'),
    }));
  } else {
    // Embedded: used when bundled (MCP server via npx)
    migrations = Object.entries(EMBEDDED_MIGRATIONS)
      .map(([version, sql]) => ({ version, sql }))
      .sort((a, b) => compareSemver(a.version, b.version));
    console.error('Migration: using embedded migrations (bundled mode)');
  }

  // 5. Apply pending migrations
  for (const { version, sql } of migrations) {
    if (applied.has(version)) continue;

    const cleanedSql = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const statements = cleanedSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      try {
        sqlite.exec(stmt + ';');
      } catch (err: any) {
        if (err?.message?.includes('duplicate column')) continue;
        if (err?.message?.includes('already exists')) continue;
        throw err;
      }
    }

    sqlite
      .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(version, new Date().toISOString());
    console.error(`Migration: ${version} applied`);
  }
}

/** Run seed files (only on fresh install) */
export function runSeeds(sqlite: BetterSqlite3.Database, seedsDir: string, isFreshInstall: boolean): void {
  if (!isFreshInstall) return;
  if (!existsSync(seedsDir)) return;

  const files = readdirSync(seedsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sqlPath = resolve(seedsDir, file);
    const sqlContent = readFileSync(sqlPath, 'utf-8');
    sqlite.exec(sqlContent);
    console.error(`Seed: ${file} applied`);
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}
