import { test, expect } from '@playwright/test';
import { createTestContext, destroyTestContext, createFactory, type TestContext } from '../test-helpers.js';

let ctx: TestContext;
let factory: ReturnType<typeof createFactory>;

// Set an explicit created_at so ordering (created_at DESC) is deterministic, not
// dependent on equal timestamps from a tight insert loop.
function setCreatedAt(id: string, iso: string) {
  ctx.sqlite.prepare('UPDATE knowledge_entries SET created_at = ? WHERE id = ?').run(iso, id);
}

test.beforeAll(() => {
  ctx = createTestContext();
  factory = createFactory(ctx.service);
});
test.afterAll(() => {
  destroyTestContext(ctx);
});

test('tag filter matches across the WHOLE base, not just the first page (the bug fix)', async () => {
  // Oldest entry carries the needle tag; 35 newer entries do NOT. Unfiltered, the
  // needle is far past the first page of 30. The server-side tag filter must still find it.
  const needle = await factory.knowledge({ tags: ['needle-tag'], content: 'the needle' });
  setCreatedAt(needle.id, '2000-01-01T00:00:00.000Z');
  for (let i = 0; i < 35; i++) {
    const e = await factory.knowledge({ tags: ['bulk'], content: `bulk ${i}` });
    setCreatedAt(e.id, `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`);
  }

  // Unfiltered first page (30, newest first) must NOT contain the oldest needle.
  const page1 = await ctx.service.listRecent(30, undefined, 0);
  expect(page1).toHaveLength(30);
  expect(page1.map((e) => e.id)).not.toContain(needle.id);

  // Tag filter finds the needle despite it being well beyond page 1.
  const tagged = await ctx.service.listRecent(30, { tags: ['needle-tag'] }, 0);
  expect(tagged.map((e) => e.id)).toContain(needle.id);
  expect(tagged.every((e) => (e.tags as string[]).includes('needle-tag'))).toBe(true);
});

test('offset pagination returns disjoint, ordered pages', async () => {
  const page1 = await ctx.service.listRecent(30, undefined, 0);
  const page2 = await ctx.service.listRecent(30, undefined, 30);
  const ids1 = new Set(page1.map((e) => e.id));
  // 36 total (1 needle + 35 bulk) → page2 has the remaining 6.
  expect(page2.length).toBe(6);
  expect(page2.some((e) => ids1.has(e.id))).toBe(false); // disjoint
  // created_at DESC order within page 1.
  const times = page1.map((e) => new Date(e.createdAt).getTime());
  expect([...times].sort((a, b) => b - a)).toEqual(times);
});

test('type + tag filters combine (AND type, OR tags)', async () => {
  const tagged = await ctx.service.listRecent(50, { type: 'pattern', tags: ['needle-tag'] }, 0);
  // needle was created as the default factory type 'pattern'
  expect(tagged.map((e) => e.id)).toContain((await ctx.service.listRecent(50, { tags: ['needle-tag'] }, 0))[0].id);
});

test('listPlans paginates with offset', async () => {
  for (let i = 0; i < 5; i++) await factory.plan({ title: `Plan ${i}` });
  const p1 = ctx.service.listPlans(2, undefined, undefined, 0);
  const p2 = ctx.service.listPlans(2, undefined, undefined, 2);
  expect(p1).toHaveLength(2);
  expect(p2).toHaveLength(2);
  const ids1 = new Set(p1.map((p) => p.id));
  expect(p2.some((p) => ids1.has(p.id))).toBe(false);
});
