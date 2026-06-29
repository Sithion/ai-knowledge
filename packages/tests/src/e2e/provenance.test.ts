import { test, expect } from '@playwright/test';
import { createTestContext, destroyTestContext, type TestContext } from '../test-helpers.js';
import { KnowledgeType } from '@cognistore/shared';

// Each test gets an isolated temp DB so aggregation counts only reflect what it inserts.
let ctx: TestContext;
test.beforeEach(() => { ctx = createTestContext(); });
test.afterEach(() => { destroyTestContext(ctx); });

async function add(overrides: { content: string; agentId?: string | null; platform?: string | null }) {
  return ctx.service.add({
    title: overrides.content,
    content: overrides.content,
    tags: ['provenance-test'],
    type: KnowledgeType.PATTERN,
    scope: 'global',
    source: 'test',
    skipDedup: true,
    agentId: overrides.agentId,
    platform: overrides.platform,
  });
}

test('addKnowledge persists platform and agentId; NULL when omitted', async () => {
  const withProv = await add({ content: 'entry one', agentId: 'documentation', platform: 'claude-code' });
  expect(withProv.agentId).toBe('documentation');
  expect(withProv.platform).toBe('claude-code');

  const without = await add({ content: 'entry two' });
  expect(without.agentId ?? null).toBeNull();
  expect(without.platform ?? null).toBeNull();
});

test('countByPlatform collapses NULL and literal "unknown" into one bucket', async () => {
  await add({ content: 'p-null' });                          // platform NULL
  await add({ content: 'p-literal', platform: 'unknown' });  // literal "unknown" (MCP resolver path)
  await add({ content: 'p-claude', platform: 'claude-code' });

  const rows = await ctx.service.countByPlatform();
  const map = Object.fromEntries(rows.map((r) => [r.platform, r.count]));
  expect(map['unknown']).toBe(2); // NULL + literal merged
  expect(map['claude-code']).toBe(1);
});

test('countByAgent buckets NULL agent as "unspecified"', async () => {
  await add({ content: 'a-null' });                         // agent NULL
  await add({ content: 'a-doc-1', agentId: 'documentation' });
  await add({ content: 'a-doc-2', agentId: 'documentation' });

  const rows = await ctx.service.countByAgent();
  const map = Object.fromEntries(rows.map((r) => [r.agent, r.count]));
  expect(map['unspecified']).toBe(1);
  expect(map['documentation']).toBe(2);
});

test('listRecent round-trips sentinel filters back to NULL', async () => {
  await add({ content: 'l-null' });                          // platform NULL, agent NULL
  await add({ content: 'l-literal', platform: 'unknown' });  // literal "unknown"
  await add({ content: 'l-claude', platform: 'claude-code', agentId: 'documentation' });

  // platform="unknown" → NULL + literal "unknown"
  const unknownPlatform = await ctx.service.listRecent(50, { platform: 'unknown' });
  expect(unknownPlatform.map((e) => e.content).sort()).toEqual(['l-literal', 'l-null']);

  // platform="claude-code" → only the literal match
  const claude = await ctx.service.listRecent(50, { platform: 'claude-code' });
  expect(claude.map((e) => e.content)).toEqual(['l-claude']);

  // agent="unspecified" → NULL-agent rows
  const unspecified = await ctx.service.listRecent(50, { agent: 'unspecified' });
  expect(unspecified.map((e) => e.content).sort()).toEqual(['l-literal', 'l-null']);

  // agent="documentation" → exact match
  const doc = await ctx.service.listRecent(50, { agent: 'documentation' });
  expect(doc.map((e) => e.content)).toEqual(['l-claude']);
});

test('dedup re-add preserves existing provenance when omitted (no wipe)', async () => {
  // First write records provenance.
  const first = await ctx.service.add({
    title: 'Dedup provenance entry',
    content: 'a very specific unique sentence about dedup provenance preservation',
    tags: ['provenance-test'],
    type: KnowledgeType.PATTERN,
    scope: 'global',
    source: 'test',
    agentId: 'documentation',
    platform: 'claude-code',
  });
  expect(first.agentId).toBe('documentation');

  // Re-add near-identical content WITHOUT skipDedup and WITHOUT provenance → must NOT wipe.
  const second = await ctx.service.add({
    title: 'Dedup provenance entry',
    content: 'a very specific unique sentence about dedup provenance preservation',
    tags: ['provenance-test'],
    type: KnowledgeType.PATTERN,
    scope: 'global',
    source: 'test',
  });
  expect((second as { deduplicated?: boolean }).deduplicated).toBe(true);
  expect(second.id).toBe(first.id);
  expect(second.agentId).toBe('documentation'); // preserved
  expect(second.platform).toBe('claude-code');  // preserved

  // Re-add WITH a new agent → last-non-null-wins.
  const third = await ctx.service.add({
    title: 'Dedup provenance entry',
    content: 'a very specific unique sentence about dedup provenance preservation',
    tags: ['provenance-test'],
    type: KnowledgeType.PATTERN,
    scope: 'global',
    source: 'test',
    agentId: 'code-reviewer',
  });
  expect(third.agentId).toBe('code-reviewer');
  expect(third.platform).toBe('claude-code'); // still preserved (not re-supplied)
});

test('createPlan persists agentId and platform', async () => {
  const plan = await ctx.service.createPlan({
    title: 'Provenance Plan',
    content: 'plan body',
    tags: ['provenance-test'],
    scope: 'global',
    source: 'test',
    agentId: 'documentation',
    platform: 'copilot',
    skipDedup: true,
  });
  expect(plan.agentId).toBe('documentation');
  expect(plan.platform).toBe('copilot');
});
