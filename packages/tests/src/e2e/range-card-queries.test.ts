import { test, expect } from '@playwright/test';
import { createTestContext, destroyTestContext, type TestContext } from '../test-helpers.js';
import { KnowledgeType } from '@cognistore/shared';

let ctx: TestContext;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

test.beforeAll(async () => {
  ctx = createTestContext();

  // Seed 6 entries spread across time. We back-date created_at via direct SQL
  // so the WHERE filters in the new overloads can be exercised.
  const seed = [
    { id: 'a', type: KnowledgeType.PATTERN, scope: 'workspace:proj-a', tags: ['shared', 'a-only'], days: 60 },
    { id: 'b', type: KnowledgeType.PATTERN, scope: 'workspace:proj-a', tags: ['shared'], days: 40 },
    { id: 'c', type: KnowledgeType.DECISION, scope: 'workspace:proj-b', tags: ['shared'], days: 20 },
    { id: 'd', type: KnowledgeType.DECISION, scope: 'workspace:proj-b', tags: ['shared', 'd-only'], days: 10 },
    { id: 'e', type: KnowledgeType.FIX, scope: 'workspace:proj-b', tags: ['shared'], days: 5 },
    { id: 'f', type: KnowledgeType.FIX, scope: 'workspace:proj-c', tags: ['fresh-only'], days: 1 },
  ];

  for (const s of seed) {
    const entry = await ctx.service.add({
      title: `Entry ${s.id} ${crypto.randomUUID()}`,
      content: `${crypto.randomUUID()} content for entry ${s.id} totally unique ${Math.random()}`,
      tags: s.tags,
      type: s.type,
      scope: s.scope,
      source: 'range-test',
      skipDedup: true,
    } as any);
    // overwrite created_at so the seeded distribution is deterministic
    ctx.sqlite
      .prepare('UPDATE knowledge_entries SET created_at = ? WHERE id = ?')
      .run(isoDaysAgo(s.days), entry.id);
  }
});

test.afterAll(() => {
  destroyTestContext(ctx);
});

test('countByType: no range = total of all seeded types', async () => {
  const all = await ctx.repository.countByType();
  const byType = Object.fromEntries(all.map((r) => [r.type, r.count]));
  expect(byType[KnowledgeType.PATTERN]).toBe(2);
  expect(byType[KnowledgeType.DECISION]).toBe(2);
  expect(byType[KnowledgeType.FIX]).toBe(2);
});

test('countByType: range narrows to entries within window', async () => {
  // last 30 days: c (20d), d (10d), e (5d), f (1d) = 2 decisions + 2 fixes
  const recent = await ctx.repository.countByType({
    from: isoDaysAgo(30),
    to: isoDaysAgo(0),
  });
  const byType = Object.fromEntries(recent.map((r) => [r.type, r.count]));
  expect(byType[KnowledgeType.PATTERN]).toBeUndefined();
  expect(byType[KnowledgeType.DECISION]).toBe(2);
  expect(byType[KnowledgeType.FIX]).toBe(2);
});

test('countByScope: range narrows to entries within window', async () => {
  // last 7 days: e (5d, proj-b), f (1d, proj-c)
  const recent = await ctx.repository.countByScope({
    from: isoDaysAgo(7),
    to: isoDaysAgo(0),
  });
  const byScope = Object.fromEntries(recent.map((r) => [r.scope, r.count]));
  expect(byScope['workspace:proj-b']).toBe(1);
  expect(byScope['workspace:proj-c']).toBe(1);
  expect(byScope['workspace:proj-a']).toBeUndefined();
});

test('topTags: range filters and ranking honored', async () => {
  // last 15 days: d (10d) + e (5d) + f (1d); tags shared=2, d-only=1, fresh-only=1
  const tags = await ctx.repository.topTags(10, {
    from: isoDaysAgo(15),
    to: isoDaysAgo(0),
  });
  const map = Object.fromEntries(tags.map((t) => [t.tag, t.count]));
  expect(map['shared']).toBe(2);
  expect(map['d-only']).toBe(1);
  expect(map['fresh-only']).toBe(1);
  expect(map['a-only']).toBeUndefined();
});

test('listTags: range filters distinct values', async () => {
  // last 3 days: only f → fresh-only
  const tags = await ctx.repository.listTags({
    from: isoDaysAgo(3),
    to: isoDaysAgo(0),
  });
  expect(tags).toEqual(['fresh-only']);
});

test('range-aware methods leave all-time behavior unchanged when omitted', async () => {
  const all = await ctx.repository.listTags();
  expect(all.length).toBeGreaterThanOrEqual(4); // shared, a-only, d-only, fresh-only

  const allTop = await ctx.repository.topTags(10);
  expect(allTop.find((t) => t.tag === 'shared')?.count).toBe(5);
});
