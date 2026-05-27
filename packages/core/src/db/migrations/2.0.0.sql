-- v2.0.0: Ensure token_usage and scan_state exist for upgrades from old .deb installs.
-- Pre-2.0 builds shipped a 1.3.0 migration that created `consumption_samples` /
-- `consumption_ingest_state` instead. Those users have 1.3.0 recorded in
-- schema_version so the real tables were never created, causing "no such table:
-- scan_state" errors. IF NOT EXISTS makes this idempotent on fresh installs too.

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
