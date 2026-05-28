import type { SearchResult } from './knowledge.js';

/** A single result returned by an external knowledge provider. */
export interface ExternalResult {
  title: string;
  content: string;
  url?: string;
  /** Provider-reported relevance (0..1). NOT comparable to local cosine similarity. */
  score?: number;
  metadata?: Record<string, unknown>;
}

/** Results from one external provider for a single federated search. */
export interface ExternalSection {
  providerId: string;
  providerName: string;
  results: ExternalResult[];
  /** Present (with results = []) when the provider failed or timed out. */
  error?: string;
  tookMs: number;
}

/** Local results (ranked by cosine) plus one section per external provider. */
export interface FederatedSearchResult {
  local: SearchResult[];
  external: ExternalSection[];
}

/**
 * Fan-out source for federated search. Implemented by `ProviderManager` in
 * `@cognistore/providers`. Declared here so `@cognistore/core` can depend on it
 * via `@cognistore/shared` without a cycle into the providers package.
 */
export interface FederatedProviderSource {
  fanOut(
    query: string,
    k: number,
    perProviderTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExternalSection[]>;
}
