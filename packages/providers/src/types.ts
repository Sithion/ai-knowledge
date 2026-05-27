import type { ExternalResult } from '@cognistore/shared';

export type { ExternalResult };

export type ProviderKind = 'mcp';

/** A pluggable external knowledge source queried during federated search. */
export interface KnowledgeProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly enabled: boolean;
  /** Return up to `k` results. MUST honour `signal` (abort on timeout/cancel). */
  search(query: string, k: number, signal: AbortSignal): Promise<ExternalResult[]>;
  /** Optional connectivity check used by the dashboard "Test" button. */
  testConnection?(signal: AbortSignal): Promise<{ ok: boolean; message?: string }>;
  /** Optional teardown (e.g. MCP closes its transport / child process). */
  dispose?(): Promise<void>;
}
