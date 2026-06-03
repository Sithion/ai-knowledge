-- v2.1.0: FTS5 full-text index over knowledge for hybrid (semantic + keyword/BM25) search.
-- Backfill of existing rows happens at startup in db/client.ts (covers disk + embedded paths).
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id UNINDEXED, title, content, tags);
