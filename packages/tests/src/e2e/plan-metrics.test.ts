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

test('getPlansByDay zero-fills the window and counts backdated plans', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const plan = await factory.plan({ title: 'Backdated plan for metrics' });
  const backdate = new Date(Date.now() - 100 * DAY);
  ctx.sqlite.prepare('UPDATE plans SET created_at = ? WHERE id = ?').run(backdate.toISOString(), plan.id);

  const series = ctx.service.getPlansByDay(730);
  expect(series.length).toBe(730); // zero-fill guarantees exactly N — keep strict

  // Assert via total count, not one exact bucket key: local-vs-UTC date keys
  // can offset by 1 day near midnight in DST timezones (review finding).
  const total = series.reduce((sum, b) => sum + b.count, 0);
  expect(total).toBeGreaterThanOrEqual(1);
  expect(series.every((b) => typeof b.count === 'number')).toBe(true);
});

test('getPlansByDay defaults to a 15-day window', () => {
  expect(ctx.service.getPlansByDay().length).toBe(15);
});
