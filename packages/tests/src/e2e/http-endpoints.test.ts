import { test, expect } from '@playwright/test';
import { type Server } from 'node:http';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  SERVER_ENTRY,
  getFreePort,
  startMockOllama,
  spawnSidecar,
  waitForSidecar,
  stopSidecar,
} from '../sidecar-helpers.js';

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

let child: ChildProcess;
let mock: { server: Server; port: number };
let baseUrl: string;
let tmpRoot: string;
let readServerLog: () => string = () => '';
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

    const spawned = spawnSidecar({
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
    });
    child = spawned.child;
    readServerLog = spawned.readLog;

    // Poll health until the SDK has initialized against the mock Ollama.
    const ready = await waitForSidecar(baseUrl);
    if (!ready) throw new Error(`sidecar never became ready.\n--- server log ---\n${readServerLog()}`);
  });

  test.afterAll(async () => {
    await stopSidecar(child);
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

  // ─── Plan lineage over HTTP ──────────────────────────────────────

  // ─── GET /api/plans multi-status filter (§10) ────────────────────

  test('GET /api/plans accepts a comma-separated status list and 400s on an unknown one', async () => {
    // Single value: unchanged behaviour, the form every existing caller uses.
    const one = await fetch(`${baseUrl}/api/plans?status=draft`);
    expect(one.status).toBe(200);
    for (const p of await one.json()) expect(p.status).toBe('draft');

    // Several values: union, not intersection.
    const many = await fetch(`${baseUrl}/api/plans?status=draft,active`);
    expect(many.status).toBe(200);
    for (const p of await many.json()) expect(['draft', 'active']).toContain(p.status);

    // Omitted / empty: no filter at all — this is what an empty chip selection sends.
    const none = await fetch(`${baseUrl}/api/plans`);
    expect(none.status).toBe(200);
    const empty = await fetch(`${baseUrl}/api/plans?status=`);
    expect(empty.status).toBe(200);
    expect((await empty.json()).length).toBe((await none.json()).length);

    // Repeats collapse (the SDK de-duplicates) instead of growing the IN-clause.
    const dupes = await fetch(`${baseUrl}/api/plans?status=draft,draft,draft`);
    expect(dupes.status).toBe(200);
    expect((await dupes.json()).length).toBe((await (await fetch(`${baseUrl}/api/plans?status=draft`)).json()).length);

    // Unknown value is rejected outright rather than silently returning nothing.
    const bad = await fetch(`${baseUrl}/api/plans?status=draft,bogus`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/bogus/);

    // The echoed offending values are bounded — a 5KB status must not come back whole.
    const huge = await fetch(`${baseUrl}/api/plans?status=${'x'.repeat(5000)}`);
    expect(huge.status).toBe(400);
    expect((await huge.json()).error.length).toBeLessThan(200);
  });

  test('POST /api/plans persists parentPlanId and GET :id/chain returns the whole chain', async () => {
    // Distinct content per plan on purpose: near-identical plans in one scope are
    // legitimately merged by dedup, which would hide what this test checks.
    const stamp = Date.now();
    const create = async (title: string, content: string, parentPlanId?: string) => {
      // A scope per plan: this suite's mock Ollama returns a constant embedding,
      // so two plans in one scope always look like duplicates and dedup merges
      // them. Chains are allowed to cross scopes, which keeps this realistic.
      const r = await fetch(`${baseUrl}/api/plans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, content, tags: ['lineage-http'], scope: `workspace:lineage-http-${stamp}-${title.split(' ')[1]}`, parentPlanId }),
      });
      expect(r.status).toBe(201);
      return r.json();
    };

    const root = await create(
      `Chain root ${stamp}`,
      'Design the export pipeline: schema, batching strategy and the CLI entry point.',
    );
    expect(root.parentPlanId ?? null).toBeNull();

    // The POST route destructures an explicit field list — this asserts the plan
    // actually carries the parent, not merely that the request was accepted.
    const child = await create(
      `Chain child ${stamp}`,
      'Localize the onboarding emails into Portuguese and wire the template picker.',
      root.id,
    );
    expect(child.parentPlanId).toBe(root.id);
    expect(child.rootPlanId).toBe(root.id);

    const r = await fetch(`${baseUrl}/api/plans/${child.id}/chain`);
    expect(r.status).toBe(200);
    const chain = await r.json();
    expect(chain.rootPlanId).toBe(root.id);
    expect(chain.chain.map((p: any) => p.id)).toEqual([root.id, child.id]);
    expect(chain.chain[1].isCurrent).toBe(true);
    expect(chain.truncated).toBe(false);
  });

  test('GET /api/plans/:id/chain returns 404 for an unknown plan', async () => {
    const r = await fetch(`${baseUrl}/api/plans/does-not-exist/chain`);
    expect(r.status).toBe(404);
  });

  test('PUT /api/plans/:id rejects a lineage cycle with 400 {error}', async () => {
    const stamp = Date.now();
    const create = async (title: string, content: string, parentPlanId?: string) => {
      const r = await fetch(`${baseUrl}/api/plans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, content, tags: ['lineage-http'], scope: `workspace:cycle-http-${stamp}-${title.split(' ')[1]}`, parentPlanId }),
      });
      return r.json();
    };
    const root = await create(`Cycle root ${stamp}`, 'Replace the billing reconciliation job with an event-driven consumer.');
    const child = await create(`Cycle child ${stamp}`, 'Add keyboard navigation and focus traps to the settings dialog.', root.id);
    expect(child.parentPlanId).toBe(root.id);

    const r = await fetch(`${baseUrl}/api/plans/${root.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentPlanId: child.id }),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toHaveProperty('error');
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
