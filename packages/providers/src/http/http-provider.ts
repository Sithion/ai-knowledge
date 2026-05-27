import { z } from 'zod';
import type { ExternalResult } from '@cognistore/shared';
import type { KnowledgeProvider, ProviderKind } from '../types.js';
import type { ISecretStore } from '../secrets/secret-store.js';

/** Response shape an HTTP provider must return (contract v1). */
export const httpContractV1 = z.object({
  results: z
    .array(
      z.object({
        title: z.string(),
        content: z.string(),
        url: z.string().optional(),
        score: z.number().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
});

export interface HttpAuthConfig {
  type: 'none' | 'bearer' | 'header';
  headerName?: string;     // when type === 'header'
  secretRef?: string;      // keychain ref; required for bearer/header
}

export interface HttpProviderOptions {
  id: string;
  name: string;
  enabled: boolean;
  url: string;
  auth?: HttpAuthConfig;
  timeoutMs?: number;
  /** Dev/test escape hatch: permit http and loopback/private hosts (SSRF guard off). */
  allowInsecure?: boolean;
}

function isLoopbackOrPrivate(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

/** Queries any service implementing the documented HTTP contract (POST /search). */
export class HttpKnowledgeProvider implements KnowledgeProvider {
  readonly kind: ProviderKind = 'http';
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  private readonly url: string;
  private readonly auth: HttpAuthConfig;
  private readonly allowInsecure: boolean;
  private readonly secrets: ISecretStore;

  constructor(opts: HttpProviderOptions, secrets: ISecretStore) {
    this.id = opts.id;
    this.name = opts.name;
    this.enabled = opts.enabled;
    this.url = opts.url;
    this.auth = opts.auth ?? { type: 'none' };
    this.allowInsecure = opts.allowInsecure ?? false;
    this.secrets = secrets;
  }

  private endpoint(): string {
    const u = new URL(this.url);
    // SSRF / egress guard: require https and a non-private host unless explicitly allowed.
    if (!this.allowInsecure) {
      if (u.protocol !== 'https:') throw new Error(`refusing non-https provider URL (${u.protocol})`);
      if (isLoopbackOrPrivate(u.hostname)) throw new Error(`refusing loopback/private provider host (${u.hostname})`);
    }
    return this.url.replace(/\/+$/, '') + '/search';
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.auth.type === 'none') return {};
    const token = this.auth.secretRef ? await this.secrets.get(this.auth.secretRef) : null;
    if (!token) return {};
    if (this.auth.type === 'bearer') return { authorization: `Bearer ${token}` };
    return { [(this.auth.headerName ?? 'authorization').toLowerCase()]: token };
  }

  async search(query: string, k: number, signal: AbortSignal): Promise<ExternalResult[]> {
    const res = await fetch(this.endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await this.authHeaders()) },
      body: JSON.stringify({ query, k }),
      signal,
    });
    if (!res.ok) {
      let detail = '';
      try { const b = (await res.json()) as { error?: string }; detail = b?.error ?? ''; } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return httpContractV1.parse(await res.json()).results;
  }

  async testConnection(signal: AbortSignal): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.search('ping', 1, signal);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
