import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Boots the REAL dashboard sidecar (apps/dashboard/dist-server/index.js) as a
 * subprocess against a temp DB + an in-test mock Ollama, then exercises the HTTP
 * routes the service-level tests can't reach: the /api/import zod gate (B6), the
 * fd-first plan-file read + allow-list (B7), and CRUD error shapes.
 *
 * The mock Ollama lets the real SDK initialize (and embed for real) with NO
 * Ollama installed, so this runs unchanged on CI. Requires `pnpm build` first
 * (CI runs it before the test step) so dist-server/index.js is current.
 */

const SERVER_ENTRY = resolve(__dirname, '../../../../apps/dashboard/dist-server/index.js');
const EMBED_DIMS_NATIVE = 768; // nomic-embed-text native width; server truncates to 256 via Matryoshka

function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => res(port));
      } else {
        srv.close(() => rej(new Error('could not get a free port')));
      }
    });
    srv.on('error', rej);
  });
}

/** Deterministic 768-d unit-ish vector derived from the prompt text. */
function fakeEmbedding(prompt: string): number[] {
  const vec = new Array(EMBED_DIMS_NATIVE).fill(0);
  for (let i = 0; i < prompt.length; i++) vec[i % EMBED_DIMS_NATIVE] += prompt.charCodeAt(i) / 1000;
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / mag);
}

function startMockOllama(model: string): Promise<{ server: Server; port: number }> {
  return new Promise((res, rej) => {
    const server = createServer((req, reply) => {
      if (req.method === 'GET' && req.url?.startsWith('/api/tags')) {
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ models: [{ name: model }] }));
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/api/embeddings')) {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          let prompt = '';
          try { prompt = JSON.parse(raw).prompt ?? ''; } catch { /* ignore */ }
          reply.writeHead(200, { 'content-type': 'application/json' });
          reply.end(JSON.stringify({ embedding: fakeEmbedding(prompt) }));
        });
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/api/pull')) {
        reply.writeHead(200, { 'content-type': 'application/x-ndjson' });
        reply.end(JSON.stringify({ status: 'success' }) + '\n');
        return;
      }
      reply.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') res({ server, port: addr.port });
      else rej(new Error('mock ollama: no port'));
    });
    server.on('error', rej);
  });
}

let child: ChildProcess;
let mock: { server: Server; port: number };
let baseUrl: string;
let tmpRoot: string;
let serverLog = '';
const createdPlanFiles: string[] = [];

test.describe.serial('dashboard HTTP endpoints (real sidecar + mock Ollama)', () => {
  test.beforeAll(async () => {
    test.skip(!existsSync(SERVER_ENTRY), `built sidecar missing at ${SERVER_ENTRY} — run \`pnpm build\` first`);

    const model = 'nomic-embed-text';
    tmpRoot = mkdtempSync(join(tmpdir(), 'cognistore-http-'));
    const distDir = join(tmpRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    // fastify-static needs a real root, and the not-found handler serves index.html.
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>test</title>');

    mock = await startMockOllama(model);
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    child = spawn(process.execPath, [SERVER_ENTRY], {
      env: {
        ...process.env,
        SQLITE_PATH: join(tmpRoot, 'knowledge.db'),
        // SQLITE_PATH only moves the DATABASE. Config paths still resolve from
        // homedir(), so without this any route that persists a setting rewrites
        // the developer's real ~/.cognistore on every test run.
        COGNISTORE_HOME: join(tmpRoot, 'cognistore-home'),
        OLLAMA_HOST: `http://127.0.0.1:${mock.port}`,
        OLLAMA_MODEL: model,
        DASHBOARD_PORT: String(port),
        DASHBOARD_DIST_PATH: distDir,
        SIDECAR_TOKEN: 'test-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (serverLog += d));
    child.stderr?.on('data', (d) => (serverLog += d));

    // Poll health until the SDK has initialized against the mock Ollama.
    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/api/health`);
        if (r.ok) {
          const h = await r.json();
          if (h?.database?.connected === true) { ready = true; break; }
        }
      } catch { /* not up yet */ }
      await new Promise((res) => setTimeout(res, 300));
    }
    if (!ready) throw new Error(`sidecar never became ready.\n--- server log ---\n${serverLog}`);
  });

  test.afterAll(async () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await new Promise((res) => setTimeout(res, 300));
      if (!child.killed) child.kill('SIGKILL');
    }
    await new Promise<void>((res) => (mock?.server ? mock.server.close(() => res()) : res()));
    for (const f of createdPlanFiles) { try { unlinkSync(f); } catch { /* ignore */ } }
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ─── /api/import zod gate (B6) ───────────────────────────────────

  test('rejects an invalid knowledge type with 400', async () => {
    const r = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ include: ['knowledge'], knowledge: [{ content: 'x', type: 'bogus', scope: 'global' }] }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/enum|type/i);
  });

  test('rejects over-long content (>500KB) with 400', async () => {
    const r = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ include: ['knowledge'], knowledge: [{ content: 'x'.repeat(500_001), type: 'pattern', scope: 'global' }] }),
    });
    expect(r.status).toBe(400);
  });

  test('rejects too many tags (>200) with 400', async () => {
    const r = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ include: ['knowledge'], knowledge: [{ content: 'x', type: 'pattern', scope: 'global', tags: new Array(201).fill('t') }] }),
    });
    expect(r.status).toBe(400);
  });

  test('rejects an empty body (no data types) with 400', async () => {
    const r = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  test('accepts a valid import and strips unknown keys', async () => {
    const r = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        include: ['knowledge'],
        knowledge: [{ title: 'Valid', content: 'valid import content', tags: ['ok'], type: 'pattern', scope: 'global', source: 'test', EVIL_UNKNOWN: 'dropme' }],
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.knowledge.imported).toBe(1);
    expect(body.knowledge.errors).toEqual([]);
  });

  test('rewrites an imported type:"system" entry to pattern (second guard)', async () => {
    const token = `sysguard${Date.now()}`;
    const imp = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        include: ['knowledge'],
        knowledge: [{ title: 'Sys', content: `system entry ${token}`, tags: ['s'], type: 'system', scope: 'global', source: 'test' }],
      }),
    });
    expect(imp.status).toBe(200);
    expect((await imp.json()).knowledge.imported).toBe(1);

    const search = await fetch(`${baseUrl}/api/knowledge/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: token, threshold: 0, limit: 10 }),
    });
    expect(search.status).toBe(200);
    const results = await search.json();
    const hit = (results as any[]).find((x) => x.entry?.content?.includes(token));
    expect(hit, 'imported system entry should be searchable').toBeTruthy();
    expect(hit.entry.type).toBe('pattern'); // never stored as the privileged 'system' type
  });

  // ─── /api/plans/:id/file allow-list + fd read (B7) ───────────────

  test('returns 404 for an unknown plan id', async () => {
    const r = await fetch(`${baseUrl}/api/plans/does-not-exist/file`);
    expect(r.status).toBe(404);
  });

  test('rejects a plan whose file path is outside the allow-list with 403', async () => {
    const created = await fetch(`${baseUrl}/api/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Escape', content: 'tries to read /etc/passwd', tags: ['t'], planFilePath: '/etc/passwd' }),
    });
    expect(created.status).toBe(201);
    const planId = (await created.json()).id;

    const r = await fetch(`${baseUrl}/api/plans/${planId}/file`);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('Forbidden');
  });

  test('reports exists:false for an allow-listed but missing file (fd ENOENT path)', async () => {
    const missing = join(homedir(), '.cognistore', `httptest-missing-${Date.now()}.md`);
    const created = await fetch(`${baseUrl}/api/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Missing', content: 'points at a non-existent allowed file', tags: ['t'], planFilePath: missing }),
    });
    expect(created.status).toBe(201);
    const planId = (await created.json()).id;

    const r = await fetch(`${baseUrl}/api/plans/${planId}/file`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ exists: false });
  });

  test('reads a real file under an allow-listed root via the fd', async () => {
    const planFile = join(homedir(), '.cognistore', `httptest-plan-${Date.now()}.md`);
    mkdirSync(dirname(planFile), { recursive: true });
    const content = '# Plan\n\nfd-read content with "quotes" and a tail line.\n';
    writeFileSync(planFile, content);
    createdPlanFiles.push(planFile);

    const created = await fetch(`${baseUrl}/api/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Real', content: 'has a real on-disk file', tags: ['t'], planFilePath: planFile }),
    });
    expect(created.status).toBe(201);
    const planId = (await created.json()).id;

    const r = await fetch(`${baseUrl}/api/plans/${planId}/file`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.exists).toBe(true);
    expect(body.content).toBe(content);
    expect(body.truncated).toBe(false);
    expect(body.path).toBe(planFile);
  });

  // ─── CRUD error shapes ───────────────────────────────────────────

  test('POST /api/plans with an empty title returns 400 {error}', async () => {
    const r = await fetch(`${baseUrl}/api/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '', content: 'no title', tags: ['t'] }),
    });
    expect(r.status).toBe(400);
    expect(typeof (await r.json()).error).toBe('string');
  });

  test('GET /api/knowledge/:id returns 404 {error} for an unknown id', async () => {
    const r = await fetch(`${baseUrl}/api/knowledge/00000000-0000-0000-0000-000000000000`);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('Not found');
  });

  // ─── Ranged metrics: 2-year windows (v2.4.0) ─────────────────────

  test('GET /api/metrics/activity clamps a >2y range to 730 daily buckets', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const from = encodeURIComponent(new Date(Date.now() - 900 * DAY).toISOString());
    const to = encodeURIComponent(new Date().toISOString());
    const r = await fetch(`${baseUrl}/api/metrics/activity?from=${from}&to=${to}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    // HTTP layer intersects zero-fill (local dates) with buildDateSeries (UTC) —
    // can differ by 1 near midnight in positive-UTC-offset TZs (review finding).
    expect(body.operationsByDay.length).toBeGreaterThanOrEqual(729);
    expect(body.operationsByDay.length).toBeLessThanOrEqual(730);
  });

  test('GET /api/metrics/plans honors from/to and zero-fills the range', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const from = encodeURIComponent(new Date(Date.now() - 29 * DAY).toISOString());
    const to = encodeURIComponent(new Date().toISOString());
    const r = await fetch(`${baseUrl}/api/metrics/plans?from=${from}&to=${to}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    // daysBetween is inclusive: 29d span → 30 buckets; tolerate 29 for the
    // local-vs-UTC boundary-day intersection (review finding).
    expect(body.plansByDay.length).toBeGreaterThanOrEqual(29);
    expect(body.plansByDay.length).toBeLessThanOrEqual(30);
    expect(body.plansByDay.every((d: any) => typeof d.count === 'number')).toBe(true);
  });

  test('GET /api/metrics/plans without params keeps the legacy 15-day window', async () => {
    const r = await fetch(`${baseUrl}/api/metrics/plans`);
    expect(r.status).toBe(200);
    expect((await r.json()).plansByDay.length).toBe(15);
  });
});
