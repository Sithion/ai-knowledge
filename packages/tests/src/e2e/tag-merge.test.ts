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

test('suggestTagMerges flags near-duplicate tags', async () => {
  await factory.knowledge({ tags: ['reactjs'] });
  await factory.knowledge({ tags: ['react.js'] });
  const suggestions = await ctx.service.suggestTagMerges(0.8);
  const pair = suggestions.find(
    (s) => (s.a === 'reactjs' && s.b === 'react.js') || (s.a === 'react.js' && s.b === 'reactjs'),
  );
  expect(pair).toBeTruthy();
  expect(pair!.similarity).toBeGreaterThanOrEqual(0.8);
});

test('mergeTag rewrites the tag across all entries, dedups, and reports the count', async () => {
  const a = await factory.knowledge({ tags: ['vue.js', 'common'] });
  const b = await factory.knowledge({ tags: ['vuejs', 'vue.js'] }); // both present → must dedup on merge

  const res = await ctx.service.mergeTag('vue.js', 'vuejs');
  expect(res.merged).toBeGreaterThanOrEqual(2);

  const ea = await ctx.service.getById(a.id);
  expect(ea?.tags).toContain('vuejs');
  expect(ea?.tags).not.toContain('vue.js');
  expect(ea?.tags).toContain('common');

  const eb = await ctx.service.getById(b.id);
  expect(eb?.tags.filter((t) => t === 'vuejs')).toHaveLength(1); // deduped
  expect(eb?.tags).not.toContain('vue.js');
});

test('mergeTag is a no-op for equal or empty inputs', async () => {
  expect(await ctx.service.mergeTag('x', 'x')).toEqual({ merged: 0 });
  expect(await ctx.service.mergeTag('', 'y')).toEqual({ merged: 0 });
});
