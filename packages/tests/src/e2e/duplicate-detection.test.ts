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

test('findDuplicatePairs returns near-identical entries (real embeddings)', async () => {
  // Identical title+content+tags → identical (mock) embedding → cosine 1.0.
  const common = { title: 'Dup', content: 'exact duplicate content here', tags: ['dup'] };
  const a = await factory.knowledge({ ...common });
  const b = await factory.knowledge({ ...common });

  const pairs = await ctx.service.findDuplicatePairs({ threshold: 0.95 });
  const found = pairs.some(
    (p) => (p.a.id === a.id && p.b.id === b.id) || (p.a.id === b.id && p.b.id === a.id),
  );
  expect(found).toBe(true);
});

test('findDuplicatePairs returns [] on a DB with no embeddings', async () => {
  const fresh = createTestContext();
  try {
    const pairs = await fresh.service.findDuplicatePairs();
    expect(pairs).toEqual([]);
  } finally {
    destroyTestContext(fresh);
  }
});
