import { test, expect } from '@playwright/test';
import { ProviderManager } from '@cognistore/providers';
import type { KnowledgeProvider, ExternalResult } from '@cognistore/providers';
import type { FederatedProviderSource, ExternalSection } from '@cognistore/shared';
import { createTestContext, destroyTestContext, createFactory } from '../test-helpers.js';

function fake(
  id: string,
  opts: { enabled?: boolean; results?: ExternalResult[]; delayMs?: number; throwError?: string } = {},
): KnowledgeProvider {
  return {
    id,
    name: `Provider ${id}`,
    kind: 'http',
    enabled: opts.enabled ?? true,
    async search(_q, _k, signal) {
      if (signal.aborted) throw (signal.reason ?? new Error('aborted'));
      if (opts.throwError) throw new Error(opts.throwError);
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs);
          signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
        });
      }
      return opts.results ?? [{ title: id, content: `content from ${id}` }];
    },
  };
}

test('fanOut: happy path returns one section per enabled provider', async () => {
  const mgr = new ProviderManager([
    fake('a', { results: [{ title: 'A1', content: 'x' }] }),
    fake('b', { results: [{ title: 'B1', content: 'y' }, { title: 'B2', content: 'z' }] }),
  ]);
  const sections = await mgr.fanOut('q', 10, 1000);
  expect(sections.map((s) => s.providerId).sort()).toEqual(['a', 'b']);
  expect(sections.every((s) => s.error === undefined)).toBe(true);
  expect(sections.find((s) => s.providerId === 'b')!.results).toHaveLength(2);
});

test('fanOut: a throwing provider is isolated (others still return)', async () => {
  const mgr = new ProviderManager([
    fake('ok', { results: [{ title: 'ok', content: 'c' }] }),
    fake('bad', { throwError: 'boom' }),
  ]);
  const sections = await mgr.fanOut('q', 10, 1000);
  const bad = sections.find((s) => s.providerId === 'bad')!;
  const ok = sections.find((s) => s.providerId === 'ok')!;
  expect(bad.error).toContain('boom');
  expect(bad.results).toHaveLength(0);
  expect(ok.error).toBeUndefined();
  expect(ok.results).toHaveLength(1);
});

test('fanOut: a slow provider times out without affecting others', async () => {
  const mgr = new ProviderManager([
    fake('fast', { results: [{ title: 'f', content: 'c' }] }),
    fake('slow', { delayMs: 5000 }),
  ]);
  const start = Date.now();
  const sections = await mgr.fanOut('q', 10, 50);
  expect(Date.now() - start).toBeLessThan(2000); // did not wait for the 5s provider
  const slow = sections.find((s) => s.providerId === 'slow')!;
  expect(slow.error).toContain('timeout');
  expect(sections.find((s) => s.providerId === 'fast')!.results).toHaveLength(1);
});

test('fanOut: a parent AbortSignal aborts all in-flight providers', async () => {
  const mgr = new ProviderManager([fake('a', { delayMs: 5000 }), fake('b', { delayMs: 5000 })]);
  const ctrl = new AbortController();
  ctrl.abort();
  const sections = await mgr.fanOut('q', 10, 5000, ctrl.signal);
  expect(sections).toHaveLength(2);
  expect(sections.every((s) => s.error && s.results.length === 0)).toBe(true);
});

test('fanOut: disabled providers are skipped', async () => {
  const mgr = new ProviderManager([fake('on', {}), fake('off', { enabled: false })]);
  const sections = await mgr.fanOut('q', 10, 1000);
  expect(sections.map((s) => s.providerId)).toEqual(['on']);
});

test('fanOut: results are sliced to k and oversized content is capped', async () => {
  const big = 'x'.repeat(20 * 1024);
  const mgr = new ProviderManager([
    fake('p', { results: [
      { title: '1', content: big }, { title: '2', content: 'b' }, { title: '3', content: 'c' },
    ] }),
  ]);
  const [section] = await mgr.fanOut('q', 2, 1000);
  expect(section.results).toHaveLength(2);              // sliced to k=2
  expect(section.results[0].content.length).toBeLessThanOrEqual(8 * 1024 + 1); // capped (+ ellipsis)
});

test('subset restricts to the given provider ids', async () => {
  const mgr = new ProviderManager([fake('a', {}), fake('b', {}), fake('c', {})]);
  const sections = await mgr.subset(['a', 'c']).fanOut('q', 10, 1000);
  expect(sections.map((s) => s.providerId).sort()).toEqual(['a', 'c']);
});

test('searchFederated: composes local results + external sections', async () => {
  const ctx = createTestContext();
  try {
    const factory = createFactory(ctx.service);
    await factory.knowledge({ title: 'Local note', content: 'alpha beta gamma' });

    const source: FederatedProviderSource = {
      async fanOut(): Promise<ExternalSection[]> {
        return [{ providerId: 'ext', providerName: 'Ext', results: [{ title: 'E', content: 'ext content' }], tookMs: 1 }];
      },
    };
    const fed = await ctx.service.searchFederated('alpha', { limit: 5 }, source);
    expect(Array.isArray(fed.local)).toBe(true);
    expect(fed.external).toHaveLength(1);
    expect(fed.external[0].providerId).toBe('ext');

    // No source → external is empty, local still returned.
    const localOnly = await ctx.service.searchFederated('alpha', { limit: 5 });
    expect(localOnly.external).toEqual([]);
  } finally {
    destroyTestContext(ctx);
  }
});
