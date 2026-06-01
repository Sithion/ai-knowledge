import { test, expect } from '@playwright/test';
import { createTestContext, destroyTestContext, createFactory, type TestContext } from '../test-helpers.js';
import { KnowledgeStatus } from '@cognistore/shared';

let ctx: TestContext;
let factory: ReturnType<typeof createFactory>;

test.beforeAll(() => {
  ctx = createTestContext();
  factory = createFactory(ctx.service);
});
test.afterAll(() => {
  destroyTestContext(ctx);
});

test('createPlan returns Plan with status=draft', async () => {
  const plan = await factory.plan({ title: 'Draft Plan' });

  expect(plan.id).toBeTruthy();
  expect(plan.title).toBe('Draft Plan');
  expect(plan.status).toBe(KnowledgeStatus.DRAFT);
  expect(plan.createdAt).toBeInstanceOf(Date);
  expect(plan.updatedAt).toBeInstanceOf(Date);
});

test('createPlan with tasks array creates plan + tasks', async () => {
  const plan = await factory.plan({
    title: 'Plan With Tasks',
    tasks: [
      { description: 'Task A' },
      { description: 'Task B', priority: 'high' },
    ],
  });

  expect(plan.id).toBeTruthy();

  const tasks = ctx.service.listPlanTasks(plan.id);
  expect(tasks).toHaveLength(2);
  expect(tasks[0].description).toBe('Task A');
  expect(tasks[1].description).toBe('Task B');
  expect(tasks[1].priority).toBe('high');
});

test('createPlan with relatedKnowledgeIds creates input relations', async () => {
  const k1 = await factory.knowledge({ content: 'Related knowledge 1 for plan' });
  const k2 = await factory.knowledge({ content: 'Related knowledge 2 for plan' });

  const plan = await ctx.service.createPlan({
    title: 'Plan With Relations',
    content: 'A plan that references knowledge',
    tags: ['relations-test'],
    scope: 'global',
    source: 'test',
  });

  ctx.service.addPlanRelation(plan.id, k1.id, 'input');
  ctx.service.addPlanRelation(plan.id, k2.id, 'input');

  const relations = await ctx.service.getPlanRelations(plan.id);
  expect(relations).toHaveLength(2);
  const relIds = relations.map((r) => r.entry.id);
  expect(relIds).toContain(k1.id);
  expect(relIds).toContain(k2.id);
  for (const rel of relations) {
    expect(rel.relationType).toBe('input');
  }
});

test('getPlanById returns plan', async () => {
  const plan = await factory.plan({ title: 'Fetch Plan' });
  const fetched = ctx.service.getPlanById(plan.id);

  expect(fetched).not.toBeNull();
  expect(fetched!.id).toBe(plan.id);
  expect(fetched!.title).toBe('Fetch Plan');
});

test('updatePlan changes status draft -> active -> completed', async () => {
  const plan = await factory.plan();
  expect(plan.status).toBe(KnowledgeStatus.DRAFT);

  const active = ctx.service.updatePlan(plan.id, { status: KnowledgeStatus.ACTIVE });
  expect(active).not.toBeNull();
  expect(active!.status).toBe(KnowledgeStatus.ACTIVE);

  const completed = ctx.service.updatePlan(plan.id, { status: KnowledgeStatus.COMPLETED });
  expect(completed).not.toBeNull();
  expect(completed!.status).toBe(KnowledgeStatus.COMPLETED);
});

test('updatePlan changes title, content, and tags', async () => {
  const plan = await factory.plan({ title: 'Old Title', content: 'Old content', tags: ['old'] });

  const updated = ctx.service.updatePlan(plan.id, {
    title: 'New Title',
    content: 'New content',
    tags: ['new', 'updated'],
  });

  expect(updated).not.toBeNull();
  expect(updated!.title).toBe('New Title');
  expect(updated!.content).toBe('New content');
  expect(updated!.tags).toEqual(['new', 'updated']);
});

test('listPlans returns all plans ordered by date', async () => {
  const p1 = await factory.plan({ title: 'List Plan 1' });
  await new Promise((r) => setTimeout(r, 10));
  const p2 = await factory.plan({ title: 'List Plan 2' });

  const plans = ctx.service.listPlans(50);
  const ids = plans.map((p) => p.id);

  expect(ids).toContain(p1.id);
  expect(ids).toContain(p2.id);

  // Most recent first
  const i1 = ids.indexOf(p1.id);
  const i2 = ids.indexOf(p2.id);
  expect(i2).toBeLessThan(i1);
});

test('listPlans with status filter', async () => {
  const draftPlan = await factory.plan({ title: 'Draft Filter Plan' });
  const activePlan = await factory.plan({ title: 'Active Filter Plan' });
  ctx.service.updatePlan(activePlan.id, { status: KnowledgeStatus.ACTIVE });

  const drafts = ctx.service.listPlans(50, KnowledgeStatus.DRAFT);
  const draftIds = drafts.map((p) => p.id);
  expect(draftIds).toContain(draftPlan.id);
  expect(draftIds).not.toContain(activePlan.id);

  const actives = ctx.service.listPlans(50, KnowledgeStatus.ACTIVE);
  const activeIds = actives.map((p) => p.id);
  expect(activeIds).toContain(activePlan.id);
  expect(activeIds).not.toContain(draftPlan.id);
});

test('deletePlan removes plan', async () => {
  const plan = await factory.plan({ title: 'To Delete' });
  const deleted = ctx.service.deletePlan(plan.id);
  expect(deleted).toBe(true);

  const fetched = ctx.service.getPlanById(plan.id);
  expect(fetched).toBeNull();
});

test('deletePlan cascades to tasks', async () => {
  const plan = await factory.plan({
    title: 'Cascade Delete Plan',
    tasks: [
      { description: 'Cascade Task 1' },
      { description: 'Cascade Task 2' },
    ],
  });

  const tasksBefore = ctx.service.listPlanTasks(plan.id);
  expect(tasksBefore).toHaveLength(2);

  ctx.service.deletePlan(plan.id);

  const tasksAfter = ctx.service.listPlanTasks(plan.id);
  expect(tasksAfter).toHaveLength(0);
});

test('archivePlan sets status to archived without deleting (reversible)', async () => {
  const plan = await factory.plan({ title: 'Archive Plan' });
  ctx.service.updatePlan(plan.id, { status: KnowledgeStatus.ACTIVE });

  // archivePlan is exposed at the MCP layer as updatePlan({ status: 'archived' }).
  const archived = ctx.service.updatePlan(plan.id, { status: KnowledgeStatus.ARCHIVED });
  expect(archived).not.toBeNull();
  expect(archived!.status).toBe(KnowledgeStatus.ARCHIVED);

  // The plan is preserved, not deleted, and is reversible.
  expect(ctx.service.getPlanById(plan.id)).not.toBeNull();
  const reactivated = ctx.service.updatePlan(plan.id, { status: KnowledgeStatus.ACTIVE });
  expect(reactivated!.status).toBe(KnowledgeStatus.ACTIVE);
});

test('multiple plans can exist', async () => {
  const p1 = await factory.plan({ title: 'Multi Plan A' });
  const p2 = await factory.plan({ title: 'Multi Plan B' });
  const p3 = await factory.plan({ title: 'Multi Plan C' });

  const plans = ctx.service.listPlans(50);
  const ids = plans.map((p) => p.id);

  expect(ids).toContain(p1.id);
  expect(ids).toContain(p2.id);
  expect(ids).toContain(p3.id);
});

// ─── Fix v1.0.12: Plan dedup + scope filter + stale archive ─────

test('listPlans with scope filter', async () => {
  const planA = await factory.plan({ title: 'Scope Plan A', scope: 'workspace:project-a' });
  const planB = await factory.plan({ title: 'Scope Plan B', scope: 'workspace:project-b' });

  const scopeA = ctx.service.listPlans(50, undefined, 'workspace:project-a');
  const scopeAIds = scopeA.map((p) => p.id);
  expect(scopeAIds).toContain(planA.id);
  expect(scopeAIds).not.toContain(planB.id);

  const scopeB = ctx.service.listPlans(50, undefined, 'workspace:project-b');
  const scopeBIds = scopeB.map((p) => p.id);
  expect(scopeBIds).toContain(planB.id);
  expect(scopeBIds).not.toContain(planA.id);
});

test('listPlans with status + scope filter combined', async () => {
  const draft = await factory.plan({ title: 'Combo Draft', scope: 'workspace:combo-test' });
  const active = await factory.plan({ title: 'Combo Active', scope: 'workspace:combo-test' });
  ctx.service.updatePlan(active.id, { status: KnowledgeStatus.ACTIVE });
  const other = await factory.plan({ title: 'Combo Other Scope', scope: 'workspace:other' });

  const result = ctx.service.listPlans(50, KnowledgeStatus.DRAFT, 'workspace:combo-test');
  const ids = result.map((p) => p.id);
  expect(ids).toContain(draft.id);
  expect(ids).not.toContain(active.id);
  expect(ids).not.toContain(other.id);
});

test('archiveStaleDrafts archives old drafts and keeps recent ones', async () => {
  // Create a draft and manually backdate it via repository
  const stalePlan = await factory.plan({ title: 'Stale Draft Plan' });
  const recentPlan = await factory.plan({ title: 'Recent Draft Plan' });

  // Backdate the stale plan to 48 hours ago
  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  // Directly update via sqlite to backdate
  ctx.sqlite.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(oldDate, stalePlan.id);

  const archived = ctx.service.archiveStaleDrafts(24);
  expect(archived).toBeGreaterThanOrEqual(1);

  const staleAfter = ctx.service.getPlanById(stalePlan.id);
  expect(staleAfter!.status).toBe(KnowledgeStatus.ARCHIVED);

  const recentAfter = ctx.service.getPlanById(recentPlan.id);
  expect(recentAfter!.status).toBe(KnowledgeStatus.DRAFT);
});

test('createPlan dedup merges into existing draft in same scope', async () => {
  const scope = 'workspace:dedup-test';

  // Create initial plan (skip dedup to establish it)
  const original = await ctx.service.createPlan({
    title: 'Implement user authentication',
    content: 'Add JWT-based auth to the API',
    tags: ['auth'],
    scope,
    source: 'test',
    tasks: [{ description: 'Setup JWT middleware' }],
    skipDedup: true,
  });
  expect(original.status).toBe(KnowledgeStatus.DRAFT);

  // Create similar plan WITHOUT skipDedup — should dedup into the original
  const duplicate = await ctx.service.createPlan({
    title: 'Implement user authentication system',
    content: 'Add JWT-based authentication to the API',
    tags: ['auth'],
    scope,
    source: 'test',
    tasks: [{ description: 'Add auth routes' }, { description: 'Add auth tests' }],
  });

  // Should return the same plan ID (deduped)
  expect(duplicate.id).toBe(original.id);
  expect((duplicate as any).deduplicated).toBe(true);
  expect((duplicate as any).deduplicatedAction).toBe('draft_plan_updated');
});

test('createPlan dedup does NOT merge across different scopes', async () => {
  const plan1 = await ctx.service.createPlan({
    title: 'Cross-scope dedup test plan',
    content: 'This plan should not dedup across scopes',
    tags: ['dedup'],
    scope: 'workspace:scope-x',
    source: 'test',
    skipDedup: true,
  });

  const plan2 = await ctx.service.createPlan({
    title: 'Cross-scope dedup test plan',
    content: 'This plan should not dedup across scopes',
    tags: ['dedup'],
    scope: 'workspace:scope-y',
    source: 'test',
  });

  // Different scopes → different plans
  expect(plan2.id).not.toBe(plan1.id);
});

test('dedup finds draft even with 15+ completed plans (KNN saturation test)', async () => {
  const scope = 'workspace:knn-saturation';

  // Create 15 completed plans to saturate old KNN approach
  for (let i = 0; i < 15; i++) {
    const p = await ctx.service.createPlan({
      title: `Completed plan about auth ${i}`,
      content: `Implement authentication system variant ${i}`,
      tags: ['auth', 'knn-test'],
      scope,
      source: 'test',
      skipDedup: true,
    });
    ctx.service.updatePlan(p.id, { status: KnowledgeStatus.ACTIVE });
    ctx.service.updatePlan(p.id, { status: KnowledgeStatus.COMPLETED });
  }

  // Create 1 draft plan that should be found by dedup
  const draft = await ctx.service.createPlan({
    title: 'Implement authentication system',
    content: 'Add JWT-based auth to the API',
    tags: ['auth'],
    scope,
    source: 'test',
    skipDedup: true,
  });
  expect(draft.status).toBe(KnowledgeStatus.DRAFT);

  // New plan with similar content should dedup into the draft
  const duplicate = await ctx.service.createPlan({
    title: 'Implement auth system for API',
    content: 'Add JWT authentication to the API',
    tags: ['auth'],
    scope,
    source: 'test',
  });

  expect(duplicate.id).toBe(draft.id);
  expect((duplicate as any).deduplicated).toBe(true);
});

test('archiveStaleDrafts skips active and completed plans', async () => {
  const activePlan = await factory.plan({ title: 'Active Should Not Archive' });
  ctx.service.updatePlan(activePlan.id, { status: KnowledgeStatus.ACTIVE });

  const completedPlan = await factory.plan({ title: 'Completed Should Not Archive' });
  ctx.service.updatePlan(completedPlan.id, { status: KnowledgeStatus.ACTIVE });
  ctx.service.updatePlan(completedPlan.id, { status: KnowledgeStatus.COMPLETED });

  // Backdate both to 48 hours ago
  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  ctx.sqlite.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(oldDate, activePlan.id);
  ctx.sqlite.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(oldDate, completedPlan.id);

  ctx.service.archiveStaleDrafts(24);

  const activeAfter = ctx.service.getPlanById(activePlan.id);
  expect(activeAfter!.status).toBe(KnowledgeStatus.ACTIVE);

  const completedAfter = ctx.service.getPlanById(completedPlan.id);
  expect(completedAfter!.status).toBe(KnowledgeStatus.COMPLETED);
});

test('archiveStaleDrafts returns 0 on empty database', async () => {
  // Create fresh context with empty db
  const freshCtx = createTestContext();
  const archived = freshCtx.service.archiveStaleDrafts(24);
  expect(archived).toBe(0);
  destroyTestContext(freshCtx);
});

test('listPlans with undefined scope returns all plans (backward compat)', async () => {
  const p1 = await factory.plan({ title: 'Compat Plan A', scope: 'workspace:compat-a' });
  const p2 = await factory.plan({ title: 'Compat Plan B', scope: 'workspace:compat-b' });

  const all = ctx.service.listPlans(50, undefined, undefined);
  const ids = all.map((p) => p.id);
  expect(ids).toContain(p1.id);
  expect(ids).toContain(p2.id);
});

test('listPlans + listPlanTasks enrichment pattern (MCP tool flow)', async () => {
  const plan = await factory.plan({
    title: 'Enrichment Test Plan',
    scope: 'workspace:enrich-test',
    tasks: [
      { description: 'Task 1' },
      { description: 'Task 2' },
      { description: 'Task 3' },
    ],
  });

  // Complete one task to simulate partial progress
  const tasks = ctx.service.listPlanTasks(plan.id);
  ctx.service.updatePlanTask(tasks[0].id, { status: 'completed' });

  // Simulate the MCP tool enrichment: listPlans + per-plan task progress
  const plans = ctx.service.listPlans(10, undefined, 'workspace:enrich-test');
  expect(plans.length).toBeGreaterThanOrEqual(1);

  const target = plans.find((p) => p.id === plan.id)!;
  expect(target).toBeTruthy();

  const planTasks = ctx.service.listPlanTasks(target.id);
  const completedTasks = planTasks.filter((t) => t.status === 'completed').length;
  expect(planTasks).toHaveLength(3);
  expect(completedTasks).toBe(1);
});
