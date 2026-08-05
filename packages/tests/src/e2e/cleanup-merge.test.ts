import { test, expect } from '@playwright/test';
import {
  computeMergedTags,
  validateMergeDraft,
  deterministicMergeDraft,
  MergeDraftError,
  type MergeMember,
} from '@cognistore/core';
import { buildMergeDraft } from '../../../../apps/dashboard/server/llm-merge.js';

/**
 * Merge policy (pure, in core) and the sidecar orchestration that prefers the
 * local model but must never depend on it.
 */

const member = (o: Partial<MergeMember> = {}): MergeMember => ({
  id: 'id-1',
  title: 'Title',
  content: 'content',
  tags: [],
  updatedAt: new Date('2026-01-01').toISOString(),
  ...o,
});

test.describe('@e2e computeMergedTags', () => {
  test('unions the members tags', () => {
    const tags = computeMergedTags([
      member({ tags: ['alpha', 'beta'] }),
      member({ tags: ['beta', 'gamma'] }),
    ]);
    expect(tags.sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('drops the cleanup control tags', () => {
    // Carrying `deprecated` forward would re-queue the survivor for deletion on
    // the next cycle; carrying `keep` would make it permanently immune.
    const tags = computeMergedTags([member({ tags: ['deprecated', 'keep', 'real'] })]);
    expect(tags).toEqual(['real']);
  });

  test('normalises case and ignores oversized or non-string tags', () => {
    const tags = computeMergedTags([
      member({ tags: ['MixedCase', 'x'.repeat(80), 42 as any, '  spaced  '] }),
    ]);
    expect(tags).toEqual(['mixedcase', 'spaced']);
  });

  test('caps the tag count', () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    expect(computeMergedTags([member({ tags: many })])).toHaveLength(20);
  });
});

test.describe('@e2e validateMergeDraft', () => {
  test('accepts and trims a well-formed draft', () => {
    expect(validateMergeDraft({ title: '  Merged  ', content: 'body' }))
      .toEqual({ title: 'Merged', content: 'body' });
  });

  test('rejects missing, empty or oversized fields', () => {
    expect(() => validateMergeDraft(null)).toThrow(MergeDraftError);
    expect(() => validateMergeDraft({ title: '', content: 'body' })).toThrow(/title/);
    expect(() => validateMergeDraft({ title: 'ok', content: '   ' })).toThrow(/content/);
    expect(() => validateMergeDraft({ title: 'x'.repeat(600), content: 'body' })).toThrow(/title/);
    expect(() => validateMergeDraft({ title: 'ok', content: 'x'.repeat(200_000) })).toThrow(/content/);
  });
});

test.describe('@e2e deterministicMergeDraft', () => {
  test('keeps the canonical verbatim and appends the others', () => {
    const draft = deterministicMergeDraft([
      member({ id: 'a', title: 'Canonical', content: 'canonical body' }),
      member({ id: 'b', title: 'Other', content: 'other body' }),
    ]);
    expect(draft.title).toBe('Canonical');
    expect(draft.content).toContain('canonical body');
    // Nothing may be lost: the members are deleted right after this is applied.
    expect(draft.content).toContain('other body');
    expect(draft.content).toContain('## Merged from duplicates');
  });

  test('a single member is returned unchanged', () => {
    const draft = deterministicMergeDraft([member({ title: 'Solo', content: 'solo body' })]);
    expect(draft).toEqual({ title: 'Solo', content: 'solo body' });
  });

  test('stays within the content limit for a huge group', () => {
    const big = Array.from({ length: 12 }, (_, i) =>
      member({ id: `id-${i}`, title: `T${i}`, content: 'x'.repeat(20_000) }));
    expect(deterministicMergeDraft(big).content.length).toBeLessThanOrEqual(100_000);
  });
});

test.describe('@e2e buildMergeDraft (sidecar orchestration)', () => {
  const members = [
    member({ id: 'a', title: 'Newer', content: 'newer body', tags: ['x'] }),
    member({ id: 'b', title: 'Older', content: 'older body', tags: ['y'] }),
  ];

  const fakeClient = (impl: Partial<{ ensureModel: () => Promise<void>; chatJson: () => Promise<any> }>) => ({
    ensureModel: impl.ensureModel ?? (async () => {}),
    chatJson: impl.chatJson ?? (async () => null),
    getModel: () => 'fake',
    isAvailable: async () => true,
  }) as any;

  test('uses the model output when it is valid', async () => {
    const result = await buildMergeDraft(members, {
      client: fakeClient({ chatJson: async () => ({ title: 'LLM merged', content: 'llm body' }) }),
    });
    expect(result.usedLlm).toBe(true);
    expect(result.draft).toEqual({ title: 'LLM merged', content: 'llm body' });
  });

  test('falls back deterministically when the model is unreachable', async () => {
    const result = await buildMergeDraft(members, { client: fakeClient({ chatJson: async () => null }) });
    expect(result.usedLlm).toBe(false);
    expect(result.draft.content).toContain('older body');
  });

  test('falls back when the model cannot be pulled', async () => {
    const result = await buildMergeDraft(members, {
      client: fakeClient({ ensureModel: async () => { throw new Error('offline'); } }),
    });
    expect(result.usedLlm).toBe(false);
    expect(result.draft.title).toBe('Newer');
  });

  test('retries once on a malformed response, then succeeds', async () => {
    let calls = 0;
    const result = await buildMergeDraft(members, {
      client: fakeClient({
        chatJson: async () => {
          calls++;
          return calls === 1 ? { nonsense: true } : { title: 'Second try', content: 'body' };
        },
      }),
    });
    expect(calls).toBe(2);
    expect(result.usedLlm).toBe(true);
    expect(result.draft.title).toBe('Second try');
  });

  test('falls back when the model keeps returning the wrong shape', async () => {
    const result = await buildMergeDraft(members, {
      client: fakeClient({ chatJson: async () => ({ title: 'only a title' }) }),
    });
    expect(result.usedLlm).toBe(false);
  });

  test('never lets the model choose tags', async () => {
    // Entry content is untrusted text going into a prompt. Even if the model is
    // talked into emitting control tags, they cannot reach the merged entry:
    // buildMergeDraft returns title/content only, and apply recomputes tags.
    const result = await buildMergeDraft(members, {
      client: fakeClient({
        chatJson: async () => ({ title: 'Merged', content: 'body', tags: ['keep', 'deprecated'] }),
      }),
    });
    expect(Object.keys(result.draft).sort()).toEqual(['content', 'title']);
  });
});
