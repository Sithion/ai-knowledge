import { test, expect } from '@playwright/test';
import { type Server } from 'node:http';
import { type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SERVER_ENTRY,
  getFreePort,
  startMockOllama,
  spawnSidecar,
  waitForSidecar,
  stopSidecar,
  authFetch,
  TEST_TOKEN,
  TOKEN_HEADER,
} from '../sidecar-helpers.js';

/**
 * The sidecar's authorization layer, against the REAL server.
 *
 * What this is defending: the API used to have no authentication at all. 76
 * routes, 7 of them behind an Origin check that allowed a MISSING Origin
 * outright — and `POST /api/uninstall` takes no body, so
 * `fetch(url, {method:'POST', mode:'no-cors'})` from any web page was a
 * CORS-simple request that ran the whole teardown: `~/.cognistore` deleted,
 * Ollama uninstalled, the app removed from /Applications. CORS gates response
 * READING, never execution, so the browser refusing to show the answer was
 * never protection.
 *
 * These tests drive the destructive routes exactly the way a hostile page would.
 */

let child: ChildProcess;
let mock: { server: Server; port: number };
let baseUrl: string;
let port: number;
let tmpRoot: string;

/** Send a hand-rolled HTTP/1.1 request and return its status code. */
function rawRequestStatus(request: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let buf = '';
    socket.on('data', (d) => (buf += d));
    socket.on('error', reject);
    socket.on('close', () => {
      const m = buf.match(/^HTTP\/1\.[01] (\d{3})/);
      m ? resolve(Number(m[1])) : reject(new Error(`no status line in: ${buf.slice(0, 200)}`));
    });
  });
}

test.describe.serial('sidecar API authorization (real sidecar)', () => {
  test.beforeAll(async () => {
    test.skip(!existsSync(SERVER_ENTRY), `built sidecar missing at ${SERVER_ENTRY} — run \`pnpm build\` first`);

    const model = 'nomic-embed-text';
    tmpRoot = mkdtempSync(join(tmpdir(), 'cognistore-auth-'));
    const distDir = join(tmpRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>t</title>');

    mock = await startMockOllama(model);
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    const spawned = spawnSidecar({
      SQLITE_PATH: join(tmpRoot, 'knowledge.db'),
      OLLAMA_HOST: `http://127.0.0.1:${mock.port}`,
      OLLAMA_MODEL: model,
      EMBEDDING_DIMENSIONS: '256',
      DASHBOARD_PORT: String(port),
      DASHBOARD_DIST_PATH: distDir,
      SIDECAR_TOKEN: TEST_TOKEN,
      HOME: tmpRoot,
    });
    child = spawned.child;

    const ready = await waitForSidecar(baseUrl);
    if (!ready) throw new Error(`sidecar never became ready:\n${spawned.readLog()}`);
  });

  test.afterAll(async () => {
    await stopSidecar(child);
    mock?.server.close();
    if (tmpRoot) { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  // ─── The drive-by CSRF that motivated all of this ────────────────

  test('a body-less POST /api/uninstall from a web page is refused', async () => {
    // Exactly the shape a hostile page can send with no preflight: no token, and
    // an Origin the browser sets for it.
    const res = await fetch(`${baseUrl}/api/uninstall`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);

    // And the data dir is still there — the handler never ran.
    expect(existsSync(tmpRoot)).toBe(true);
  });

  test('every destructive route refuses an unauthenticated caller', async () => {
    const routes = [
      '/api/uninstall',
      '/api/redeploy',
      '/api/upgrade/run',
      '/api/setup/configure',
      '/api/maintenance/cleanup',
      '/api/token-usage/scan',
    ];
    for (const path of routes) {
      const res = await fetch(`${baseUrl}${path}`, { method: 'POST' });
      expect(res.status, `${path} must not be reachable without a token`).toBe(403);
    }
    const del = await fetch(`${baseUrl}/api/logs`, { method: 'DELETE' });
    expect(del.status).toBe(403);
  });

  test('reads are refused too — GET /api/export dumps the whole knowledge base', async () => {
    for (const path of ['/api/export', '/api/providers', '/api/logs', '/api/settings', '/api/stats']) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, `${path} must not be readable without a token`).toBe(403);
    }
  });

  // ─── The three checks, one at a time ─────────────────────────────

  test('a wrong token is refused', async () => {
    const res = await fetch(`${baseUrl}/api/stats`, { headers: { [TOKEN_HEADER]: 'not-the-token' } });
    expect(res.status).toBe(403);
  });

  test('a foreign Origin is refused even WITH a valid token', async () => {
    // Defence in depth: a page that somehow learned the token still fails the
    // Origin check, because a browser will not let it forge that header.
    const res = await fetch(`${baseUrl}/api/stats`, {
      headers: { [TOKEN_HEADER]: TEST_TOKEN, Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
  });

  test('another localhost port is not a trusted origin', async () => {
    // The old predicate accepted ANY localhost origin on ANY port, so a dev
    // server or another local app's webview qualified as same-origin.
    const res = await fetch(`${baseUrl}/api/stats`, {
      headers: { [TOKEN_HEADER]: TEST_TOKEN, Origin: `http://localhost:${port + 1}` },
    });
    expect(res.status).toBe(403);
  });

  test('a rebound Host is refused (DNS rebinding)', async () => {
    // `Host` is a forbidden header name for fetch, so this has to go over a raw
    // socket — which is also exactly what a rebinding attack looks like from the
    // server's side: a request that reached us but names someone else's host.
    const status = await rawRequestStatus(
      `GET /api/stats HTTP/1.1\r\nHost: attacker.example.com\r\n${TOKEN_HEADER}: ${TEST_TOKEN}\r\nConnection: close\r\n\r\n`,
    );
    expect(status).toBe(403);
  });

  test('the sidecar\'s own Host is accepted over the same raw path', async () => {
    // Proves the test above fails on the Host and not on the hand-rolled request.
    const status = await rawRequestStatus(
      `GET /api/stats HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${TOKEN_HEADER}: ${TEST_TOKEN}\r\nConnection: close\r\n\r\n`,
    );
    expect(status).toBe(200);
  });

  test('the sidecar\'s own origin is accepted', async () => {
    for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`]) {
      const res = await fetch(`${baseUrl}/api/stats`, {
        headers: { [TOKEN_HEADER]: TEST_TOKEN, Origin: origin },
      });
      expect(res.status, `${origin} should be trusted`).toBe(200);
    }
  });

  test('a valid token with no Origin is accepted (the Tauri shell and CLI callers)', async () => {
    const res = await authFetch(`${baseUrl}/api/stats`);
    expect(res.status).toBe(200);
  });

  // ─── The token must not leak back out ────────────────────────────

  test('GET /api/health no longer hands out the sidecar token', async () => {
    const res = await authFetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(TEST_TOKEN);
    expect(JSON.parse(body)).not.toHaveProperty('token');
  });

  test('the SPA shell is served unauthenticated but carries no token', async () => {
    // It has to be: the webview fetches the document before any script of ours
    // has run. Which is exactly why the token is delivered out of band instead.
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(TEST_TOKEN);
  });

  test('a path that only looks like a public route is still refused', async () => {
    // Guards against an allow-list built on prefixes/normalisation quirks.
    for (const path of ['/api/health/../export', '/api/health/', '//api/export', '/API/EXPORT']) {
      const res = await fetch(`${baseUrl}${path}`);
      expect([403, 404], `${path} must not return data`).toContain(res.status);
    }
  });
});
