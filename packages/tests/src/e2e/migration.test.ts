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
      expect(tableExists(sqlite, 'operations_daily')).toBe(true);
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
      expect(tableExists(sqlite, 'operations_daily')).toBe(true);

      const versions = getSchemaVersions(sqlite);
      expect(versions).toContain('0.8.0');
      expect(versions).toContain('0.9.0');

      sqlite.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('v2.3.2 backfills operations_daily from surviving operations_log rows (embedded/bundled mode + idempotent)', () => {
    const dbPath = tmpDbPath();
    try {
      const sqlite = new BetterSqlite3(dbPath);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      sqliteVec.load(sqlite);
      const fakeDir = join(tmpdir(), `nonexistent-migrations-${Date.now()}-${Math.random().toString(36).slice(2)}`);

      // Apply all embedded migrations (operations_daily created, empty), then
      // simulate a pre-2.3.2 DB that already holds raw operations_log history by
      // dropping the rollup + un-recording 2.3.2 and seeding raw rows.
      runMigrations(sqlite, fakeDir);
      sqlite.exec('DROP TABLE IF EXISTS operations_daily');
      sqlite.prepare('DELETE FROM schema_version WHERE version = ?').run('2.3.2');

      const day = '2026-06-03';
      const ins = sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)');
      for (let i = 0; i < 273; i++) ins.run('read', `${day}T10:00:00.000Z`);
      for (let i = 0; i < 32; i++) ins.run('write', `${day}T10:00:00.000Z`);

      // Re-apply 2.3.2 → recreates + backfills the rollup from the raw rows.
      runMigrations(sqlite, fakeDir);
      expect(tableExists(sqlite, 'operations_daily')).toBe(true);
      const row = sqlite.prepare('SELECT reads, writes FROM operations_daily WHERE date = ?').get(day) as { reads: number; writes: number };
      expect(row.reads).toBe(273);
      expect(row.writes).toBe(32);

      // Idempotent: re-running the migration keeps counts stable (ON CONFLICT).
      sqlite.prepare('DELETE FROM schema_version WHERE version = ?').run('2.3.2');
      runMigrations(sqlite, fakeDir);
      const again = sqlite.prepare('SELECT reads, writes FROM operations_daily WHERE date = ?').get(day) as { reads: number; writes: number };
      expect(again.reads).toBe(273);
      expect(again.writes).toBe(32);

      sqlite.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('v2.3.0 adds provenance columns (platform on entries; agent_id+platform on plans)', () => {
    const dbPath = tmpDbPath();
    try {
      const { sqlite } = createDbClient(dbPath);
      const cols = (table: string) =>
        (sqlite.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);

      expect(getSchemaVersions(sqlite)).toContain('2.3.0');
      expect(cols('knowledge_entries')).toContain('platform');
      expect(cols('plans')).toContain('agent_id');
      expect(cols('plans')).toContain('platform');
      sqlite.close();
    } finally {
      cleanupDb(dbPath);
    }
  });

  test('v2.3.0 provenance columns also apply via embedded migrations (bundled mode)', () => {
    const dbPath = tmpDbPath();
    try {
      const sqlite = new BetterSqlite3(dbPath);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      sqliteVec.load(sqlite);

      const fakeDir = join(tmpdir(), `nonexistent-migrations-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      runMigrations(sqlite, fakeDir);

      const cols = (table: string) =>
        (sqlite.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);

      expect(getSchemaVersions(sqlite)).toContain('2.3.0');
      expect(cols('knowledge_entries')).toContain('platform');
      expect(cols('plans')).toContain('agent_id');
      expect(cols('plans')).toContain('platform');
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
      expect(tableExists(sqlite2, 'operations_daily')).toBe(true);

      sqlite2.close();
    } finally {
      cleanupDb(dbPath);
    }
  });
});
