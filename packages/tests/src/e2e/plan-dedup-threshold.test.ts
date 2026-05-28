import { test, expect } from '@playwright/test';
import { createControlledContext, destroyTestContext, type TestContext } from '../test-helpers.js';
import { KnowledgeStatus } from '@cognistore/shared';

// Feature 2 — smarter plan dedup. Uses the controllable VEC[...] embedder so we can
// place plans at exact cosine similarities relative to each other:
//   VEC[1,0,0]      vs VEC[0,1,0]    → cosine 0      (unrelated)
//   VEC[1,0,0]      vs VEC[1,0.9,0]  → cosine ~0.74  (related, in the 0.7–0.8 band)
//   VEC[1,0,0]      vs VEC[1,0.05,0] → cosine ~0.999 (essentially the same)

let ctx: TestContext;

test.beforeAll(() => { ctx = createControlledContext(); });
test.afterAll(() => { destroyTestContext(ctx); });

test('different work in the same scope creates a NEW plan (no false merge)', async () => {
  const scope = 'workspace:f2-different';
  const a = await ctx.service.createPlan({
    title: 'Plan A', content: 'VEC[1,0,0]', tags: ['x'], scope, source: 'test', skipDedup: true,
  });
  ctx.service.updatePlan(a.id, { status: KnowledgeStatus.ACTIVE });

  const b = await ctx.service.createPlan({
    title: 'Plan B', content: 'VEC[0,1,0]', tags: ['x'], scope, source: 'test',
  });

  expect(b.id).not.toBe(a.id);
  expect((b as any).deduplicated).toBeFalsy();
  expect((b as any).dedupSkipped).toBeFalsy(); // truly unrelated → not even flagged
});

test('related-but-distinct plan does NOT merge into an ACTIVE plan; surfaces hint', async () => {
  const scope = 'workspace:f2-related-active';
  const a = await ctx.service.createPlan({
    title: 'Active Plan', content: 'VEC[1,0,0]', tags: ['x'], scope, source: 'test', skipDedup: true,
  });
  ctx.service.updatePlan(a.id, { status: KnowledgeStatus.ACTIVE });

  // cosine ~0.74 — related (≥0.7) but below the active-merge bar (0.8).
  const c = await ctx.service.createPlan({
    title: 'Related Plan', content: 'VEC[1,0.9,0]', tags: ['x'], scope, source: 'test',
  });

  expect(c.id).not.toBe(a.id);
  expect((c as any).deduplicated).toBeFalsy();
  expect((c as any).dedupSkipped).toBe(true);
  expect((c as any).nearestPlanId).toBe(a.id);
  expect((c as any).nearestSimilarity).toBeGreaterThanOrEqual(0.7);
  expect((c as any).nearestSimilarity).toBeLessThan(0.8);
  expect((c as any).hint).toContain(a.id);
});

test('near-identical plan DOES merge into an ACTIVE plan', async () => {
  const scope = 'workspace:f2-same-active';
  const a = await ctx.service.createPlan({
    title: 'Active Plan', content: 'VEC[1,0,0]', tags: ['x'], scope, source: 'test',
    tasks: [{ description: 'first' }], skipDedup: true,
  });
  ctx.service.updatePlan(a.id, { status: KnowledgeStatus.ACTIVE });

  const dup = await ctx.service.createPlan({
    title: 'Same effort', content: 'VEC[1,0.05,0]', tags: ['x'], scope, source: 'test',
    tasks: [{ description: 'second' }],
  });

  expect(dup.id).toBe(a.id);
  expect((dup as any).deduplicated).toBe(true);
  expect((dup as any).deduplicatedAction).toBe('tasks_added_to_active_plan');
  expect(ctx.service.listPlanTasks(a.id)).toHaveLength(2); // task appended
});

test('related plan merges into a DRAFT at the lower 0.7 bar', async () => {
  const scope = 'workspace:f2-draft';
  const a = await ctx.service.createPlan({
    title: 'Draft Plan', content: 'VEC[1,0,0]', tags: ['x'], scope, source: 'test', skipDedup: true,
  });
  expect(a.status).toBe(KnowledgeStatus.DRAFT);

  // cosine ~0.74 — below the active bar but enough to update an unconfirmed draft.
  const upd = await ctx.service.createPlan({
    title: 'Draft refined', content: 'VEC[1,0.9,0]', tags: ['x'], scope, source: 'test',
  });

  expect(upd.id).toBe(a.id);
  expect((upd as any).deduplicated).toBe(true);
  expect((upd as any).deduplicatedAction).toBe('draft_plan_updated');
});
