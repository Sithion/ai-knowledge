import { test, expect } from '@playwright/test';
import { createPlanSchema, updatePlanSchema, createPlanTaskSchema, updatePlanTaskSchema, mergeTagsBatchSchema } from '@cognistore/shared';

// Schema-level coverage for the zod validation the dashboard server applies to
// plan endpoints (PUT /api/plans/:id, POST /api/plans/:id/tasks,
// PUT /api/plans/tasks/:taskId) and the new POST /api/tags/merge-batch.
// Documented decision: packages/tests has no HTTP harness, so the endpoints'
// 400 behavior is exercised through the EXACT schemas the handlers call.

test('updatePlanSchema rejects a bogus status and accepts archived', () => {
  expect(updatePlanSchema.safeParse({ status: 'bogus' }).success).toBe(false);
  expect(updatePlanSchema.safeParse({ status: 'archived' }).success).toBe(true);
  // Everything the dashboard sends today passes:
  expect(updatePlanSchema.safeParse({ status: 'active' }).success).toBe(true);
  expect(updatePlanSchema.safeParse({ title: 'x', content: 'y' }).success).toBe(true);
});

test('updatePlanSchema strips unknown keys (zod default object behavior)', () => {
  const parsed = updatePlanSchema.safeParse({ status: 'completed', evil: 'field' });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect('evil' in parsed.data).toBe(false);
});

test('createPlanTaskSchema (omit planId — server injects it from the URL) rejects empty description', () => {
  const schema = createPlanTaskSchema.omit({ planId: true });
  expect(schema.safeParse({ description: '' }).success).toBe(false);
  expect(schema.safeParse({}).success).toBe(false);
  expect(schema.safeParse({ description: 'do it', priority: 'high' }).success).toBe(true);
});

test('updatePlanTaskSchema rejects negative position and accepts the dashboard payloads', () => {
  expect(updatePlanTaskSchema.safeParse({ position: -1 }).success).toBe(false);
  expect(updatePlanTaskSchema.safeParse({ status: 'in_progress' }).success).toBe(true);
  expect(updatePlanTaskSchema.safeParse({ notes: null }).success).toBe(true);
  expect(updatePlanTaskSchema.safeParse({ priority: 'medium' }).success).toBe(true);
  expect(updatePlanTaskSchema.safeParse({ status: 'nope' }).success).toBe(false);
});

test('mergeTagsBatchSchema bounds the batch (1..50, non-empty tags)', () => {
  expect(mergeTagsBatchSchema.safeParse({ merges: [] }).success).toBe(false);
  expect(mergeTagsBatchSchema.safeParse({ merges: [{ from: 'a', to: 'b' }] }).success).toBe(true);
  expect(mergeTagsBatchSchema.safeParse({ merges: [{ from: '', to: 'b' }] }).success).toBe(false);
  const tooMany = { merges: Array.from({ length: 51 }, (_, i) => ({ from: `a${i}`, to: 'b' })) };
  expect(mergeTagsBatchSchema.safeParse(tooMany).success).toBe(false);
});

// Lineage fields must be DECLARED in the schemas: zod strips undeclared keys at
// the SDK boundary, so an omission here would silently drop the parent link and
// the feature would fail with no error anywhere.
test('createPlanSchema keeps parentPlanId and stays tolerant of a malformed one', () => {
  const ok = createPlanSchema.safeParse({
    title: 'Linked plan',
    content: 'content',
    tags: ['t'],
    scope: 'global',
    source: 'test',
    parentPlanId: '11111111-2222-3333-4444-555555555555',
  });
  expect(ok.success).toBe(true);
  expect(ok.success && ok.data.parentPlanId).toBe('11111111-2222-3333-4444-555555555555');

  // Creating a plan must never fail over its parent reference: a model that
  // invents an id gets a root plus a lineageWarning from the service, not a lost
  // plan. So the schema bounds the value instead of rejecting it — the service
  // owns the "does it resolve?" policy for every entry point.
  const invented = createPlanSchema.safeParse({
    title: 'Linked plan',
    content: 'content',
    tags: ['t'],
    scope: 'global',
    source: 'test',
    parentPlanId: 'plan-3',
  });
  expect(invented.success).toBe(true);

  const oversized = createPlanSchema.safeParse({
    title: 'Linked plan',
    content: 'content',
    tags: ['t'],
    scope: 'global',
    source: 'test',
    parentPlanId: 'x'.repeat(65),
  });
  expect(oversized.success).toBe(false);
});

// updatePlan is the opposite policy on purpose: an explicit relink is a
// deliberate act, so a malformed id is rejected loudly rather than ignored.
test('updatePlanSchema keeps parentPlanId, allows null to unlink, and rejects a non-uuid', () => {
  const linked = updatePlanSchema.safeParse({ parentPlanId: '11111111-2222-3333-4444-555555555555' });
  expect(linked.success).toBe(true);
  expect(linked.success && linked.data.parentPlanId).toBe('11111111-2222-3333-4444-555555555555');

  const unlinked = updatePlanSchema.safeParse({ parentPlanId: null });
  expect(unlinked.success).toBe(true);
  expect(unlinked.success && unlinked.data.parentPlanId).toBeNull();

  expect(updatePlanSchema.safeParse({ parentPlanId: 'plan-3' }).success).toBe(false);
});
