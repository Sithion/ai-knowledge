import { z } from 'zod';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import type { ISecretStore } from './secrets/secret-store.js';
import type { ITokenStore } from './secrets/token-store.js';
import type { KnowledgeProvider } from './types.js';
import { ProviderManager } from './manager.js';
import { McpKnowledgeProvider } from './mcp/mcp-provider.js';
import { CogniStoreOAuthProvider } from './mcp/oauth-provider.js';
import { providerPolicyViolation, DEFAULT_PROVIDER_POLICY, type ProviderPolicy } from './policy.js';

/**
 * Auth for a remote (Streamable HTTP) MCP server. stdio servers don't use this —
 * their secrets are injected as env vars the subprocess reads.
 *  - none:   no auth
 *  - header: static Authorization/custom header, value from the OS keychain (secretRef)
 *  - oauth:  OAuth 2.1 + PKCE browser flow (tokens persisted by the token store)
 */
const authSchema = z.object({
  type: z.enum(['none', 'header', 'oauth']).default('none'),
  headerName: z.string().optional(),
  secretRef: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  clientId: z.string().optional(),
  allowInsecure: z.boolean().optional(),
});

/** v2 provider entry — MCP only (the HTTP `/search` contract was removed). */
export const providerEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug'),
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    transport: z.enum(['stdio', 'http']),
    // stdio
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    // http (Streamable HTTP)
    url: z.string().url().optional(),
    auth: authSchema.optional(),
    // query mapping
    mode: z.enum(['tool', 'resources']).default('tool'),
    toolName: z.string().optional(),
    argMapping: z.record(z.string()).optional(),
    resultPath: z.string().optional(),
  })
  .refine((p) => (p.transport === 'stdio' ? !!p.command : !!p.url), {
    message: 'stdio transport requires `command`; http transport requires `url`',
  });

export const providersConfigSchema = z.object({
  version: z.literal(2),
  providers: z.array(providerEntrySchema).default([]),
});

export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type ProvidersConfig = z.infer<typeof providersConfigSchema>;

export function buildProvider(entry: ProviderEntry, secrets: ISecretStore, tokenStore?: ITokenStore): KnowledgeProvider {
  // For OAuth providers, attach a NON-INTERACTIVE OAuth client used at search time:
  // it reads/refreshes persisted tokens (the SDK refreshes automatically) but never
  // opens a browser. Interactive authorization happens via the dashboard "Connect"
  // flow, which uses its own loopback-redirect OAuth provider and saves tokens here.
  let oauthProvider;
  if (entry.transport === 'http' && entry.auth?.type === 'oauth' && tokenStore) {
    oauthProvider = new CogniStoreOAuthProvider(tokenStore, {
      providerId: entry.id,
      redirectUrl: 'http://127.0.0.1:0/callback', // placeholder; not used for refresh
      scopes: entry.auth.scopes,
      clientId: entry.auth.clientId,
      onRedirect: () => {
        throw new Error(`MCP provider "${entry.id}" requires interactive OAuth — open Settings → External Knowledge Providers and click Connect`);
      },
    });
  }
  return new McpKnowledgeProvider(
    {
      id: entry.id, name: entry.name, enabled: entry.enabled,
      transport: entry.transport, command: entry.command, args: entry.args, env: entry.env,
      url: entry.url, auth: entry.auth, oauthProvider, mode: entry.mode, toolName: entry.toolName,
      argMapping: entry.argMapping, resultPath: entry.resultPath,
    },
    secrets,
  );
}

/**
 * Migrate a raw parsed providers.json to v2 (MCP-only). Returns the v2 config and
 * whether anything changed (so the caller can rewrite the file once).
 *
 * v1 → v2:
 *  - `kind: 'mcp'`  → flatten `mcp.*` to the top level; auth `bearer` → `header`.
 *  - `kind: 'http'` → cannot auto-convert (no MCP endpoint). Kept as a DISABLED stub
 *    so the id (and any keychain secret) survives; the user re-adds it as an MCP connector.
 */
export function migrateProvidersConfig(raw: any): { config: ProvidersConfig; migrated: boolean } {
  if (raw && raw.version === 2) {
    return { config: providersConfigSchema.parse(raw), migrated: false };
  }
  if (!raw || raw.version !== 1 || !Array.isArray(raw.providers)) {
    // Unknown/empty shape — start clean rather than throw (offline-first).
    return { config: { version: 2, providers: [] }, migrated: !!raw };
  }

  const migrateAuth = (a: any) => {
    if (!a || typeof a !== 'object') return undefined;
    const type = a.type === 'bearer' ? 'header' : a.type;
    return {
      type,
      headerName: a.type === 'bearer' ? 'authorization' : a.headerName,
      secretRef: a.secretRef,
    };
  };

  const providers = raw.providers.map((e: any) => {
    if (e?.kind === 'mcp' && e.mcp) {
      return {
        id: e.id, name: e.name, enabled: e.enabled ?? true,
        transport: e.mcp.transport, command: e.mcp.command, args: e.mcp.args, env: e.mcp.env,
        url: e.mcp.url, auth: migrateAuth(e.mcp.auth), mode: e.mcp.mode ?? 'tool',
        toolName: e.mcp.toolName, argMapping: e.mcp.argMapping, resultPath: e.mcp.resultPath,
      };
    }
    // http kind (or malformed): keep as a disabled stub. transport 'http' + a
    // placeholder url keeps the entry schema-valid; enabled:false means it never runs.
    return {
      id: e.id, name: `${e.name ?? e.id} (migrated — re-add as MCP)`, enabled: false,
      transport: 'http', url: e?.http?.url ?? 'https://example.invalid', auth: { type: 'none' }, mode: 'tool',
    };
  });

  return { config: providersConfigSchema.parse({ version: 2, providers }), migrated: true };
}

/**
 * Load `providers.json` into a ProviderManager. Missing or malformed config →
 * empty manager (offline-first: never let bad config break local search).
 * A v1 file is migrated to v2 and rewritten in place once.
 */
export function loadProviders(
  configPath: string,
  secrets: ISecretStore,
  tokenStore?: ITokenStore,
  policy: ProviderPolicy = DEFAULT_PROVIDER_POLICY,
): ProviderManager {
  if (!existsSync(configPath)) return new ProviderManager([]);
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const { config, migrated } = migrateProvidersConfig(raw);
    if (migrated) {
      try {
        const tmp = `${configPath}.tmp`;
        // 0600: this file can hold a stdio provider's `env`, which users do put
        // literal secrets into despite secretRef being the documented route.
        writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
        renameSync(tmp, configPath);
        console.error('[CogniStore] providers.json migrated to v2 (MCP-only)');
      } catch (e) {
        console.error('[CogniStore] providers.json v2 rewrite failed:', e instanceof Error ? e.message : String(e));
      }
    }
    // Policy is applied PER ENTRY, never as a whole-file throw: one gated entry
    // must not take the user's other providers down with it (see policy.ts).
    const allowed = config.providers.filter((e) => {
      const violation = providerPolicyViolation(e, policy);
      if (violation) {
        console.error(`[CogniStore] provider "${e.id}" disabled by policy: ${violation}`);
        return false;
      }
      return true;
    });
    return new ProviderManager(allowed.map((e) => buildProvider(e, secrets, tokenStore)));
  } catch (e) {
    console.error('[CogniStore] Failed to load providers.json:', e instanceof Error ? e.message : String(e));
    return new ProviderManager([]);
  }
}
