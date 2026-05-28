import type { ExternalResult, ExternalSection, FederatedProviderSource } from '@cognistore/shared';
import type { KnowledgeProvider } from './types.js';

/** Per-result content cap and per-section total cap (anti-bloat / anti-injection). */
const MAX_RESULT_CONTENT_CHARS = 8 * 1024;
const MAX_SECTION_CHARS = 64 * 1024;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Truncate over-long content and drop results once the section budget is exceeded. */
function capSizes(results: ExternalResult[]): ExternalResult[] {
  let total = 0;
  const out: ExternalResult[] = [];
  for (const r of results) {
    const content =
      r.content.length > MAX_RESULT_CONTENT_CHARS
        ? r.content.slice(0, MAX_RESULT_CONTENT_CHARS) + '…'
        : r.content;
    const size = content.length + (r.title?.length ?? 0);
    if (total + size > MAX_SECTION_CHARS) break;
    total += size;
    out.push({ ...r, content });
  }
  return out;
}

/**
 * Holds the set of configured providers and fans a query out to the enabled ones.
 * Failure isolation is the core guarantee: a slow/failing/aborting provider can
 * never block or break the others (or local results).
 */
export class ProviderManager implements FederatedProviderSource {
  constructor(private readonly providers: KnowledgeProvider[]) {}

  list(): readonly KnowledgeProvider[] {
    return this.providers;
  }

  getProvider(id: string): KnowledgeProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  /** A manager restricted to the given provider ids (per-query allow-list). */
  subset(ids: string[]): ProviderManager {
    const set = new Set(ids);
    return new ProviderManager(this.providers.filter((p) => set.has(p.id)));
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.providers.map((p) => p.dispose?.()));
  }

  async fanOut(
    query: string,
    k: number,
    perProviderTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExternalSection[]> {
    const enabled = this.providers.filter((p) => p.enabled);
    return Promise.all(enabled.map((p) => this.runOne(p, query, k, perProviderTimeoutMs, signal)));
  }

  private async runOne(
    p: KnowledgeProvider,
    query: string,
    k: number,
    timeoutMs: number,
    parentSignal?: AbortSignal,
  ): Promise<ExternalSection> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (parentSignal) {
      if (parentSignal.aborted) ctrl.abort();
      else parentSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const start = Date.now();
    try {
      const raw = await p.search(query, k, ctrl.signal);
      return {
        providerId: p.id,
        providerName: p.name,
        results: capSizes(raw.slice(0, k)),
        tookMs: Date.now() - start,
      };
    } catch (e) {
      return {
        providerId: p.id,
        providerName: p.name,
        results: [],
        error: ctrl.signal.aborted && !errMsg(e).includes('timeout') ? 'aborted' : errMsg(e),
        tookMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
    }
  }
}
