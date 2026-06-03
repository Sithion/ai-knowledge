import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { DEFAULT_SQLITE_PATH, DEFAULT_EMBEDDING_DIMENSIONS } from '@cognistore/shared';
import * as schema from './schema/index.js';
import { createEmbeddingsTable } from './schema/sqlite-vec.js';
import { createKnowledgeFtsTable, ftsCount, insertFts } from './schema/fts.js';
import { runMigrations, runSeeds } from './migrate.js';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolvePath(path: string): string {
  if (path.startsWith('~')) {
    return path.replace('~', homedir());
  }
  return path;
}

export type Database = BetterSQLite3Database<typeof schema>;
export type SQLiteDatabase = BetterSqlite3.Database;

export function createDbClient(dbPath?: string): { db: Database; sqlite: SQLiteDatabase } {
  const resolvedPath = resolvePath(dbPath ?? process.env.SQLITE_PATH ?? DEFAULT_SQLITE_PATH);

  // Ensure parent directory exists
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const sqlite = new BetterSqlite3(resolvedPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');

  // Load sqlite-vec extension
  sqliteVec.load(sqlite);

  // Check if this is a fresh install (no schema_version table yet, no knowledge_entries)
  const hasSchemaVersion = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
  const hasKnowledgeEntries = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_entries'").get();
  const isFreshInstall = !hasSchemaVersion && !hasKnowledgeEntries;

  // Run versioned migrations
  const migrationsDir = resolve(__dirname, 'migrations');
  const seedsDir = resolve(__dirname, 'seeds');
  runMigrations(sqlite, migrationsDir);
  runSeeds(sqlite, seedsDir, isFreshInstall);

  // Ensure sqlite-vec virtual tables (always idempotent)
  const dims = Number(process.env.EMBEDDING_DIMENSIONS) || DEFAULT_EMBEDDING_DIMENSIONS;
  createEmbeddingsTable(sqlite, dims);
  createPlansEmbeddingsTable(sqlite, dims);

  // Ensure the FTS5 index exists (idempotent) and backfill it once if empty but
  // entries already exist (e.g. existing DB upgrading to the FTS migration).
  // Also ensure created_at indexes for fast ORDER BY created_at DESC LIMIT/OFFSET
  // (browse/infinite-scroll). All idempotent + best-effort — never block launch.
  try {
    createKnowledgeFtsTable(sqlite);
    backfillFtsIfEmpty(sqlite);
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_created_at ON knowledge_entries(created_at)');
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_plans_created_at ON plans(created_at)');
  } catch {
    // FTS / indexes are optional optimizations — degrade gracefully if unavailable.
  }

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

function backfillFtsIfEmpty(sqlite: BetterSqlite3.Database): void {
  if (ftsCount(sqlite) > 0) return;
  const rows = sqlite
    .prepare("SELECT id, title, content, tags FROM knowledge_entries WHERE type != 'system'")
    .all() as { id: string; title: string; content: string; tags: string }[];
  for (const r of rows) {
    let tags = '';
    try {
      const parsed = JSON.parse(r.tags ?? '[]');
      tags = Array.isArray(parsed) ? parsed.filter(Boolean).join(' ') : '';
    } catch { tags = ''; }
    try { insertFts(sqlite, { id: r.id, title: r.title ?? '', content: r.content ?? '', tags }); } catch { /* best-effort */ }
  }
}

function createPlansEmbeddingsTable(sqlite: BetterSqlite3.Database, dimensions = DEFAULT_EMBEDDING_DIMENSIONS): void {
  try {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS plans_embeddings USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${dimensions}] distance_metric=cosine
      );
    `);
  } catch {
    // Table already exists
  }
}
