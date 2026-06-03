import { test, expect } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, mkdirSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sqliteVec = require('sqlite-vec');
import { createDbClient } from '@cognistore/core';
import { runMigrations } from '@cognistore/core';

function tmpDbPath(): string {
  return join(tmpdir(), `cognistore-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + '-wal'); } catch {}
  try { unlinkSync(dbPath + '-shm'); } catch {}
}

function tableExists(sqlite: BetterSqlite3.Database, name: string): boolean {
  const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return row !== undefined;
}

function getSchemaVersions(sqlite: BetterSqlite3.Database): string[] {
  if (!tableExists(sqlite, 'schema_version')) return [];
  return (sqlite.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: string }[])
    .map((r) => r.version);
}

/**
 * Simulate a v0.8.0 database by creating only the base tables
 * (what existed before the migration system was introduced).
 */
function createV080Database(dbPath: string): void {
  const sqlite = new BetterSqlite3(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE knowledge_entries (
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
    CREATE INDEX idx_type ON knowledge_entries(type);
    CREATE INDEX idx_scope ON knowledge_entries(scope);

    CREATE TABLE operations_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL CHECK(operation IN ('read', 'write')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_ops_created_at ON operations_log(created_at);
    CREATE INDEX idx_ops_operation ON operations_log(operation);
  `);

  sqlite.close();
}

test.describe('Migration system', () => {
  test('fresh DB creates schema_version with 0.8.0 and 0.9.0', () => {
    const dbPath = tmpDbPath();
    try {
      const { sqlite } = createDbClient(dbPath);

      const versions = getSchemaVersions(sqlite);
      expect(versions).toContain('0.8.0');
      expect(versions).toContain('0.9.0');
      expect(versions).toContain('2.1.0');

      sqlite.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('fresh DB has all required tables', () => {
    const dbPath = tmpDbPath();
    try {
      const { sqlite } = createDbClient(dbPath);

      expect(tableExists(sqlite, 'knowledge_entries')).toBe(true);
      expect(tableExists(sqlite, 'plans')).toBe(true);
      expect(tableExists(sqlite, 'plan_tasks')).toBe(true);
      expect(tableExists(sqlite, 'plan_relations')).toBe(true);
      expect(tableExists(sqlite, 'operations_log')).toBe(true);
      expect(tableExists(sqlite, 'schema_version')).toBe(true);
      expect(tableExists(sqlite, 'knowledge_fts')).toBe(true);

      sqlite.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('existing v0.8.0 DB gains the knowledge_fts table after upgrade', () => {
    const dbPath = tmpDbPath();
    try {
      createV080Database(dbPath);
      expect(tableExists(new BetterSqlite3(dbPath), 'knowledge_fts')).toBe(false);

      const { sqlite } = createDbClient(dbPath);
      expect(getSchemaVersions(sqlite)).toContain('2.1.0');
      expect(tableExists(sqlite, 'knowledge_fts')).toBe(true);

      sqlite.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('existing v0.8.0 DB gets 0.9.0 migration applied', () => {
    const dbPath = tmpDbPath();
    try {
      // Step 1: Create a v0.8.0-era database (no schema_version table)
      createV080Database(dbPath);

      // Step 2: Run createDbClient which should detect existing DB and apply migrations
      const { sqlite } = createDbClient(dbPath);

      // Should have bootstrapped as 0.8.0 and then applied 0.9.0
      const versions = getSchemaVersions(sqlite);
      expect(versions).toContain('0.8.0');
      expect(versions).toContain('0.9.0');

      // v0.9.0 tables should now exist
      expect(tableExists(sqlite, 'plans')).toBe(true);
      expect(tableExists(sqlite, 'plan_tasks')).toBe(true);
      expect(tableExists(sqlite, 'plan_relations')).toBe(true);

      // The title column should exist on knowledge_entries
      const columns = sqlite
        .prepare("PRAGMA table_info('knowledge_entries')")
        .all() as { name: string }[];
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain('title');

      sqlite.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('embedded migrations work when .sql files do not exist (bundled mode)', () => {
    const dbPath = tmpDbPath();
    try {
      // Create DB manually with sqlite-vec loaded but NO migration files
      mkdirSync(join(tmpdir(), 'nonexistent-dir-test'), { recursive: true });
      const sqlite = new BetterSqlite3(dbPath);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      sqliteVec.load(sqlite);

      // Run migrations with a nonexistent directory — should use embedded SQL
      const fakeDir = join(tmpdir(), `nonexistent-migrations-${Date.now()}`);
      runMigrations(sqlite, fakeDir);

      // All tables should exist from embedded migrations
      expect(tableExists(sqlite, 'knowledge_entries')).toBe(true);
      expect(tableExists(sqlite, 'plans')).toBe(true);
      expect(tableExists(sqlite, 'plan_tasks')).toBe(true);
      expect(tableExists(sqlite, 'plan_relations')).toBe(true);
      expect(tableExists(sqlite, 'operations_log')).toBe(true);

      const versions = getSchemaVersions(sqlite);
      expect(versions).toContain('0.8.0');
      expect(versions).toContain('0.9.0');

      sqlite.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('re-running createDbClient is idempotent', () => {
    const dbPath = tmpDbPath();
    try {
      // First run
      const { sqlite: sqlite1 } = createDbClient(dbPath);
      const versions1 = getSchemaVersions(sqlite1);
      sqlite1.close();

      // Second run on the same DB — should not throw
      const { sqlite: sqlite2 } = createDbClient(dbPath);
      const versions2 = getSchemaVersions(sqlite2);

      expect(versions2).toEqual(versions1);

      // All tables still present
      expect(tableExists(sqlite2, 'knowledge_entries')).toBe(true);
      expect(tableExists(sqlite2, 'plans')).toBe(true);
      expect(tableExists(sqlite2, 'plan_tasks')).toBe(true);
      expect(tableExists(sqlite2, 'plan_relations')).toBe(true);
      expect(tableExists(sqlite2, 'operations_log')).toBe(true);

      sqlite2.close();
    } finally {
      cleanupDb(dbPath);
    }
  });
});
