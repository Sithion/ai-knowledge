import { test, expect } from '@playwright/test';
import { updatePlanSchema, createPlanTaskSchema, updatePlanTaskSchema, mergeTagsBatchSchema } from '@cognistore/shared';

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
