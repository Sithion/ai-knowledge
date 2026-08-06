import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { ExternalResult } from '@cognistore/shared';
import type { KnowledgeProvider, ProviderKind } from '../types.js';
import type { ISecretStore } from '../secrets/secret-store.js';
import { guardRemoteMcpUrl, assertResolvesToPublicHost } from './url-guard.js';

type ClientTransport = Parameters<Client['connect']>[0];

export interface McpAuthConfig {
  type: 'none' | 'header' | 'oauth';
  headerName?: string;
  secretRef?: string;
  scopes?: string[];
  clientId?: string;
  allowInsecure?: boolean;
}

export interface McpProviderOptions {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http (Streamable HTTP)
  url?: string;
  auth?: McpAuthConfig;
  /** OAuth client provider for `auth.type === 'oauth'` (injected by the host; see oauth-provider.ts). */
  oauthProvider?: OAuthClientProvider;
  // query mapping
  mode?: 'tool' | 'resources';
  toolName?: string;
  argMapping?: Record<string, string>; // { query: 'query', k: 'limit' }
  resultPath?: string;                  // dot-path to a results array in tool JSON output
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as any)[key] : undefined), obj);
}

function toExternalResult(o: any): ExternalResult | null {
  if (!o || typeof o !== 'object') return null;
  const content = String(o.content ?? o.text ?? o.snippet ?? '');
  if (!content) return null;
  return {
    title: String(o.title ?? o.name ?? o.id ?? 'result'),
    content,
    url: typeof o.url === 'string' ? o.url : undefined,
    score: typeof o.score === 'number' ? o.score : undefined,
    metadata: o.metadata && typeof o.metadata === 'object' ? o.metadata : undefined,
  };
}

/** Queries another MCP server (CogniStore acts as an MCP client). */
export class McpKnowledgeProvider implements KnowledgeProvider {
  readonly kind: ProviderKind = 'mcp';
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private disposed = false;

  constructor(
    private readonly opts: McpProviderOptions,
    private readonly secrets: ISecretStore,
    private readonly transportOverride?: ClientTransport, // test seam (e.g. InMemoryTransport)
  ) {
    this.id = opts.id;
    this.name = opts.name;
    this.enabled = opts.enabled;
  }

  /** Static header auth (`auth.type === 'header'`). OAuth uses the SDK authProvider, not this. */
  private async authHeaders(): Promise<Record<string, string>> {
    const a = this.opts.auth;
    if (!a || a.type !== 'header') return {};
    const token = a.secretRef ? await this.secrets.get(a.secretRef) : null;
    if (!token) return {};
    return { [(a.headerName ?? 'authorization').toLowerCase()]: token };
  }

  private async buildTransport(): Promise<ClientTransport> {
    if (this.transportOverride) return this.transportOverride;
    if (this.opts.transport === 'stdio') {
      if (!this.opts.command) throw new Error('mcp stdio provider requires `command`');
      return new StdioClientTransport({ command: this.opts.command, args: this.opts.args ?? [], env: this.opts.env }) as ClientTransport;
    }
    if (!this.opts.url) throw new Error('mcp http provider requires `url`');
    // SSRF/egress guard: require https + public host unless allowInsecure (dev).
    const url = guardRemoteMcpUrl(this.opts.url, this.opts.auth?.allowInsecure);
    // ...and again after resolution: a public NAME can still answer with an
    // internal address (169.254.169.254 and friends).
    await assertResolvesToPublicHost(url.hostname, this.opts.auth?.allowInsecure);
    if (this.opts.auth?.type === 'oauth') {
      if (!this.opts.oauthProvider) throw new Error('mcp oauth provider requires an oauthProvider');
      return new StreamableHTTPClientTransport(url, { authProvider: this.opts.oauthProvider }) as ClientTransport;
    }
    const headers = await this.authHeaders();
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } }) as ClientTransport;
  }

  private async getClient(): Promise<Client> {
    if (this.disposed) throw new Error('McpKnowledgeProvider has been disposed');
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: 'cognistore', version: '1.0.0' });
      await client.connect(await this.buildTransport());
      // Guard: if dispose() was called while we were connecting, close immediately.
      if (this.disposed) {
        try { await client.close(); } catch { /* ignore */ }
        throw new Error('McpKnowledgeProvider was disposed during connect');
      }
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async search(query: string, k: number, signal: AbortSignal): Promise<ExternalResult[]> {
    const client = await this.getClient();
    return (this.opts.mode ?? 'tool') === 'resources'
      ? this.searchResources(client, k, signal)
      : this.searchTool(client, query, k, signal);
  }

  private async searchTool(client: Client, query: string, k: number, signal: AbortSignal): Promise<ExternalResult[]> {
    if (!this.opts.toolName) throw new Error('mcp tool-mode provider requires `toolName`');
    const mapping = this.opts.argMapping ?? { query: 'query', k: 'limit' };
    const args: Record<string, unknown> = {};
    if (mapping.query) args[mapping.query] = query;
    if (mapping.k) args[mapping.k] = k;
    const res = (await client.callTool({ name: this.opts.toolName, arguments: args }, undefined, { signal })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const textBlocks = (res.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text!);
    for (const t of textBlocks) {
      try {
        let parsed: unknown = JSON.parse(t);
        if (this.opts.resultPath) parsed = getPath(parsed, this.opts.resultPath);
        const arr = Array.isArray(parsed) ? parsed : (parsed as any)?.results;
        if (Array.isArray(arr)) return arr.map(toExternalResult).filter((r): r is ExternalResult => r != null).slice(0, k);
      } catch { /* not JSON — fall through */ }
    }
    return textBlocks.map((t, i) => ({ title: `${this.name} #${i + 1}`, content: t })).slice(0, k);
  }

  private async searchResources(client: Client, k: number, signal: AbortSignal): Promise<ExternalResult[]> {
    const { resources } = (await client.listResources(undefined, { signal })) as {
      resources: Array<{ uri: string; name?: string; mimeType?: string }>;
    };
    const out: ExternalResult[] = [];
    for (const r of resources.slice(0, k)) {
      try {
        const { contents } = (await client.readResource({ uri: r.uri }, { signal })) as {
          contents: Array<{ text?: string }>;
        };
        const content = contents.map((c) => c.text ?? '').join('\n').trim();
        if (content) out.push({ title: r.name ?? r.uri, content, url: r.uri, metadata: r.mimeType ? { mimeType: r.mimeType } : undefined });
      } catch { /* skip unreadable resource */ }
    }
    return out;
  }

  async testConnection(_signal: AbortSignal): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.getClient();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Null connecting so any concurrent getClient() call that hasn't resolved yet
    // won't re-use the in-flight promise after dispose. The IIFE itself checks
    // this.disposed after connect() and closes the client if set.
    this.connecting = null;
    try { await this.client?.close(); } catch { /* ignore */ }
    this.client = null;
  }
}
