import { test, expect } from '@playwright/test';
import { createTestContext, destroyTestContext, createFactory, type TestContext } from '../test-helpers.js';

let ctx: TestContext;
let factory: ReturnType<typeof createFactory>;

test.beforeAll(() => {
  ctx = createTestContext();
  factory = createFactory(ctx.service);
});
test.afterAll(() => {
  destroyTestContext(ctx);
});

test('search logs a read operation', async () => {
  const countsBefore = ctx.service.getOperationCounts();

  await ctx.service.search('read operation test query');

  const countsAfter = ctx.service.getOperationCounts();
  expect(countsAfter.readsLastHour).toBe(countsBefore.readsLastHour + 1);
});

test('add logs a write operation', async () => {
  const countsBefore = ctx.service.getOperationCounts();

  await factory.knowledge({ content: 'Write operation test entry' });

  const countsAfter = ctx.service.getOperationCounts();
  expect(countsAfter.writesLastHour).toBe(countsBefore.writesLastHour + 1);
});

test('update logs a write operation', async () => {
  const entry = await factory.knowledge({ content: 'Update operation test entry' });
  const countsBefore = ctx.service.getOperationCounts();

  await ctx.service.update(entry.id, { content: 'Updated content for op test' });

  const countsAfter = ctx.service.getOperationCounts();
  expect(countsAfter.writesLastHour).toBe(countsBefore.writesLastHour + 1);
});

test('delete logs a write operation', async () => {
  const entry = await factory.knowledge({ content: 'Delete operation test entry' });
  const countsBefore = ctx.service.getOperationCounts();

  await ctx.service.delete(entry.id);

  const countsAfter = ctx.service.getOperationCounts();
  expect(countsAfter.writesLastHour).toBe(countsBefore.writesLastHour + 1);
});

test('getOperationCounts returns correct counts', async () => {
  const counts = ctx.service.getOperationCounts();

  expect(typeof counts.readsLastHour).toBe('number');
  expect(typeof counts.readsLastDay).toBe('number');
  expect(typeof counts.writesLastHour).toBe('number');
  expect(typeof counts.writesLastDay).toBe('number');
  expect(counts.readsLastHour).toBeGreaterThanOrEqual(0);
  expect(counts.readsLastDay).toBeGreaterThanOrEqual(counts.readsLastHour);
  expect(counts.writesLastDay).toBeGreaterThanOrEqual(counts.writesLastHour);
});

test('cleanupOldOperations removes entries older than the 800-day retention', () => {
  // Retention is 800 days: the '2y' (730-day) dashboard window + ~70-day
  // margin. See OPERATIONS_RETENTION_DAYS in packages/core knowledge.repository.ts.
  const DAY = 24 * 60 * 60 * 1000;
  const oldDate = new Date(Date.now() - 801 * DAY).toISOString();
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('read', oldDate);
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('write', oldDate);
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('read', oldDate);

  // ~400 days old: INSIDE the new window but far outside the old 30-day one —
  // must survive, locking in the raised retention.
  const survivorDate = new Date(Date.now() - 400 * DAY).toISOString();
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('read', survivorDate);

  const totalBefore = (ctx.sqlite.prepare('SELECT COUNT(*) as count FROM operations_log').get() as { count: number }).count;
  const removed = ctx.service.cleanupOldOperations();
  expect(removed).toBeGreaterThanOrEqual(3);

  const totalAfter = (ctx.sqlite.prepare('SELECT COUNT(*) as count FROM operations_log').get() as { count: number }).count;
  expect(totalAfter).toBe(totalBefore - removed);

  const olderThanRetention = (ctx.sqlite.prepare(
    'SELECT COUNT(*) as count FROM operations_log WHERE created_at < ?'
  ).get(new Date(Date.now() - 800 * DAY).toISOString()) as { count: number }).count;
  expect(olderThanRetention).toBe(0);

  const survivor = (ctx.sqlite.prepare(
    'SELECT COUNT(*) as count FROM operations_log WHERE created_at = ?'
  ).get(survivorDate) as { count: number }).count;
  expect(survivor).toBe(1);
});

// Seed a day directly into the permanent rollup, as the migration backfill and
// the live logOperation upsert both do. The chart reads operations_daily, NOT
// the prunable raw operations_log.
function seedDaily(date: string, reads: number, writes: number) {
  ctx.sqlite.prepare(
    `INSERT INTO operations_daily (date, reads, writes) VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET reads = excluded.reads, writes = excluded.writes`
  ).run(date, reads, writes);
}

test('getOperationsByDay(730) returns 730 zero-filled buckets from the rollup', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const d400 = new Date(Date.now() - 400 * DAY).toISOString().split('T')[0];
  seedDaily(d400, 12, 7);

  const buckets = ctx.service.getOperationsByDay(730);
  expect(buckets.length).toBe(730); // exactly `days` buckets — no DST off-by-one

  const bucket = buckets.find((b) => b.date === d400);
  expect(bucket).toBeDefined();
  expect(bucket!.reads).toBe(12);
  expect(bucket!.writes).toBe(7);

  for (const b of buckets) {
    expect(typeof b.reads).toBe('number');
    expect(typeof b.writes).toBe('number');
  }
});

test('operations_daily stays in lock-step with the raw operations_log for the day', async () => {
  const today = new Date().toISOString().slice(0, 10);

  // Drive real read + write ops through the service (search logs reads =
  // result count; add logs a write plus an internal dedup read).
  await ctx.service.search('rollup mirror read query');
  await factory.knowledge({ content: 'rollup mirror write entry' });

  const daily =
    (ctx.sqlite.prepare('SELECT reads, writes FROM operations_daily WHERE date = ?').get(today) as
      | { reads: number; writes: number }
      | undefined) ?? { reads: 0, writes: 0 };
  const raw = ctx.sqlite.prepare(
    `SELECT SUM(CASE WHEN operation = 'read'  THEN 1 ELSE 0 END) AS reads,
            SUM(CASE WHEN operation = 'write' THEN 1 ELSE 0 END) AS writes
     FROM operations_log WHERE date(created_at) = ?`
  ).get(today) as { reads: number; writes: number };

  // The rollup is upserted in the same transaction as every raw insert, so the
  // two must agree exactly for a day that only received live (non-seeded) ops.
  expect(daily.reads).toBe(raw.reads);
  expect(daily.writes).toBe(raw.writes);
  expect(daily.reads).toBeGreaterThan(0);
  expect(daily.writes).toBeGreaterThan(0);
});

test('getOperationsByDay survives a hard prune of the raw operations_log (regression)', () => {
  // This is the whole point of the rollup: a day whose raw rows are DELETE-pruned
  // must still render its historical counts, not silently drop to 0.
  const DAY = 24 * 60 * 60 * 1000;
  const oldDay = new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10);
  seedDaily(oldDay, 273, 32);

  ctx.service.cleanupOldOperations(); // hard-DELETEs old raw rows

  const bucket = ctx.service.getOperationsByDay(730).find((b) => b.date === oldDay);
  expect(bucket).toBeDefined();
  expect(bucket!.reads).toBe(273);
  expect(bucket!.writes).toBe(32);
});

test('reconcileOperationsDaily MAX-merges raw counts, never reducing the rollup', () => {
  const DAY = 24 * 60 * 60 * 1000;

  // Day A: rollup already accumulated a HIGHER value than the (partially-pruned)
  // raw log holds — reconcile must keep the rollup, not overwrite it downward.
  const dayA = new Date(Date.now() - 10 * DAY);
  const dayAStr = dayA.toISOString().slice(0, 10);
  seedDaily(dayAStr, 100, 5);
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('read', dayA.toISOString());

  // Day B: raw rows exist but the rollup is missing them (stale/other-process
  // writer) — reconcile must heal the gap by adding them.
  const dayB = new Date(Date.now() - 11 * DAY);
  const dayBStr = dayB.toISOString().slice(0, 10);
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('write', dayB.toISOString());
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('write', dayB.toISOString());

  ctx.service.reconcileOperationsDaily();

  const a = ctx.sqlite.prepare('SELECT reads, writes FROM operations_daily WHERE date = ?').get(dayAStr) as { reads: number; writes: number };
  expect(a.reads).toBe(100); // MAX(100, 1) — accumulated value preserved
  expect(a.writes).toBe(5);

  const b = ctx.sqlite.prepare('SELECT reads, writes FROM operations_daily WHERE date = ?').get(dayBStr) as { reads: number; writes: number };
  expect(b.writes).toBe(2); // healed from the raw log
});
