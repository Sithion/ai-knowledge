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
  // URL.hostname wraps IPv6 in brackets — strip them before matching.
  const h = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();

  // IPv4 loopback / private
  if (h === 'localhost' || h === '127.0.0.1') return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;

  // IPv6 loopback (full and compressed forms)
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;

  // IPv4-mapped IPv6: ::ffff:<ipv4>
  // Node.js URL normalises these to hex — e.g. ::ffff:127.0.0.1 → ::ffff:7f00:1
  // Ranges: 127.x (7f), 10.x (a00:–aff:), 192.168.x (c0a8:), 172.16–31.x (ac1x:)
  if (h.startsWith('::ffff:')) {
    const mapped = h.slice(7);
    if (
      /^7f/.test(mapped) ||                  // 127.x.x.x
      /^a[0-9a-f]{2}:/.test(mapped) ||       // 10.x.x.x  (0x0a00–0x0aff)
      /^c0a8:/.test(mapped) ||               // 192.168.x.x
      /^ac1[0-9a-f]:/.test(mapped)           // 172.16–31.x.x (0xac10–0xac1f)
    ) return true;
  }

  // IPv6 unique-local (fc00::/7 — fc and fd prefixes)
  if (/^f[cd]/i.test(h)) return true;

  // IPv6 link-local (fe80::/10 — fe80..feb... but not fec+)
  if (/^fe[89ab]/i.test(h)) return true;

  return false;
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
    // Build the endpoint via the parsed URL object so the validated URL and the
    // fetch target are always in sync (string concat diverges for URLs with ? or #).
    u.pathname = u.pathname.replace(/\/+$/, '') + '/search';
    u.search = '';
    u.hash = '';
    return u.toString();
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
