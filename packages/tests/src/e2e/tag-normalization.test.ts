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

test('tags are normalized on add (trim + lowercase + dedup, order preserved)', async () => {
  const entry = await factory.knowledge({ tags: ['  NestJS ', 'nestjs', 'Redis', 'redis '] });
  expect(entry.tags).toEqual(['nestjs', 'redis']);
});

test('tags are normalized on update', async () => {
  const entry = await factory.knowledge({ tags: ['alpha'] });
  const updated = await ctx.service.update(entry.id, { tags: ['  FOO', 'foo', 'Bar '] });
  expect(updated?.tags).toEqual(['foo', 'bar']);
});

test('empty / whitespace-only tags are dropped', async () => {
  const entry = await factory.knowledge({ tags: ['  ', '', 'keep'] });
  expect(entry.tags).toEqual(['keep']);
});
