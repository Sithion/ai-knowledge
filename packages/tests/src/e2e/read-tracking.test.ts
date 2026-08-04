import { test, expect } from '@playwright/test';
import { createControlledContext, destroyTestContext, type TestContext } from '../test-helpers.js';
import { KnowledgeType } from '@cognistore/shared';

/**
 * Read tracking is the input to the entire cleanup cycle: if it silently fails,
 * unread detection either stays permanently gated or — worse — proposes deleting
 * entries that are read every day. It also has a known silent-failure mode (an
 * option that never reaches the service is simply dropped), so it is asserted
 * end-to-end through `search`, not by calling the repository directly.
 */

/** The mark is deferred with setImmediate, so let the event loop turn first. */
const flushDeferredWrites = () => new Promise((r) => setTimeout(r, 20));

async function seed(ctx: TestContext, title: string) {
  return ctx.service.add({
    title,
    content: `VEC[1,0,0] ${title}`,
    tags: [],
    type: KnowledgeType.PATTERN,
    scope: 'global',
    source: 'test',
    skipDedup: true,
  } as any);
}

const rowOf = (ctx: TestContext, id: string) =>
  ctx.sqlite
    .prepare('SELECT last_read_at AS lastReadAt, read_count AS readCount, updated_at AS updatedAt, version FROM knowledge_entries WHERE id = ?')
    .get(id) as { lastReadAt: string | null; readCount: number; updatedAt: string; version: number };

test.describe('@e2e read tracking', () => {
  let ctx: TestContext;
  test.beforeEach(() => { ctx = createControlledContext(); });
  test.afterEach(() => destroyTestContext(ctx));

  test('a new entry starts with no read history', async () => {
    const e = await seed(ctx, 'Fresh');
    expect(rowOf(ctx, e.id).lastReadAt).toBeNull();
    expect(rowOf(ctx, e.id).readCount).toBe(0);
  });

  test('trackRead marks the hits and increments the counter', async () => {
    const e = await seed(ctx, 'Tracked');

    const results = await ctx.service.search('VEC[1,0,0] Tracked', { trackRead: true, threshold: 0 });
    expect(results.some((r) => r.entry.id === e.id)).toBe(true);
    await flushDeferredWrites();

    const first = rowOf(ctx, e.id);
    expect(first.lastReadAt).not.toBeNull();
    expect(first.readCount).toBe(1);

    await ctx.service.search('VEC[1,0,0] Tracked', { trackRead: true, threshold: 0 });
    await flushDeferredWrites();
    expect(rowOf(ctx, e.id).readCount).toBe(2);
  });

  test('a read is not an edit: updated_at and version are untouched', async () => {
    const e = await seed(ctx, 'Untouched');
    const before = rowOf(ctx, e.id);

    await ctx.service.search('VEC[1,0,0] Untouched', { trackRead: true, threshold: 0 });
    await flushDeferredWrites();

    const after = rowOf(ctx, e.id);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.version).toBe(before.version);
    expect(after.readCount).toBe(1);
  });

  test('a search without trackRead leaves the retention signal alone', async () => {
    const e = await seed(ctx, 'Browsed');

    await ctx.service.search('VEC[1,0,0] Browsed', { threshold: 0 });
    await flushDeferredWrites();

    expect(rowOf(ctx, e.id).lastReadAt).toBeNull();
    expect(rowOf(ctx, e.id).readCount).toBe(0);
  });

  test('a deferred mark landing after the database closed does not crash the process', async () => {
    // Short-lived MCP processes and the test suite itself close the DB right
    // after a search. The deferred write must fail silently, not take down the
    // process with an unhandled rejection.
    await seed(ctx, 'Closing');
    await ctx.service.search('VEC[1,0,0] Closing', { trackRead: true, threshold: 0 });
    ctx.sqlite.close();
    await flushDeferredWrites();
  });
});
