import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProviders, migrateProvidersConfig, EnvSecretStore, providersConfigSchema } from '@cognistore/providers';

test('loadProviders: missing file → empty manager (offline-first)', () => {
  const mgr = loadProviders(join(tmpdir(), `none-${Date.now()}.json`), new EnvSecretStore());
  expect(mgr.list()).toHaveLength(0);
});

test('loadProviders: malformed file → empty manager (never breaks local)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cog-prov-'));
  try {
    const f = join(dir, 'providers.json');
    writeFileSync(f, '{ not valid json');
    expect(loadProviders(f, new EnvSecretStore()).list()).toHaveLength(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migrateProvidersConfig: v1 → v2 flattens mcp, bearer→header, http→disabled stub', () => {
  const { config, migrated } = migrateProvidersConfig({
    version: 1,
    providers: [
      { id: 'docs', name: 'Docs', kind: 'mcp', enabled: true, mcp: { transport: 'stdio', command: 'npx', mode: 'tool', toolName: 'search', auth: { type: 'bearer', secretRef: 'docs' } } },
      { id: 'legacy', name: 'Legacy', kind: 'http', enabled: true, http: { url: 'https://api.example/search' } },
    ],
  });
  expect(migrated).toBe(true);
  expect(config.version).toBe(2);

  const docs = config.providers.find((p) => p.id === 'docs')!;
  expect(docs.transport).toBe('stdio');
  expect(docs.command).toBe('npx');
  expect(docs.toolName).toBe('search');
  expect(docs.auth).toEqual({ type: 'header', headerName: 'authorization', secretRef: 'docs' });

  const legacy = config.providers.find((p) => p.id === 'legacy')!;
  expect(legacy.enabled).toBe(false);           // http providers can't auto-convert → disabled stub
  expect(legacy.name).toContain('re-add as MCP');
});

test('migrateProvidersConfig: a v2 config passes through unchanged', () => {
  const v2 = { version: 2, providers: [{ id: 'a', name: 'A', enabled: true, transport: 'stdio', command: 'npx', mode: 'tool', toolName: 'search' }] };
  const { config, migrated } = migrateProvidersConfig(v2);
  expect(migrated).toBe(false);
  expect(config.providers[0].id).toBe('a');
});

test('loadProviders: rewrites a v1 file to v2 on disk and lists providers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cog-prov-'));
  try {
    const f = join(dir, 'providers.json');
    writeFileSync(f, JSON.stringify({
      version: 1,
      providers: [{ id: 'docs', name: 'Docs', kind: 'mcp', enabled: true, mcp: { transport: 'stdio', command: 'npx', mode: 'tool', toolName: 'search' } }],
    }));
    // stdio needs the installation opt-in now (it runs an arbitrary command).
    const mgr = loadProviders(f, new EnvSecretStore(), undefined, {
      allowStdio: true,
      allowInsecureUrls: false,
    });
    expect(mgr.list().map((p) => p.id)).toEqual(['docs']);
    // file rewritten in place to v2
    const rewritten = JSON.parse(readFileSync(f, 'utf-8'));
    expect(rewritten.version).toBe(2);
    expect(rewritten.providers[0].transport).toBe('stdio');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadProviders: a policy-gated entry is dropped WITHOUT taking the others down', () => {
  // The whole reason policy is not enforced in the zod schema: migrate parses
  // the entire file, and loadProviders catches into an empty manager
  // ("offline-first"), so a schema-level rejection would let one stdio entry
  // silently disable every remote provider the user has.
  const dir = mkdtempSync(join(tmpdir(), 'cog-prov-policy-'));
  try {
    const f = join(dir, 'providers.json');
    writeFileSync(f, JSON.stringify({
      version: 2,
      providers: [
        { id: 'risky', name: 'Risky', enabled: true, transport: 'stdio', command: 'sh', mode: 'tool', toolName: 'search' },
        { id: 'safe', name: 'Safe', enabled: true, transport: 'http', url: 'https://example.com/mcp', mode: 'tool', toolName: 'search' },
      ],
    }));
    const mgr = loadProviders(f, new EnvSecretStore(), undefined, {
      allowStdio: false,
      allowInsecureUrls: false,
    });
    expect(mgr.list().map((p) => p.id)).toEqual(['safe']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('providerEntry schema (v2): rejects bad id and transport/field mismatches', () => {
  // bad slug
  expect(() => providersConfigSchema.parse({ version: 2, providers: [{ id: 'BAD ID', name: 'X', transport: 'stdio', command: 'npx' }] })).toThrow();
  // stdio without command
  expect(() => providersConfigSchema.parse({ version: 2, providers: [{ id: 'x', name: 'X', transport: 'stdio' }] })).toThrow();
  // http without url
  expect(() => providersConfigSchema.parse({ version: 2, providers: [{ id: 'x', name: 'X', transport: 'http' }] })).toThrow();
  // wrong version literal
  expect(() => providersConfigSchema.parse({ version: 1, providers: [] })).toThrow();
});
