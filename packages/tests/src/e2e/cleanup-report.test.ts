import { test, expect } from '@playwright/test';
import { createControlledContext, destroyTestContext, type TestContext } from '../test-helpers.js';
import { KnowledgeType } from '@cognistore/shared';

/**
 * Cleanup cycle: detection, the gates that keep it quiet when its signal is not
 * trustworthy, and the apply paths — which perform irreversible deletes and so
 * carry most of the risk in this feature.
 */

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function ctxFactory(ctx: TestContext) {
  return (o: Record<string, unknown> = {}) =>
    ctx.service.add({
      title: 'Entry',
      content: 'content',
      tags: [],
      type: KnowledgeType.PATTERN,
      scope: 'global',
      source: 'test',
      skipDedup: true,
      ...o,
    } as any);
}

/** Make read tracking look long-established and alive, so gates open. */
function enableUnreadDetection(ctx: TestContext, trackingStartedDaysAgo = 400) {
  ctx.sqlite.prepare("UPDATE cleanup_meta SET value = ? WHERE key = 'read_tracking_since'")
    .run(ago(trackingStartedDaysAgo));
  // Liveness probe: at least one recent read must exist somewhere.
  ctx.sqlite.prepare('INSERT INTO knowledge_entries (id, title, content, tags, type, scope, source, created_at, updated_at, last_read_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('liveness-probe', 'probe', 'probe', '[]', 'system', 'global', 'test', ago(500), ago(500), new Date().toISOString());
}

test.describe('@e2e cleanup report — detection', () => {
  let ctx: TestContext;
  test.beforeEach(() => { ctx = createControlledContext(); });
  test.afterEach(() => destroyTestContext(ctx));

  test('flags entries tagged deprecated', async () => {
    const mk = ctxFactory(ctx);
    const dep = await mk({ title: 'Superseded', tags: ['deprecated', 'api'] });
    await mk({ title: 'Current', tags: ['api'] });

    const { report } = await ctx.service.generateCleanupReport({});
    const candidates = ctx.repository.listCleanupCandidates(report.id);
    const deprecated = candidates.filter((c) => c.category === 'deprecated');

    expect(deprecated).toHaveLength(1);
    expect(JSON.parse(deprecated[0].entryIds)).toEqual([dep.id]);
  });

  test('flags entries never read within the window, and NULL last_read_at counts as unread', async () => {
    const mk = ctxFactory(ctx);
    const forgotten = await mk({ title: 'Forgotten' });
    // A post-migration entry has last_read_at = NULL. `NULL < cutoff` is never
    // true in SQL, so without COALESCE this entry would be invisible forever.
    ctx.sqlite.prepare('UPDATE knowledge_entries SET created_at = ?, last_read_at = NULL WHERE id = ?')
      .run(ago(400), forgotten.id);
    enableUnreadDetection(ctx);

    const { report } = await ctx.service.generateCleanupReport({ unreadDays: 180 });
    const unread = ctx.repository.listCleanupCandidates(report.id).filter((c) => c.category === 'unread');

    expect(unread).toHaveLength(1);
    expect(JSON.parse(unread[0].entryIds)).toEqual([forgotten.id]);
  });

  test('the keep tag exempts an entry from unread detection', async () => {
    const mk = ctxFactory(ctx);
    const protectedEntry = await mk({ title: 'Protected', tags: ['keep'] });
    ctx.sqlite.prepare('UPDATE knowledge_entries SET created_at = ?, last_read_at = NULL WHERE id = ?')
      .run(ago(400), protectedEntry.id);
    enableUnreadDetection(ctx);

    const { report } = await ctx.service.generateCleanupReport({ unreadDays: 180 });
    const unread = ctx.repository.listCleanupCandidates(report.id).filter((c) => c.category === 'unread');

    expect(unread).toHaveLength(0);
  });

  test('a recently read entry is not unread', async () => {
    const mk = ctxFactory(ctx);
    const used = await mk({ title: 'Still used' });
    ctx.sqlite.prepare('UPDATE knowledge_entries SET created_at = ?, last_read_at = ? WHERE id = ?')
      .run(ago(400), ago(3), used.id);
    enableUnreadDetection(ctx);

    const { report } = await ctx.service.generateCleanupReport({ unreadDays: 180 });
    expect(ctx.repository.listCleanupCandidates(report.id).filter((c) => c.category === 'unread')).toHaveLength(0);
  });
});

test.describe('@e2e cleanup report — unread gates', () => {
  let ctx: TestContext;
  test.beforeEach(() => { ctx = createControlledContext(); });
  test.afterEach(() => destroyTestContext(ctx));

  test('suppresses unread detection until read tracking is old enough', async () => {
    const mk = ctxFactory(ctx);
    const e = await mk({ title: 'Old but untracked' });
    ctx.sqlite.prepare('UPDATE knowledge_entries SET created_at = ?, last_read_at = NULL WHERE id = ?')
      .run(ago(400), e.id);
    // Tracking just started — the backfill means "unread" is not yet meaningful.
    ctx.sqlite.prepare("UPDATE cleanup_meta SET value = ? WHERE key = 'read_tracking_since'").run(ago(5));

    const { report } = await ctx.service.generateCleanupReport({ unreadDays: 180 });
    const stats = report.stats;

    expect(stats.unreadGate).toContain('activates');
    expect(stats.counts.unread).toBe(0);
  });

  test('suppresses unread detection when no read has been recorded recently', async () => {
    const mk = ctxFactory(ctx);
    const e = await mk({ title: 'Looks abandoned' });
    ctx.sqlite.prepare('UPDATE knowledge_entries SET created_at = ?, last_read_at = NULL WHERE id = ?')
      .run(ago(400), e.id);
    ctx.sqlite.prepare("UPDATE cleanup_meta SET value = ? WHERE key = 'read_tracking_since'").run(ago(400));
    // No entry carries a recent read: an outdated MCP server would look exactly
    // like this, and every entry would falsely appear abandoned.

    const { report } = await ctx.service.generateCleanupReport({ unreadDays: 180 });
    const stats = report.stats;

    expect(stats.unreadGate).toBeTruthy();
    expect(stats.counts.unread).toBe(0);
  });
});

test.describe('@e2e cleanup report — consolidation grouping', () => {
  let ctx: TestContext;
  test.beforeEach(() => { ctx = createControlledContext(); });
  test.afterEach(() => destroyTestContext(ctx));

  test('the canonical is the NEWEST member, even when another has a higher version', async () => {
    const mk = ctxFactory(ctx);
    const a = await mk({ title: 'Duplicate A', content: 'VEC[1,0,0] duplicate a' });
    const b = await mk({ title: 'Duplicate B', content: 'VEC[1,0,0] duplicate b' });

    // `a` is older but heavily edited; `b` is the newest. findDuplicateGroups
    // sorts members by version DESC first, so it would nominate `a` — the user's
    // rule is "newest wins", and the loser gets deleted.
    ctx.sqlite.prepare('UPDATE knowledge_entries SET version = 9, updated_at = ? WHERE id = ?').run(ago(30), a.id);
    ctx.sqlite.prepare('UPDATE knowledge_entries SET version = 1, updated_at = ? WHERE id = ?').run(ago(1), b.id);

    const { report } = await ctx.service.generateCleanupReport({ dupThreshold: 0.9 });
    const group = ctx.repository.listCleanupCandidates(report.id).find((c) => c.category === 'duplicate_group');

    expect(group).toBeTruthy();
    expect(JSON.parse(group!.entryIds)[0]).toBe(b.id);
  });

  test('an entry already queued for removal is dropped from its duplicate group', async () => {
    const mk = ctxFactory(ctx);
    await mk({ title: 'Dup A', content: 'VEC[0,1,0] dup a', tags: ['deprecated'] });
    await mk({ title: 'Dup B', content: 'VEC[0,1,0] dup b' });

    const { report } = await ctx.service.generateCleanupReport({ dupThreshold: 0.9 });
    const candidates = ctx.repository.listCleanupCandidates(report.id);

    // One member left the group, so the group falls below two and disappears —
    // the entry is deleted once, not deleted and merged.
    expect(candidates.filter((c) => c.category === 'duplicate_group')).toHaveLength(0);
    expect(candidates.filter((c) => c.category === 'deprecated')).toHaveLength(1);
  });
});

test.describe('@e2e cleanup report — lifecycle', () => {
  let ctx: TestContext;
  test.beforeEach(() => { ctx = createControlledContext(); });
  test.afterEach(() => destroyTestContext(ctx));

  test('is idempotent while a report is open', async () => {
    const mk = ctxFactory(ctx);
    await mk({ title: 'Dep', tags: ['deprecated'] });

    const first = await ctx.service.generateCleanupReport({});
    const second = await ctx.service.generateCleanupReport({});

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.report.id).toBe(first.report.id);
  });

  test('records per-category counts and, on close, what was actually removed', async () => {
    const mk = ctxFactory(ctx);
    await mk({ title: 'Dep one', tags: ['deprecated'] });
    await mk({ title: 'Dep two', tags: ['deprecated'] });

    const { report } = await ctx.service.generateCleanupReport({});
    expect(report.stats.counts).toMatchObject({ deprecated: 2, removableEntries: 2 });

    const [candidate] = ctx.repository.listCleanupCandidates(report.id);
    await ctx.service.applyRemovalCandidate(candidate.id);
    const { removed } = ctx.service.closeCleanupReport(report.id);

    expect(removed).toBe(1);
    const closed = ctx.repository.getCleanupReportById(report.id)!;
    expect(closed.status).toBe('closed');
    // Everything the user never acted on is dismissed with the report.
    expect(ctx.repository.listCleanupCandidates(report.id).every((c) => c.status !== 'pending')).toBe(true);
  });
});

test.describe('@e2e cleanup report — applying removals', () => {
  let ctx: TestContext;
  test.beforeEach(() => { ctx = createControlledContext(); });
  test.afterEach(() => destroyTestContext(ctx));

  test('deletes the entry and snapshots it for recovery', async () => {
    const mk = ctxFactory(ctx);
    const dep = await mk({ title: 'Superseded', content: 'the old way', tags: ['deprecated'] });

    const { report } = await ctx.service.generateCleanupReport({});
    const [candidate] = ctx.repository.listCleanupCandidates(report.id);
    const result = await ctx.service.applyRemovalCandidate(candidate.id);

    expect(result.deleted).toBe(1);
    expect(await ctx.service.getById(dep.id)).toBeNull();

    const resolution = JSON.parse(ctx.repository.getCleanupCandidate(candidate.id)!.resolution!);
    expect(resolution.deletedSnapshot[0].content).toBe('the old way');
  });

  test('skips an entry that stopped qualifying after the report was generated', async () => {
    const mk = ctxFactory(ctx);
    const dep = await mk({ title: 'Superseded', tags: ['deprecated'] });

    const { report } = await ctx.service.generateCleanupReport({});
    const [candidate] = ctx.repository.listCleanupCandidates(report.id);

    // The user un-deprecates it before approving the report.
    await ctx.service.update(dep.id, { tags: ['api'] });
    const result = await ctx.service.applyRemovalCandidate(candidate.id);

    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await ctx.service.getById(dep.id)).not.toBeNull();
  });

  test('refuses to treat a duplicate group as a removal', async () => {
    const mk = ctxFactory(ctx);
    await mk({ title: 'Dup A', content: 'VEC[0,0,1] dup a' });
    await mk({ title: 'Dup B', content: 'VEC[0,0,1] dup b' });

    const { report } = await ctx.service.generateCleanupReport({ dupThreshold: 0.9 });
    const group = ctx.repository.listCleanupCandidates(report.id).find((c) => c.category === 'duplicate_group')!;

    // entry_ids starts with the CANONICAL, so a removal here would delete the
    // survivor along with the whole group.
    await expect(ctx.service.applyRemovalCandidate(group.id)).rejects.toThrow(/cannot handle category/);
    expect(await ctx.service.listAll()).toHaveLength(2);
  });

  test('a second approval of the same candidate is rejected', async () => {
    const mk = ctxFactory(ctx);
    await mk({ title: 'Superseded', tags: ['deprecated'] });

    const { report } = await ctx.service.generateCleanupReport({});
    const [candidate] = ctx.repository.listCleanupCandidates(report.id);

    await ctx.service.applyRemovalCandidate(candidate.id);
    // Two dashboard windows, one candidate: the claim must let exactly one win.
    await expect(ctx.service.applyRemovalCandidate(candidate.id)).rejects.toThrow(/not pending/);
  });

  test('dismissing an already-applied candidate is refused', async () => {
    const mk = ctxFactory(ctx);
    await mk({ title: 'Superseded', content: 'the old way', tags: ['deprecated'] });

    const { report } = await ctx.service.generateCleanupReport({});
    const [candidate] = ctx.repository.listCleanupCandidates(report.id);
    await ctx.service.applyRemovalCandidate(candidate.id);

    // Dismissing after the fact would drop the entry from the report's removal
    // tally and hide that something was actually deleted.
    expect(() => ctx.service.dismissCleanupCandidate(candidate.id)).toThrow(/not pending/);
    expect(ctx.repository.getCleanupCandidate(candidate.id)!.status).toBe('applied');
    expect(ctx.service.closeCleanupReport(report.id).removed).toBe(1);
  });

  test('a pending candidate can still be dismissed', async () => {
    const mk = ctxFactory(ctx);
    const dep = await mk({ title: 'Superseded', tags: ['deprecated'] });

    const { report } = await ctx.service.generateCleanupReport({});
    const [candidate] = ctx.repository.listCleanupCandidates(report.id);
    ctx.service.dismissCleanupCandidate(candidate.id);

    expect(ctx.repository.getCleanupCandidate(candidate.id)!.status).toBe('dismissed');
    expect(await ctx.service.getById(dep.id)).not.toBeNull();
  });
});

test.describe('@e2e cleanup report — applying consolidations', () => {
  let ctx: TestContext;
  test.beforeEach(() => { ctx = createControlledContext(); });
  test.afterEach(() => destroyTestContext(ctx));

  async function groupOf(ctx: TestContext) {
    const mk = ctxFactory(ctx);
    const older = await mk({ title: 'Older dup', content: 'VEC[1,1,0] older', tags: ['alpha'], agentId: 'documentation' });
    const newer = await mk({ title: 'Newer dup', content: 'VEC[1,1,0] newer', tags: ['beta'], agentId: 'documentation' });
    ctx.sqlite.prepare('UPDATE knowledge_entries SET updated_at = ? WHERE id = ?').run(ago(30), older.id);
    ctx.sqlite.prepare('UPDATE knowledge_entries SET updated_at = ? WHERE id = ?').run(ago(1), newer.id);
    const { report } = await ctx.service.generateCleanupReport({ dupThreshold: 0.9 });
    const candidate = ctx.repository.listCleanupCandidates(report.id).find((c) => c.category === 'duplicate_group')!;
    return { older, newer, candidate };
  }

  test('merges into the canonical, deletes the rest, and preserves provenance', async () => {
    const { older, newer, candidate } = await groupOf(ctx);
    const before = await ctx.service.getById(newer.id);

    await ctx.service.applyConsolidationCandidate(candidate.id, { title: 'Merged', content: 'merged body' }, true);

    const canonical = await ctx.service.getById(newer.id);
    expect(canonical).not.toBeNull();
    expect(canonical!.title).toBe('Merged');
    expect(canonical!.version).toBe(before!.version + 1);
    // The dedup-update null-wipe class of bug: these must survive a merge.
    expect(canonical!.agentId).toBe('documentation');
    expect(await ctx.service.getById(older.id)).toBeNull();
  });

  test('recomputes tags server-side, so a client cannot inject control tags', async () => {
    const { newer, candidate } = await groupOf(ctx);

    // A hand-made request tries to smuggle tags in. The apply path takes only
    // title and content; tags come from the members.
    await ctx.service.applyConsolidationCandidate(
      candidate.id,
      { title: 'Merged', content: 'merged body', tags: ['keep', 'deprecated', 'injected'] } as any,
      false,
    );

    const canonical = await ctx.service.getById(newer.id);
    expect(canonical!.tags.sort()).toEqual(['alpha', 'beta']);
    expect(canonical!.tags).not.toContain('injected');
  });

  test('aborts without deleting anything when the canonical changed since the report', async () => {
    const { older, newer, candidate } = await groupOf(ctx);

    // The user edited the survivor after reviewing the report, so the merge they
    // approved was computed against text that no longer exists.
    await ctx.service.update(newer.id, { content: 'edited in the meantime' });

    await expect(
      ctx.service.applyConsolidationCandidate(candidate.id, { title: 'Merged', content: 'merged body' })
    ).rejects.toThrow(/modified after the report/);

    expect(await ctx.service.getById(older.id)).not.toBeNull();
    expect(ctx.repository.getCleanupCandidate(candidate.id)!.status).toBe('failed');
  });

  test('aborts when the canonical no longer exists', async () => {
    const { older, newer, candidate } = await groupOf(ctx);
    await ctx.service.delete(newer.id);

    await expect(
      ctx.service.applyConsolidationCandidate(candidate.id, { title: 'Merged', content: 'merged body' })
    ).rejects.toThrow(/Consolidation aborted/);

    expect(await ctx.service.getById(older.id)).not.toBeNull();
  });

  test('a second approval is rejected and cannot destroy the recovery snapshot', async () => {
    const { older, candidate } = await groupOf(ctx);

    await ctx.service.applyConsolidationCandidate(candidate.id, { title: 'Merged', content: 'merged body' });

    // The group's members are gone, so a replay looks "stale". It must not
    // overwrite the resolution — that is the only copy of what was deleted.
    await expect(
      ctx.service.applyConsolidationCandidate(candidate.id, { title: 'Merged again', content: 'again' })
    ).rejects.toThrow(/not pending/);

    const after = ctx.repository.getCleanupCandidate(candidate.id)!;
    expect(after.status).toBe('applied');
    const resolution = JSON.parse(after.resolution!);
    expect(resolution.deletedIds).toEqual([older.id]);
    expect(resolution.deletedSnapshot[0].id).toBe(older.id);
  });

  test('rejects an invalid draft before touching anything', async () => {
    const { older, newer, candidate } = await groupOf(ctx);

    await expect(
      ctx.service.applyConsolidationCandidate(candidate.id, { title: '', content: 'x' })
    ).rejects.toThrow(/title/);

    expect(await ctx.service.getById(older.id)).not.toBeNull();
    expect(await ctx.service.getById(newer.id)).not.toBeNull();
  });
});
