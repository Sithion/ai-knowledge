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

test('cleanupOldOperations removes old entries', () => {
  // Retention is 30 days (must cover the 15-day Activity chart window).
  // Insert fake old entries past the retention window.
  const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('read', oldDate);
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('write', oldDate);
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('read', oldDate);

  // Insert a recent entry that must survive (well within the 30-day window
  // but older than the previous 7-day cutoff to lock in the new retention).
  const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  ctx.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)').run('read', recentDate);

  // Count total before cleanup
  const totalBefore = (ctx.sqlite.prepare('SELECT COUNT(*) as count FROM operations_log').get() as { count: number }).count;

  const removed = ctx.service.cleanupOldOperations();
  expect(removed).toBeGreaterThanOrEqual(3);

  const totalAfter = (ctx.sqlite.prepare('SELECT COUNT(*) as count FROM operations_log').get() as { count: number }).count;
  expect(totalAfter).toBe(totalBefore - removed);

  // Verify recent entries still exist, including the 10-day-old one
  const recentCount = (ctx.sqlite.prepare(
    'SELECT COUNT(*) as count FROM operations_log WHERE created_at >= ?'
  ).get(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()) as { count: number }).count;
  expect(recentCount).toBeGreaterThan(0);
});
