import { test, expect } from '@playwright/test';
import { createTestContext, destroyTestContext, createFactory, type TestContext } from '../test-helpers.js';
import { deleteEmbedding, insertEmbedding } from '@cognistore/core';
import { KnowledgeType, DEFAULT_EMBEDDING_DIMENSIONS } from '@cognistore/shared';

/**
 * Regression cover for the v2.5.2 embedding-integrity rewrite.
 *
 * The bug this replaces: the upgrade compared COUNT(knowledge_entries) with
 * COUNT(knowledge_embeddings_rowids) and repaired via reembedAll(), which
 * iterates a query that EXCLUDES type='system'. The counts could therefore
 * never agree, so every upgrade dropped and rebuilt the whole vector index —
 * and left it empty whenever the run was interrupted. Each test below pins one
 * property that makes that impossible to reintroduce.
 */

let ctx: TestContext;
let factory: ReturnType<typeof createFactory>;

test.beforeEach(() => {
  ctx = createTestContext();
  factory = createFactory(ctx.service);
});
test.afterEach(() => {
  destroyTestContext(ctx);
});

const embeddingCount = () =>
  (ctx.sqlite.prepare('SELECT COUNT(*) c FROM knowledge_embeddings_rowids').get() as { c: number }).c;

test('coverage converges to zero for a type:"system" entry — the permanent off-by-one', async () => {
  await factory.knowledge({ type: KnowledgeType.SYSTEM, tags: ['system'], content: 'System-owned entry' });
  await factory.knowledge({ content: 'An ordinary entry' });

  // Everything the writers created is already covered.
  expect(await ctx.service.embeddingCoverage()).toMatchObject({ missingEntries: 0, missingPlans: 0 });

  // Simulate the wiped index and repair it.
  ctx.sqlite.exec('DELETE FROM knowledge_embeddings');
  expect((await ctx.service.embeddingCoverage()).missingEntries).toBe(2);

  const result = await ctx.service.embedMissing();
  expect(result.embedded).toBe(2);
  expect(result.failed).toBe(0);
  // The whole point: `remaining` reaches 0 even though one entry is type:'system'.
  expect(result.remaining).toBe(0);
  expect(await ctx.service.embeddingCoverage()).toMatchObject({ missingEntries: 0, missingPlans: 0 });
});

test('embedMissing only touches the missing ids and never drops the table', async () => {
  const keep = await factory.knowledge({ content: 'Keeps its original embedding' });
  const lost = await factory.knowledge({ content: 'Lost its embedding somehow' });

  const before = ctx.sqlite
    .prepare('SELECT embedding FROM knowledge_embeddings WHERE id = ?')
    .get(keep.id) as { embedding: Buffer };

  deleteEmbedding(ctx.sqlite, lost.id);
  expect(embeddingCount()).toBe(1);
  expect((await ctx.service.embeddingCoverage()).missingEntries).toBe(1);

  const result = await ctx.service.embedMissing();
  expect(result.embedded).toBe(1); // exactly one — not a full rebuild
  expect(embeddingCount()).toBe(2);

  const after = ctx.sqlite
    .prepare('SELECT embedding FROM knowledge_embeddings WHERE id = ?')
    .get(keep.id) as { embedding: Buffer };
  expect(Buffer.compare(before.embedding, after.embedding)).toBe(0);
});

test('embedMissing backfills plans as well as knowledge entries', async () => {
  await factory.plan({ title: 'A plan that lost its vector' });

  ctx.sqlite.exec('DELETE FROM plans_embeddings');
  const coverage = await ctx.service.embeddingCoverage();
  expect(coverage.missingPlans).toBe(1);

  const result = await ctx.service.embedMissing();
  expect(result.remaining).toBe(0);
  expect((await ctx.service.embeddingCoverage()).missingPlans).toBe(0);
});

test('coverage is a LEFT JOIN, so an orphan embedding cannot mask a missing one', async () => {
  const a = await factory.knowledge({ content: 'Entry A' });
  await factory.knowledge({ content: 'Entry B' });

  // One real entry loses its vector; a vector for a long-deleted entry lingers.
  // Counts alone would net out to "0 missing" and skip the repair entirely.
  deleteEmbedding(ctx.sqlite, a.id);
  insertEmbedding(ctx.sqlite, 'orphan-id-with-no-entry', new Array(DEFAULT_EMBEDDING_DIMENSIONS).fill(0.1));

  const coverage = await ctx.service.embeddingCoverage();
  expect(coverage.entries).toBe(coverage.entryEmbeddings); // 2 === 2 — the trap
  expect(coverage.missingEntries).toBe(1);

  expect((await ctx.service.embedMissing()).embedded).toBe(1);
  expect((await ctx.service.embeddingCoverage()).missingEntries).toBe(0);
});

test('updating an entry whose embedding is missing re-inserts it instead of silently doing nothing', async () => {
  const entry = await factory.knowledge({ content: 'Original content' });
  deleteEmbedding(ctx.sqlite, entry.id);
  expect(embeddingCount()).toBe(0);

  await ctx.service.update(entry.id, { content: 'Rewritten content that must be searchable again' });

  expect(embeddingCount()).toBe(1);
  expect((await ctx.service.embeddingCoverage()).missingEntries).toBe(0);
});

test('a failed embedding leaves the id in the missing set so a re-run resumes it', async () => {
  const entry = await factory.knowledge({ content: 'Will fail to embed on the first pass' });
  deleteEmbedding(ctx.sqlite, entry.id);

  const provider = (ctx.service as unknown as { embeddingProvider: { embed: (t: string) => Promise<number[]> } })
    .embeddingProvider;
  const real = provider.embed.bind(provider);
  provider.embed = async () => { throw new Error('Ollama is down'); };

  const first = await ctx.service.embedMissing();
  expect(first.embedded).toBe(0);
  expect(first.failed).toBe(1);
  expect(first.remaining).toBe(1);

  provider.embed = real;

  const second = await ctx.service.embedMissing();
  expect(second.embedded).toBe(1);
  expect(second.failed).toBe(0);
  expect(second.remaining).toBe(0);
});
