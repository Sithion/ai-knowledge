-- v1.3.0: Token usage tracking for AI coding tools (Claude Code, etc.)

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
