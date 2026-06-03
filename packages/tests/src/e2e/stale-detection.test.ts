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

test('findStaleEntries flags low-confidence entries', async () => {
  const e = await factory.knowledge({ tags: ['lowconf'], confidenceScore: 0.1 });
  // days huge so the age cutoff never fires; only low confidence should flag it.
  const stale = await ctx.service.findStaleEntries({ days: 999999, minConfidence: 0.5 });
  expect(stale.map((s) => s.id)).toContain(e.id);
});

test('findStaleEntries flags expired entries', async () => {
  const e = await factory.knowledge({ tags: ['expired'], expiresAt: new Date(Date.now() - 1000) });
  // minConfidence 0 + huge days → only expiry can flag it.
  const stale = await ctx.service.findStaleEntries({ days: 999999, minConfidence: 0 });
  expect(stale.map((s) => s.id)).toContain(e.id);
});

test('findStaleEntries does NOT flag a fresh, high-confidence, non-expiring entry', async () => {
  const e = await factory.knowledge({ tags: ['fresh'], confidenceScore: 1.0 });
  const stale = await ctx.service.findStaleEntries({ days: 999999, minConfidence: 0 });
  expect(stale.map((s) => s.id)).not.toContain(e.id);
});
