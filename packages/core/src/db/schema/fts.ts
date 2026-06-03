import type Database from 'better-sqlite3';

const FTS_TABLE_NAME = 'knowledge_fts';

/**
 * FTS5 full-text index over knowledge entries, used for the keyword/BM25 half of
 * hybrid search. `id` is UNINDEXED (stored for joins, not searched). Mirrors the
 * create-if-not-exists pattern used by the sqlite-vec virtual tables.
 */
export function createKnowledgeFtsTable(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE_NAME} USING fts5(
      id UNINDEXED,
      title,
      content,
      tags
    )
  `);
}

export interface FtsRow {
  id: string;
  title: string;
  content: string;
  tags: string;
}

export function insertFts(sqlite: Database.Database, row: FtsRow) {
  sqlite
    .prepare(`INSERT INTO ${FTS_TABLE_NAME}(id, title, content, tags) VALUES (?, ?, ?, ?)`)
    .run(row.id, row.title ?? '', row.content ?? '', row.tags ?? '');
}

/** FTS5 has no UPDATE-by-key semantics for contentless tables, so delete + insert. */
export function updateFts(sqlite: Database.Database, row: FtsRow) {
  deleteFts(sqlite, row.id);
  insertFts(sqlite, row);
}

export function deleteFts(sqlite: Database.Database, id: string) {
  sqlite.prepare(`DELETE FROM ${FTS_TABLE_NAME} WHERE id = ?`).run(id);
}

/** Number of rows currently indexed — used to decide whether a backfill is needed. */
export function ftsCount(sqlite: Database.Database): number {
  const row = sqlite.prepare(`SELECT count(*) AS c FROM ${FTS_TABLE_NAME}`).get() as { c: number };
  return row?.c ?? 0;
}

export interface FtsResult {
  id: string;
  bm25: number;
}

/**
 * Sanitize arbitrary user text into a safe FTS5 MATCH query. A bound string is
 * still PARSED as an FTS5 query, so punctuation/operators (`" * : ^ ( ) - AND OR
 * NEAR`) would throw `fts5: syntax error`. Tokenize on whitespace and wrap each
 * token as a quoted phrase literal (doubling embedded quotes). Returns '' when
 * there is nothing searchable.
 */
export function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/**
 * Keyword search via FTS5/BM25. Returns rows with their raw bm25 score (SQLite's
 * bm25(): more-negative = better). Returns [] for an empty/blank query.
 */
export function searchFts(sqlite: Database.Database, query: string, k: number): FtsResult[] {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  const stmt = sqlite.prepare(`
    SELECT id, bm25(${FTS_TABLE_NAME}) AS bm25
    FROM ${FTS_TABLE_NAME}
    WHERE ${FTS_TABLE_NAME} MATCH ?
    ORDER BY bm25
    LIMIT ?
  `);
  return stmt.all(match, k) as FtsResult[];
}
