import { test, expect } from '@playwright/test';
import { createTestContext, destroyTestContext, type TestContext } from '../test-helpers.js';
import { KnowledgeType } from '@cognistore/shared';

let ctx: TestContext;

test.beforeAll(() => { ctx = createTestContext(); });
test.afterAll(() => { destroyTestContext(ctx); });

// repository.create wraps entry + embedding insert in BEGIN IMMEDIATE: a failed
// embedding insert must roll back the entry row instead of leaving an orphan
// that semantic search can never find.
test('create() with a wrong-dimension embedding throws AND leaves no orphan row', async () => {
  const before = ctx.sqlite.prepare("SELECT COUNT(*) AS c FROM knowledge_entries WHERE type != 'system'").get() as { c: number };

  await expect(ctx.repository.create({
    title: 'orphan probe',
    content: 'should never persist',
    tags: ['txn'],
    type: KnowledgeType.PATTERN,
    scope: 'global',
    source: 'test',
    embedding: [0.1, 0.2, 0.3], // wrong dimensionality → vec0 insert throws
  })).rejects.toThrow();

  const after = ctx.sqlite.prepare("SELECT COUNT(*) AS c FROM knowledge_entries WHERE type != 'system'").get() as { c: number };
  expect(after.c).toBe(before.c); // rolled back — no orphan entry
  const orphan = ctx.sqlite.prepare("SELECT id FROM knowledge_entries WHERE title = 'orphan probe'").get();
  expect(orphan).toBeFalsy();
});

test('create() still works normally after a rolled-back attempt', async () => {
  const entry = await ctx.service.add({
    title: 'post-rollback entry',
    content: 'normal add after a failed create',
    tags: ['txn'],
    type: KnowledgeType.PATTERN,
    scope: 'global',
    source: 'test',
    skipDedup: true,
  });
  expect(entry.id).toBeTruthy();
  const emb = ctx.sqlite.prepare('SELECT id FROM knowledge_embeddings WHERE id = ?').get(entry.id);
  expect(emb).toBeTruthy();
});
