import { test, expect } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { createDbClient, KnowledgeRepository, KnowledgeService, type EmbeddingProvider, type SQLiteDatabase } from '@cognistore/core';
import { DEFAULT_EMBEDDING_DIMENSIONS, KnowledgeType } from '@cognistore/shared';

// Local context with an embed-call COUNTER so we can assert the union-once
// re-embedding guarantee of mergeTagsBatch.
let service: KnowledgeService;
let sqlite: SQLiteDatabase;
let dbPath: string;
let embedCalls: string[] = [];

function countingProvider(): EmbeddingProvider {
  const dims = DEFAULT_EMBEDDING_DIMENSIONS;
  return {
    async embed(text: string): Promise<number[]> {
      embedCalls.push(text);
      const vec = new Array(dims).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % dims] += text.charCodeAt(i) / 1000;
      const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / mag);
    },
  };
}

test.beforeAll(() => {
  dbPath = join(tmpdir(), `cognistore-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const { db, sqlite: s } = createDbClient(dbPath);
  sqlite = s;
  service = new KnowledgeService(new KnowledgeRepository(db, s), countingProvider());
});
test.afterAll(() => {
  try { sqlite.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(dbPath + suffix); } catch {} }
});

function add(tags: string[], n: number) {
  return service.add({
    title: `Entry ${n}`,
    content: `content ${n}`,
    tags,
    type: KnowledgeType.PATTERN,
    scope: 'global',
    source: 'test',
    skipDedup: true,
  });
}

test('chained merges a→b, b→c collapse to the terminal target', async () => {
  const ea = await add(['chain-a'], 1);
  const eb = await add(['chain-b'], 2);
  const ec = await add(['chain-c'], 3);

  const res = await service.mergeTagsBatch([
    { from: 'chain-a', to: 'chain-b' },
    { from: 'chain-b', to: 'chain-c' },
  ]);

  for (const id of [ea.id, eb.id, ec.id]) {
    const e = await service.getById(id);
    const chainTags = (e?.tags ?? []).filter((t) => t.startsWith('chain-'));
    expect(chainTags).toEqual(['chain-c']);
  }
  // applied reflects terminal targets: chain-a → chain-c (not chain-b)
  const a = res.applied.find((m) => m.from === 'chain-a');
  expect(a?.to).toBe('chain-c');
});

test('entry carrying both from-tags is re-embedded exactly once (union)', async () => {
  const both = await add(['union-x', 'union-y'], 4);
  const onlyX = await add(['union-x'], 5);

  embedCalls = [];
  const res = await service.mergeTagsBatch([
    { from: 'union-x', to: 'union-z' },
    { from: 'union-y', to: 'union-z' },
  ]);

  // 2 unique affected entries → exactly 2 re-embed calls, despite `both` matching twice.
  expect(res.entriesReembedded).toBe(2);
  expect(embedCalls.length).toBe(2);

  const e = await service.getById(both.id);
  expect(e?.tags).toContain('union-z');
  expect(e?.tags).not.toContain('union-x');
  expect(e?.tags).not.toContain('union-y');
  // json_group_array(DISTINCT) dedups the doubled target.
  expect((e?.tags ?? []).filter((t) => t === 'union-z')).toHaveLength(1);

  // New embeddings actually persisted via the UPDATE path (row exists in vec table
  // and version was bumped — catches an accidental insert-path swallow).
  const row = sqlite.prepare('SELECT id FROM knowledge_embeddings WHERE id = ?').get(both.id);
  expect(row).toBeTruthy();
  expect(e?.version).toBeGreaterThanOrEqual(2);
  const ex = await service.getById(onlyX.id);
  expect(ex?.version).toBeGreaterThanOrEqual(2);
});

test('duplicate from with different targets throws CONFLICT and leaves DB untouched', async () => {
  const e = await add(['dup-from'], 6);
  await expect(service.mergeTagsBatch([
    { from: 'dup-from', to: 'target-1' },
    { from: 'dup-from', to: 'target-2' },
  ])).rejects.toThrow(/^CONFLICT:/);
  // Pre-write conflict check: tag untouched.
  const after = await service.getById(e.id);
  expect(after?.tags).toContain('dup-from');
});

test('circular merge chain throws CONFLICT and leaves DB untouched', async () => {
  const e = await add(['cyc-a', 'cyc-b'], 7);
  await expect(service.mergeTagsBatch([
    { from: 'cyc-a', to: 'cyc-b' },
    { from: 'cyc-b', to: 'cyc-a' },
  ])).rejects.toThrow(/^CONFLICT:/);
  const after = await service.getById(e.id);
  expect(after?.tags).toEqual(expect.arrayContaining(['cyc-a', 'cyc-b']));
});

test('no-op and empty merges are filtered; empty input returns zeros', async () => {
  const res = await service.mergeTagsBatch([
    { from: 'same', to: 'same' },
    { from: '', to: 'x' },
    { from: ' x ', to: '' },
  ]);
  expect(res).toEqual({ applied: [], entriesReembedded: 0 });
});
