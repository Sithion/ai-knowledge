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

// The mock embedding encodes char distribution, not meaning. A short query against a
// long, char-distributionally-different document has low cosine — so with a high
// semantic threshold the entry only survives via the FTS/BM25 keyword path. This is
// exactly the regression the queryText fix protects (FTS must reach the repository).
test('keyword-only match surfaces via FTS even above the semantic threshold', async () => {
  const kw = await factory.knowledge({
    title: 'Filler title',
    content: 'qzxvbarbazqux ' + 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(20),
    tags: ['ftsonly'],
  });

  const results = await ctx.service.search('qzxvbarbazqux', { threshold: 0.95, limit: 10 });
  expect(results.map((r) => r.entry.id)).toContain(kw.id);
});

test('search still returns SearchResult shape (entry + similarity in [0,1])', async () => {
  await factory.knowledge({ content: 'hybrid shape check token wobble', tags: ['shape'] });
  const results = await ctx.service.search('wobble', { threshold: 0.0 });
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].entry.id).toBeTruthy();
  expect(results[0].similarity).toBeGreaterThan(0);
  expect(results[0].similarity).toBeLessThanOrEqual(1);
});
