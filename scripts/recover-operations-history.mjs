#!/usr/bin/env node
// Restore lost Activity-chart history from a pre-prune backup of knowledge.db.
//
// Context: before v2.3.2 the dashboard Activity chart aggregated the raw
// operations_log table, which is hard-DELETE-pruned. Days pruned before v2.3.2
// are gone from the live DB and can only be recovered from a backup taken while
// those rows still existed (e.g. a macOS Time Machine snapshot of ~/.cognistore).
//
// This script reads such a backup READ-ONLY, aggregates its operations_log into
// per-day read/write counts, and MAX-merges them into the live operations_daily
// rollup — the permanent, never-pruned table the chart now reads. It never
// writes to the backup and never touches the live raw operations_log. MAX-merge
// means it can only ever RAISE a day's count, so re-running is safe and an older
// partial backup can never clobber a higher live value.
//
// Usage:
//   node scripts/recover-operations-history.mjs <backup.db> [liveDb] [--dry-run]
//
//   <backup.db>  Path to the pre-prune knowledge.db backup (required).
//   [liveDb]     Live DB to restore into. Default: ~/.cognistore/knowledge.db
//   --dry-run    Print what would change without writing.
//
// Only point this at your OWN backups.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
// Resolve better-sqlite3 from the workspace (pnpm-hoisted under packages/core).
const require = createRequire(join(here, '..', 'packages', 'core', 'noop.js'));
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter((a) => !a.startsWith('--'));
const backupPath = positional[0];
const livePath = positional[1] || join(homedir(), '.cognistore', 'knowledge.db');

if (!backupPath) {
  console.error('Usage: node scripts/recover-operations-history.mjs <backup.db> [liveDb] [--dry-run]');
  process.exit(1);
}
const backupAbs = resolve(backupPath);
const liveAbs = resolve(livePath);
if (!existsSync(backupAbs)) { console.error(`Backup not found: ${backupAbs}`); process.exit(1); }
if (!existsSync(liveAbs)) { console.error(`Live DB not found: ${liveAbs}`); process.exit(1); }
if (backupAbs === liveAbs) { console.error('Backup and live DB are the same file — refusing.'); process.exit(1); }

// 1. Read the backup on its OWN read-only connection. Never exec() anything
//    derived from the backup; our SELECT is a fixed literal.
const backup = new Database(backupAbs, { readonly: true, fileMustExist: true });
let daily;
try {
  const hasLog = backup
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operations_log'")
    .get();
  if (!hasLog) { console.error('Backup has no operations_log table — nothing to recover.'); process.exit(1); }
  daily = backup.prepare(
    `SELECT date(created_at) AS date,
            SUM(CASE WHEN operation = 'read'  THEN 1 ELSE 0 END) AS reads,
            SUM(CASE WHEN operation = 'write' THEN 1 ELSE 0 END) AS writes
     FROM operations_log
     WHERE date(created_at) IS NOT NULL
     GROUP BY date(created_at)
     ORDER BY date(created_at)`
  ).all();
} finally {
  backup.close();
}

console.log(`Backup ${backupAbs}: ${daily.length} day(s) of operations history found.`);
if (daily.length === 0) process.exit(0);

if (dryRun) {
  for (const d of daily) console.log(`  ${d.date}  reads=${d.reads}  writes=${d.writes}`);
  console.log('\n--dry-run: no changes written.');
  process.exit(0);
}

// 2. MAX-merge into the live operations_daily. Never touches the live raw log.
const live = new Database(liveAbs);
try {
  const hasRollup = live
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operations_daily'")
    .get();
  if (!hasRollup) {
    console.error('Live DB has no operations_daily table — run the app once (v2.3.2+) so the migration creates it, then retry.');
    process.exit(1);
  }
  const upsert = live.prepare(
    `INSERT INTO operations_daily (date, reads, writes) VALUES (@date, @reads, @writes)
     ON CONFLICT(date) DO UPDATE SET
       reads  = MAX(reads,  excluded.reads),
       writes = MAX(writes, excluded.writes)`
  );
  const tx = live.transaction((rows) => { for (const r of rows) upsert.run(r); });
  tx(daily);
  console.log(`Merged ${daily.length} day(s) into operations_daily (MAX-merge) in ${liveAbs}.`);
} finally {
  live.close();
}
