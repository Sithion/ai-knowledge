/**
 * Helpers for e2e suites that boot the REAL dashboard sidecar
 * (apps/dashboard/dist-server/index.js) as a subprocess.
 *
 * Kept separate from `test-helpers.ts`, which is DB-oriented and imports
 * @cognistore/core — nothing here touches the database.
 *
 * Requires `pnpm build` first (CI runs it before the test step) so
 * dist-server/index.js is current.
 */
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Built sidecar entry point. Suites should `test.skip` when it is missing. */
export const SERVER_ENTRY = resolve(__dirname, '../../../apps/dashboard/dist-server/index.js');

/** nomic-embed-text native width; the server truncates to 256 via Matryoshka. */
export const EMBED_DIMS_NATIVE = 768;

export function getFreePort(): Promise<number> {
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
export function fakeEmbedding(prompt: string): number[] {
  const vec = new Array(EMBED_DIMS_NATIVE).fill(0);
  for (let i = 0; i < prompt.length; i++) vec[i % EMBED_DIMS_NATIVE] += prompt.charCodeAt(i) / 1000;
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / mag);
}

/**
 * Minimal Ollama stand-in: answers the three calls the sidecar makes (`/api/tags`
 * on startup and during upgrade, `/api/embeddings`, `/api/pull`), so the real SDK
 * initializes and embeds with NO Ollama installed.
 */
export function startMockOllama(model: string): Promise<{ server: Server; port: number }> {
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

/** Spawn the sidecar with the given env and collect its output. */
export function spawnSidecar(env: NodeJS.ProcessEnv): { child: ChildProcess; readLog: () => string } {
  let log = '';
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  return { child, readLog: () => log };
}

/** Poll /api/health until the SDK has initialized (database connected). */
export async function waitForSidecar(baseUrl: string, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) {
        const h = (await r.json()) as { database?: { connected?: boolean } };
        if (h?.database?.connected === true) return true;
      }
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 300));
  }
  return false;
}

/** SIGTERM, then SIGKILL if it lingers. */
export async function stopSidecar(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise((res) => setTimeout(res, 300));
  if (!child.killed) child.kill('SIGKILL');
}
