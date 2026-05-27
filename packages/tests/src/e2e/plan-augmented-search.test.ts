import { test, expect } from '@playwright/test';
import { createControlledContext, destroyTestContext, type TestContext } from '../test-helpers.js';
import { KnowledgeType, KnowledgeStatus, type SearchResult } from '@cognistore/shared';

// Feature 3 — plan-augmented retrieval. The query VEC[1,0,0] does NOT directly match
// the knowledge (embedded orthogonally as VEC[0,1,0]); it matches the PLAN, and the
// knowledge is surfaced via the plan's input/output relations.

let ctx: TestContext;
test.beforeAll(() => { ctx = createControlledContext(); });
test.afterAll(() => { destroyTestContext(ctx); });

const QUERY = 'VEC[1,0,0]';
const ORTHO = 'VEC[0,1,0]'; // cosine 0 vs QUERY → never a direct hit

async function makeKnowledge(scope: string, title: string) {
  return ctx.service.add({
    title, content: ORTHO, tags: ['k'], type: KnowledgeType.PATTERN, scope, source: 'test', skipDedup: true,
  });
}
async function makePlanMatchingQuery(scope: string, title: string) {
  return ctx.service.createPlan({ title, content: QUERY, tags: ['p'], scope, source: 'test', skipDedup: true });
}

test('surfaces output-linked knowledge via a similar plan (with provenance)', async () => {
  const scope = 'workspace:f3-output';
  const k = await makeKnowledge(scope, 'Output knowledge');
  const p = await makePlanMatchingQuery(scope, 'Matching plan');
  ctx.service.addPlanRelation(p.id, k.id, 'output');

  const results = await ctx.service.search(QUERY, { scope, threshold: 0.5, includePlanContext: true });
  const hit = results.find((r) => r.entry.id === k.id);
  expect(hit).toBeTruthy();
  expect(hit!.provenance?.viaPlanId).toBe(p.id);
  expect(hit!.provenance?.relationType).toBe('output');
});

test('includePlanContext:false (default) returns ONLY direct hits', async () => {
  const scope = 'workspace:f3-off';
  const k = await makeKnowledge(scope, 'Hidden knowledge');
  const p = await makePlanMatchingQuery(scope, 'Matching plan');
  ctx.service.addPlanRelation(p.id, k.id, 'output');

  const results = await ctx.service.search(QUERY, { scope, threshold: 0.5 });
  expect(results.find((r) => r.entry.id === k.id)).toBeFalsy();
});

test('both input and output linked knowledge are surfaced', async () => {
  const scope = 'workspace:f3-both';
  const kIn = await makeKnowledge(scope, 'Consulted knowledge');
  const kOut = await makeKnowledge(scope, 'Produced knowledge');
  const p = await makePlanMatchingQuery(scope, 'Matching plan');
  ctx.service.addPlanRelation(p.id, kIn.id, 'input');
  ctx.service.addPlanRelation(p.id, kOut.id, 'output');

  const results = await ctx.service.search(QUERY, { scope, threshold: 0.5, includePlanContext: true });
  const ids = results.map((r) => r.entry.id);
  expect(ids).toContain(kIn.id);
  expect(ids).toContain(kOut.id);
});

test('plan-sourced results are ranked AFTER direct hits and respect the budget cap', async () => {
  const scope = 'workspace:f3-budget';
  // One direct hit that matches the query.
  const direct = await ctx.service.add({
    title: 'Direct hit', content: QUERY, tags: ['k'], type: KnowledgeType.PATTERN, scope, source: 'test', skipDedup: true,
  });
  // Eight plan-linked (orthogonal) entries — more than PLAN_CONTEXT_EXTRA (5).
  const p = await makePlanMatchingQuery(scope, 'Matching plan');
  for (let i = 0; i < 8; i++) {
    const k = await makeKnowledge(scope, `Linked ${i}`);
    ctx.service.addPlanRelation(p.id, k.id, 'output');
  }

  const results: SearchResult[] = await ctx.service.search(QUERY, { scope, threshold: 0.5, includePlanContext: true });
  // Direct hit first, no provenance.
  expect(results[0].entry.id).toBe(direct.id);
  expect(results[0].provenance).toBeUndefined();
  // All plan-sourced extras come after the direct hit.
  const planSourced = results.filter((r) => r.provenance);
  expect(planSourced.length).toBeLessThanOrEqual(5);
  const firstPlanIdx = results.findIndex((r) => r.provenance);
  const lastDirectIdx = results.map((r) => !!r.provenance).lastIndexOf(false);
  expect(firstPlanIdx).toBeGreaterThan(lastDirectIdx);
});

test('findSimilarPlansAnyStatus finds COMPLETED plans (and global scope); active-only does not', async () => {
  const scope = 'workspace:f3-completed';
  const p = await makePlanMatchingQuery(scope, 'Completed plan');
  ctx.service.updatePlan(p.id, { status: KnowledgeStatus.ACTIVE });
  ctx.service.updatePlan(p.id, { status: KnowledgeStatus.COMPLETED });

  const queryVec = await (ctx.service as any).embeddingProvider.embed(QUERY);
  const anyStatus = ctx.repository.findSimilarPlansAnyStatus(queryVec, scope, 0.6, 5);
  expect(anyStatus.map((r) => r.plan.id)).toContain(p.id);

  const activeOnly = ctx.repository.findSimilarActivePlans(queryVec, scope, 0.6);
  expect(activeOnly.map((r) => r.plan.id)).not.toContain(p.id);
});
