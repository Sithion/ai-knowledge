import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import type { ISecretStore } from './secrets/secret-store.js';
import type { KnowledgeProvider } from './types.js';
import { ProviderManager } from './manager.js';
import { HttpKnowledgeProvider } from './http/http-provider.js';
import { McpKnowledgeProvider } from './mcp/mcp-provider.js';

const authSchema = z.object({
  type: z.enum(['none', 'bearer', 'header']).default('none'),
  headerName: z.string().optional(),
  secretRef: z.string().optional(),
});

const httpSchema = z.object({
  url: z.string().url(),
  auth: authSchema.default({ type: 'none' }),
  timeoutMs: z.number().int().positive().max(30000).optional(),
  allowInsecure: z.boolean().optional(),
});

const mcpSchema = z.object({
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().optional(),
  auth: authSchema.optional(),
  mode: z.enum(['tool', 'resources']).default('tool'),
  toolName: z.string().optional(),
  argMapping: z.record(z.string()).optional(),
  resultPath: z.string().optional(),
});

export const providerEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug'),
    name: z.string().min(1),
    kind: z.enum(['http', 'mcp']),
    enabled: z.boolean().default(true),
    http: httpSchema.optional(),
    mcp: mcpSchema.optional(),
  })
  .refine((p) => (p.kind === 'http' ? !!p.http : !!p.mcp), {
    message: 'the config block (`http` or `mcp`) must match `kind`',
  });

export const providersConfigSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerEntrySchema).default([]),
});

export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type ProvidersConfig = z.infer<typeof providersConfigSchema>;

export function buildProvider(entry: ProviderEntry, secrets: ISecretStore): KnowledgeProvider {
  if (entry.kind === 'http') {
    const h = entry.http!;
    return new HttpKnowledgeProvider(
      { id: entry.id, name: entry.name, enabled: entry.enabled, url: h.url, auth: h.auth, timeoutMs: h.timeoutMs, allowInsecure: h.allowInsecure },
      secrets,
    );
  }
  const m = entry.mcp!;
  return new McpKnowledgeProvider(
    {
      id: entry.id, name: entry.name, enabled: entry.enabled,
      transport: m.transport, command: m.command, args: m.args, env: m.env,
      url: m.url, auth: m.auth, mode: m.mode, toolName: m.toolName,
      argMapping: m.argMapping, resultPath: m.resultPath,
    },
    secrets,
  );
}

/**
 * Load `providers.json` into a ProviderManager. Missing or malformed config →
 * empty manager (offline-first: never let bad config break local search).
 */
export function loadProviders(configPath: string, secrets: ISecretStore): ProviderManager {
  if (!existsSync(configPath)) return new ProviderManager([]);
  try {
    const parsed = providersConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')));
    return new ProviderManager(parsed.providers.map((e) => buildProvider(e, secrets)));
  } catch {
    return new ProviderManager([]);
  }
}
