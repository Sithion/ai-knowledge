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

test('getOperationsByDay(730) returns 730 zero-filled buckets', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const d400 = new Date(Date.now() - 400 * DAY);
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('write', d400.toISOString());

  const buckets = ctx.service.getOperationsByDay(730);
  expect(buckets.length).toBe(730);

  const bucket = buckets.find((b) => b.date === d400.toISOString().split('T')[0]);
  expect(bucket).toBeDefined();
  expect(bucket!.writes).toBeGreaterThanOrEqual(1);

  for (const b of buckets) {
    expect(typeof b.reads).toBe('number');
    expect(typeof b.writes).toBe('number');
  }
});
