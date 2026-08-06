import { test, expect } from '@playwright/test';
import { type Server } from 'node:http';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERVER_ENTRY,
  getFreePort,
  startMockOllama,
  spawnSidecar,
  waitForSidecar,
  stopSidecar,
} from '../sidecar-helpers.js';

/**
 * Exercises the upgrade the app runs on first launch after an update, and the
 * progress it publishes while doing it.
 *
 * ⚠️ This is the one suite that POSTs /api/upgrade/run, which writes REAL agent
 * config: ~/.claude/CLAUDE.md, ~/.claude.json, ~/.claude/skills, ~/.copilot/**,
 * ~/.config/opencode/** and (via clearNpxMcpCache) rm -rf under ~/.npm/_npx —
 * all resolved through `homedir()`. `COGNISTORE_HOME` does NOT cover any of
 * that (it only redirects settings.json), so the sandbox is `HOME` itself,
 * which `os.homedir()` honours on POSIX. The guard below refuses to run if the
 * override somehow resolves back to the developer's home, and afterAll proves
 * the real files were never touched.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PKG = resolve(__dirname, '../../../../apps/dashboard/package.json');

type ProgressStep = { step: string; status: string };
type Progress = {
  running: boolean;
  startedAt: string | null;
  fromVersion: string | null;
  toVersion: string;
  currentStep: string | null;
  steps: ProgressStep[];
};
type RunResult = {
  success: boolean;
  noop?: boolean;
  fromVersion: string | null;
  toVersion: string;
  results: { step: string; status: string; message?: string }[];
};

let child: ChildProcess;
let mock: { server: Server; port: number };
let baseUrl: string;
let tmpRoot: string;
let readServerLog: () => string = () => '';
let appVersion: string;
/** existsSync + mtimeMs of files this suite must never touch. */
let realHomeSnapshot: Record<string, string> = {};

const WATCHED = () => [
  join(homedir(), '.claude.json'),
  join(homedir(), '.claude', 'settings.json'),
  join(homedir(), '.claude', 'CLAUDE.md'),
  join(homedir(), '.cognistore', '.version'),
  join(homedir(), '.npm', '_npx'),
];

function snapshotPaths(paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    try { out[p] = existsSync(p) ? String(statSync(p).mtimeMs) : 'absent'; }
    catch { out[p] = 'unreadable'; }
  }
  return out;
}

const getProgress = async (): Promise<Progress> =>
  (await (await fetch(`${baseUrl}/api/upgrade/progress`)).json()) as Progress;

test.describe.configure({ timeout: 180_000 });

test.describe.serial('upgrade progress (real sidecar, sandboxed HOME)', () => {
  test.beforeAll(async () => {
    test.skip(!existsSync(SERVER_ENTRY), `built sidecar missing at ${SERVER_ENTRY} — run \`pnpm build\` first`);

    appVersion = JSON.parse(readFileSync(DASHBOARD_PKG, 'utf-8')).version;
    realHomeSnapshot = snapshotPaths(WATCHED());

    const model = 'nomic-embed-text';
    tmpRoot = mkdtempSync(join(tmpdir(), 'cognistore-upgrade-'));
    // Refuse to proceed if the sandbox is not actually a sandbox.
    if (tmpRoot === homedir() || homedir().startsWith(tmpRoot)) {
      throw new Error(`refusing to run: HOME override ${tmpRoot} resolves to the real home`);
    }

    const distDir = join(tmpRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>test</title>');

    // The fixture that makes the sidecar think an upgrade is due. It has to live
    // under the sandboxed HOME: server/index.ts resolves VERSION_FILE from
    // homedir(), NOT from COGNISTORE_HOME.
    const sandboxInstallDir = join(tmpRoot, '.cognistore');
    mkdirSync(sandboxInstallDir, { recursive: true });
    writeFileSync(join(sandboxInstallDir, '.version'), '2.0.0');

    mock = await startMockOllama(model);
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    const spawned = spawnSidecar({
      HOME: tmpRoot,
      SQLITE_PATH: join(tmpRoot, 'knowledge.db'),
      COGNISTORE_HOME: sandboxInstallDir,
      OLLAMA_HOST: `http://127.0.0.1:${mock.port}`,
      OLLAMA_MODEL: model,
      DASHBOARD_PORT: String(port),
      DASHBOARD_DIST_PATH: distDir,
      SIDECAR_TOKEN: 'test-token',
    });
    child = spawned.child;
    readServerLog = spawned.readLog;

    const ready = await waitForSidecar(baseUrl);
    if (!ready) throw new Error(`sidecar never became ready.\n--- server log ---\n${readServerLog()}`);
  });

  test.afterAll(async () => {
    await stopSidecar(child);
    await new Promise<void>((res) => (mock?.server ? mock.server.close(() => res()) : res()));
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    // The whole point of the HOME override: prove the developer's own config
    // (and npx cache) came through untouched.
    expect(snapshotPaths(WATCHED())).toEqual(realHomeSnapshot);
  });

  test('reports an upgrade is due and starts idle with no steps', async () => {
    const check = await (await fetch(`${baseUrl}/api/upgrade/check`)).json();
    expect(check.needsUpgrade).toBe(true);
    expect(check.fromVersion).toBe('2.0.0');
    expect(check.toVersion).toBe(appVersion);

    const p = await getProgress();
    expect(p.running).toBe(false);
    expect(p.steps).toEqual([]);
    expect(p.toVersion).toBe(appVersion);
  });

  test('publishes live progress while the upgrade runs, and never leaks step messages', async () => {
    const runPromise = fetch(`${baseUrl}/api/upgrade/run`, { method: 'POST' })
      .then((r) => r.json() as Promise<RunResult>);

    // Sample the progress while the POST is still in flight.
    let sawRunning = false;
    let sawCurrentStep = false;
    let maxSteps = 0;
    const deadline = Date.now() + 120_000;
    let settled: RunResult | undefined;
    void runPromise.then((r) => { settled = r; });

    while (Date.now() < deadline && !settled) {
      const p = await getProgress().catch(() => null);
      if (p) {
        if (p.running) sawRunning = true;
        if (p.currentStep) sawCurrentStep = true;
        maxSteps = Math.max(maxSteps, p.steps.length);
        // The projection must hold on every sample, not just at the end.
        for (const s of p.steps) expect(s).not.toHaveProperty('message');
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const result = await runPromise;
    expect(result.noop).toBeFalsy();
    expect(sawRunning).toBe(true);
    expect(sawCurrentStep).toBe(true);
    expect(maxSteps).toBeGreaterThan(0);

    // Deliberately NOT asserting result.success: template-dependent steps can
    // legitimately fail in a bare test environment. The mechanics are the point.
    const final = await getProgress();
    expect(final.running).toBe(false);
    expect(final.currentStep).toBeNull();
    expect(final.fromVersion).toBe('2.0.0');
    // The published steps are exactly the response results, minus the messages.
    expect(final.steps).toEqual(result.results.map((r) => ({ step: r.step, status: r.status })));
    expect(result.results.map((r) => r.step)).toContain('database');
  });

  test('a second run does not repeat the upgrade', async () => {
    const before = await getProgress();
    const res = await fetch(`${baseUrl}/api/upgrade/run`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunResult;

    // Either the cached results of the run that just happened, or an explicit
    // no-op — never a fresh full upgrade.
    if (existsSync(join(tmpRoot, '.cognistore', '.version'))
        && readFileSync(join(tmpRoot, '.cognistore', '.version'), 'utf-8').trim() === appVersion) {
      expect(body.results.length > 0 || body.noop === true).toBe(true);
    }
    const after = await getProgress();
    expect(after.running).toBe(false);
    // No new run started: the run identity is unchanged.
    expect(after.startedAt).toBe(before.startedAt);
  });
});
