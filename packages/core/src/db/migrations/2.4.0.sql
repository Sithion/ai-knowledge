-- v2.4.0: per-entry read tracking + the 10-day cleanup report queue.
-- The STATEMENTS here must stay identical to EMBEDDED_MIGRATIONS['2.4.0'] in
-- migrate.ts (comments may differ): the sidecar runs this file, the bundled MCP
-- server runs the embedded copy. Enforced by the migration-parity test.
--
-- PARSER CONTRACT (migrate.ts:232-239): the runner strips only whole lines
-- whose trimmed text starts with two dashes, then splits the rest on the
-- semicolon character. Never put a semicolon inside a comment or a string
-- literal in this file, and never append a trailing comment to a statement
-- line: either mistake splits a statement in half and aborts DB open for the
-- sidecar AND every MCP server process.

ALTER TABLE knowledge_entries ADD COLUMN last_read_at TEXT;
ALTER TABLE knowledge_entries ADD COLUMN read_count INTEGER NOT NULL DEFAULT 0;

-- Fairness backfill: there is no historical read data to mine, so the unread
-- clock starts now for every pre-existing entry. Without this, every entry
-- older than the unread window would be flagged the moment the feature ships.
UPDATE knowledge_entries SET last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE last_read_at IS NULL;

-- Domain facts owned by the cleanup feature. Deliberately NOT schema_version:
-- that table is migration bookkeeping, and reading it as a business fact breaks
-- the day migrations are squashed or re-stamped.
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

-- At most one open report at a time. Two concurrent generators race into a
-- constraint error instead of two competing reports.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cleanup_reports_open ON cleanup_reports(status) WHERE status = 'open';

-- category: deprecated, unread or duplicate_group
-- entry_ids: JSON array. For duplicate_group the canonical id comes first.
-- payload: JSON display data captured at generation time.
-- status: pending, applying, dismissed, applied or failed
-- resolution: JSON. Written at claim time with the pre-delete snapshot, then
-- updated with the outcome.
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
