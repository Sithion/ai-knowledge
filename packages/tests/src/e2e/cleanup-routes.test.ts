import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authFetch } from '../sidecar-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The cleanup routes against the REAL sidecar.
 *
 * These exercise what the service-level tests cannot: HTTP status codes, the
 * draft requirement on consolidation approval, the CSRF guard, and — because
 * these routes persist `lastCleanupReportAt` — that the sidecar writes settings
 * into its sandbox rather than the developer's real ~/.cognistore.
 */

const SERVER_ENTRY = resolve(__dirname, '../../../../apps/dashboard/dist-server/index.js');
const EMBED_DIMS_NATIVE = 768;

function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') { const { port } = addr; srv.close(() => res(port)); }
      else srv.close(() => rej(new Error('could not get a free port')));
    });
    srv.on('error', rej);
  });
}

function fakeEmbedding(prompt: string): number[] {
  const vec = new Array(EMBED_DIMS_NATIVE).fill(0);
  for (let i = 0; i < prompt.length; i++) vec[i % EMBED_DIMS_NATIVE] += prompt.charCodeAt(i) / 1000;
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / mag);
}

/** Embeddings only. /api/chat is deliberately absent so previews must fall back. */
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
          try { prompt = JSON.parse(raw)?.prompt ?? ''; } catch { /* ignore */ }
          reply.writeHead(200, { 'content-type': 'application/json' });
          reply.end(JSON.stringify({ embedding: fakeEmbedding(prompt) }));
        });
        return;
      }
      reply.writeHead(404); reply.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') res({ server, port: addr.port });
      else rej(new Error('mock ollama failed to bind'));
    });
    server.on('error', rej);
  });
}

let child: ChildProcess | undefined;
let mock: { server: Server; port: number } | undefined;
let baseUrl = '';
let tmpRoot = '';
let sandboxHome = '';
let serverLog = '';

const api = (path: string, init?: RequestInit) => authFetch(`${baseUrl}${path}`, init);
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });

// createKnowledgeSchema requires at least one tag, so the default is non-empty.
const addEntry = async (entry: Record<string, unknown>) => {
  const res = await post('/api/knowledge', { type: 'pattern', scope: 'global', source: 'test', tags: ['test'], ...entry });
  const body = await res.json();
  if (!res.ok) throw new Error(`addEntry failed (${res.status}): ${JSON.stringify(body)}`);
  return body;
};

test.beforeAll(async () => {
  const model = 'nomic-embed-text';
  tmpRoot = mkdtempSync(join(tmpdir(), 'cognistore-cleanup-'));
  sandboxHome = join(tmpRoot, 'cognistore-home');
  mkdirSync(sandboxHome, { recursive: true });
  const distDir = join(tmpRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>test</title>');

  mock = await startMockOllama(model);
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      SQLITE_PATH: join(tmpRoot, 'knowledge.db'),
      // Without this the sidecar resolves settings.json from homedir() and these
      // tests would rewrite the developer's real ~/.cognistore on every run.
      COGNISTORE_HOME: sandboxHome,
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

  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await authFetch(`${baseUrl}/api/health`);
      if (r.ok && (await r.json())?.database?.connected === true) { ready = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!ready) throw new Error(`sidecar never became ready:\n${serverLog}`);
});

test.afterAll(async () => {
  child?.kill();
  mock?.server.close();
  if (tmpRoot) { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// Serial: these share one sidecar via beforeAll and build on each other's
// state (a report generated in one test is approved in the next).
test.describe.serial('@e2e cleanup routes', () => {
  test('reports nothing before a run, and exposes the cleanup settings', async () => {
    const body = await api('/api/cleanup/report').then((r) => r.json());
    expect(body.report).toBeNull();
    expect(body.candidates).toEqual([]);
    expect(body.settings).toMatchObject({ cleanupEnabled: true, cleanupIntervalDays: 10, cleanupUnreadDays: 180 });
  });

  test('generates a report, counts it, and stays idempotent while open', async () => {
    await addEntry({ title: 'Obsolete note', content: 'the old way of doing things', tags: ['deprecated'] });

    const first = await post('/api/cleanup/report/run').then((r) => r.json());
    expect(first.created).toBe(true);
    expect(first.report.stats.counts).toMatchObject({ deprecated: 1, removableEntries: 1 });
    // Read tracking just started, so the unread bucket must explain itself
    // rather than silently show nothing.
    expect(first.report.stats.unreadGate).toContain('activates');

    const second = await post('/api/cleanup/report/run').then((r) => r.json());
    expect(second.created).toBe(false);
    expect(second.report.id).toBe(first.report.id);

    const count = await api('/api/cleanup/pending-count').then((r) => r.json());
    expect(count.pendingCount).toBe(1);
  });

  test('approves a removal, then refuses a replay', async () => {
    const report = await api('/api/cleanup/report').then((r) => r.json());
    const candidate = report.candidates.find((c: any) => c.category === 'deprecated' && c.status === 'pending');
    expect(candidate).toBeTruthy();

    const applied = await post(`/api/cleanup/candidates/${candidate.id}/approve`).then((r) => r.json());
    expect(applied.deleted).toBe(1);

    // Two dashboard windows, one candidate: the second must lose.
    const replay = await post(`/api/cleanup/candidates/${candidate.id}/approve`);
    expect(replay.status).toBe(409);
  });

  test('rejects a mutating request from a foreign origin', async () => {
    const res = await post('/api/cleanup/report/run', {}, { Origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
  });

  test('404s an unknown candidate', async () => {
    const res = await post('/api/cleanup/candidates/00000000-0000-4000-8000-000000000000/approve');
    expect(res.status).toBe(404);
  });

  test('previews a consolidation and falls back when the model is unavailable', async () => {
    // Different `type` on purpose: add-time dedup merges near-identical entries
    // within one scope+type at a LOWER threshold (0.85) than consolidation uses
    // (0.92), so same-type duplicates can never survive to reach the report.
    // Cross-type duplicates can, and findDuplicateGroups does not filter by type.
    await addEntry({ title: 'Duplicate one', content: 'identical duplicate body text', type: 'pattern', tags: ['dup'] });
    await addEntry({ title: 'Duplicate two', content: 'identical duplicate body text', type: 'fix', tags: ['dup'] });

    // Close the open report so a fresh one picks the new duplicates up.
    const open = await api('/api/cleanup/report').then((r) => r.json());
    if (open.report?.status === 'open') await post(`/api/cleanup/report/${open.report.id}/close`);

    const run = await post('/api/cleanup/report/run').then((r) => r.json());
    expect(run.created).toBe(true);

    const report = await api('/api/cleanup/report').then((r) => r.json());
    const group = report.candidates.find((c: any) => c.category === 'duplicate_group');
    expect(group, `no duplicate group in report: ${JSON.stringify(report.report.stats)}`).toBeTruthy();

    const preview = await post(`/api/cleanup/candidates/${group.id}/preview`).then((r) => r.json());
    // The mock Ollama serves embeddings but not /api/chat, so this exercises the
    // deterministic fallback — which must still produce a usable merge.
    expect(preview.usedLlm).toBe(false);
    expect(preview.draft.title).toBeTruthy();
    expect(preview.draft.content).toContain('Merged from duplicates');
  });

  test('refuses to approve a consolidation without a reviewed draft', async () => {
    const report = await api('/api/cleanup/report').then((r) => r.json());
    const group = report.candidates.find((c: any) => c.category === 'duplicate_group' && c.status === 'pending');
    expect(group).toBeTruthy();

    // Approving with no draft would apply a merge the user never saw, and delete
    // the other members on the strength of it.
    const res = await post(`/api/cleanup/candidates/${group.id}/approve`, {});
    expect(res.status).toBe(400);
  });

  test('applies a consolidation with a draft and deletes the other members', async () => {
    const report = await api('/api/cleanup/report').then((r) => r.json());
    const group = report.candidates.find((c: any) => c.category === 'duplicate_group' && c.status === 'pending');
    const before = await api('/api/knowledge/recent?limit=100').then((r) => r.json());
    const beforeCount = Array.isArray(before) ? before.length : before.entries?.length ?? 0;

    const applied = await post(`/api/cleanup/candidates/${group.id}/approve`, {
      draft: { title: 'Consolidated', content: 'consolidated body' },
      usedLlm: false,
    }).then((r) => r.json());

    expect(applied.canonicalId).toBe(group.entryIds[0]);
    expect(applied.deleted).toBe(group.entryIds.length - 1);

    const after = await api('/api/knowledge/recent?limit=100').then((r) => r.json());
    const afterCount = Array.isArray(after) ? after.length : after.entries?.length ?? 0;
    expect(afterCount).toBe(beforeCount - (group.entryIds.length - 1));
  });

  test('closes a report and tallies what was removed', async () => {
    const report = await api('/api/cleanup/report').then((r) => r.json());
    const closed = await post(`/api/cleanup/report/${report.report.id}/close`).then((r) => r.json());
    expect(typeof closed.removed).toBe('number');

    const after = await api('/api/cleanup/report').then((r) => r.json());
    expect(after.report.status).toBe('closed');
    expect(after.candidates.every((c: any) => c.status !== 'pending')).toBe(true);
  });

  test('persists settings inside its sandbox, never the real home directory', async () => {
    // These routes write lastCleanupReportAt. Without COGNISTORE_HOME that write
    // lands in the developer's own ~/.cognistore/settings.json on every test run.
    const sandboxSettings = join(sandboxHome, 'settings.json');
    expect(existsSync(sandboxSettings), 'sidecar did not write into COGNISTORE_HOME').toBe(true);
    const parsed = JSON.parse(readFileSync(sandboxSettings, 'utf-8'));
    expect(parsed.lastCleanupReportAt).toBeTruthy();
  });
});
