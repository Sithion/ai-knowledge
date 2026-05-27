import { test, expect } from '@playwright/test';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProviders, EnvSecretStore, providersConfigSchema } from '@cognistore/providers';

function startMock(body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    }),
  );
}

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

test('loadProviders: builds an http provider and fanOut queries it', async () => {
  const mock = await startMock({ results: [{ title: 'T', content: 'C' }] });
  const dir = mkdtempSync(join(tmpdir(), 'cog-prov-'));
  try {
    const f = join(dir, 'providers.json');
    writeFileSync(f, JSON.stringify({
      version: 1,
      providers: [
        { id: 'wiki', name: 'Wiki', kind: 'http', enabled: true, http: { url: mock.url, allowInsecure: true } },
        { id: 'off', name: 'Off', kind: 'http', enabled: false, http: { url: mock.url, allowInsecure: true } },
      ],
    }));
    const mgr = loadProviders(f, new EnvSecretStore());
    expect(mgr.list().map((p) => p.id).sort()).toEqual(['off', 'wiki']);
    const sections = await mgr.fanOut('q', 5, 1000);    // disabled excluded
    expect(sections.map((s) => s.providerId)).toEqual(['wiki']);
    expect(sections[0].results).toEqual([{ title: 'T', content: 'C' }]);
  } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('providersConfigSchema rejects a kind/block mismatch', () => {
  expect(() => providersConfigSchema.parse({ version: 1, providers: [{ id: 'x', name: 'X', kind: 'http' }] })).toThrow();
  expect(() => providersConfigSchema.parse({ version: 1, providers: [{ id: 'BAD ID', name: 'X', kind: 'http', http: { url: 'https://x.test' } }] })).toThrow();
});
