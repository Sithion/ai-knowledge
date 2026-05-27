import { test, expect } from '@playwright/test';
import http from 'node:http';
import { HttpKnowledgeProvider, EnvSecretStore, ProviderManager } from '@cognistore/providers';

interface Mock {
  url: string;
  state: { headers?: http.IncomingHttpHeaders; body?: any };
  close: () => Promise<void>;
}

function startMock(opts: { status?: number; body?: unknown } = {}): Promise<Mock> {
  const state: Mock['state'] = {};
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      state.headers = req.headers;
      state.body = data ? JSON.parse(data) : null;
      if (req.method !== 'POST' || !req.url?.endsWith('/search')) { res.writeHead(404).end(); return; }
      res.writeHead(opts.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(opts.body ?? { results: [] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        state,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const secrets = new EnvSecretStore();
const ac = () => new AbortController().signal;

test('http provider: maps contract-v1 results', async () => {
  const mock = await startMock({ body: { results: [{ title: 'T', content: 'C', url: 'http://x', score: 0.5 }] } });
  try {
    const p = new HttpKnowledgeProvider({ id: 'm', name: 'M', enabled: true, url: mock.url, allowInsecure: true }, secrets);
    const results = await p.search('hello', 5, ac());
    expect(results).toEqual([{ title: 'T', content: 'C', url: 'http://x', score: 0.5 }]);
    expect(mock.state.body).toEqual({ query: 'hello', k: 5 });
  } finally { await mock.close(); }
});

test('http provider: sends bearer token from the secret store', async () => {
  process.env.COGNISTORE_PROVIDER_SECRET__MYTOK = 'sek-123';
  const mock = await startMock({ body: { results: [] } });
  try {
    const p = new HttpKnowledgeProvider(
      { id: 'a', name: 'A', enabled: true, url: mock.url, allowInsecure: true, auth: { type: 'bearer', secretRef: 'mytok' } },
      secrets,
    );
    await p.search('q', 3, ac());
    expect(mock.state.headers?.authorization).toBe('Bearer sek-123');
  } finally { await mock.close(); delete process.env.COGNISTORE_PROVIDER_SECRET__MYTOK; }
});

test('http provider: non-2xx becomes an error (isolated via fanOut)', async () => {
  const mock = await startMock({ status: 500, body: { error: 'kaboom' } });
  try {
    const p = new HttpKnowledgeProvider({ id: 'e', name: 'E', enabled: true, url: mock.url, allowInsecure: true }, secrets);
    const [section] = await new ProviderManager([p]).fanOut('q', 5, 1000);
    expect(section.error).toContain('500');
    expect(section.error).toContain('kaboom');
    expect(section.results).toHaveLength(0);
  } finally { await mock.close(); }
});

test('http provider: invalid response shape is rejected', async () => {
  const mock = await startMock({ body: { results: [{ title: 'no content field' }] } }); // missing required `content`
  try {
    const p = new HttpKnowledgeProvider({ id: 'i', name: 'I', enabled: true, url: mock.url, allowInsecure: true }, secrets);
    await expect(p.search('q', 5, ac())).rejects.toThrow();
  } finally { await mock.close(); }
});

test('http provider: SSRF guard rejects non-https / loopback by default', async () => {
  const p = new HttpKnowledgeProvider({ id: 's', name: 'S', enabled: true, url: 'http://127.0.0.1:9/x' }, secrets); // allowInsecure defaults false
  await expect(p.search('q', 1, ac())).rejects.toThrow(/non-https|loopback|private/);
});

test('http provider: testConnection reports ok / failure', async () => {
  const mock = await startMock({ body: { results: [] } });
  try {
    const ok = new HttpKnowledgeProvider({ id: 'ok', name: 'ok', enabled: true, url: mock.url, allowInsecure: true }, secrets);
    expect((await ok.testConnection(ac())).ok).toBe(true);
    const bad = new HttpKnowledgeProvider({ id: 'bad', name: 'bad', enabled: true, url: 'https://does-not-exist.invalid', allowInsecure: false }, secrets);
    expect((await bad.testConnection(ac())).ok).toBe(false);
  } finally { await mock.close(); }
});
