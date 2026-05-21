import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CopilotCliAdapter,
  TokenUsageRepository,
  TokenUsageScanner,
  createDbClient,
  type SQLiteDatabase,
} from '@cognistore/core';

interface Fixture {
  dir: string;
  sqlite: SQLiteDatabase;
  dbPath: string;
  repo: TokenUsageRepository;
  scanner: TokenUsageScanner;
  sessionStateDir: string;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-test-'));
  const dbPath = join(dir, 'test.db');
  const sessionStateDir = join(dir, 'session-state');
  mkdirSync(sessionStateDir, { recursive: true });
  const { sqlite } = createDbClient(dbPath);
  const repo = new TokenUsageRepository(sqlite);
  const adapter = new CopilotCliAdapter({ sessionStateDir });
  const scanner = new TokenUsageScanner(repo, [adapter]);
  return { dir, sqlite, dbPath, repo, scanner, sessionStateDir };
}

function teardown(f: Fixture) {
  try { f.sqlite.close(); } catch { /* */ }
  try { rmSync(f.dir, { recursive: true, force: true }); } catch { /* */ }
}

function writeSession(
  sessionStateDir: string,
  sessionId: string,
  events: object[],
): string {
  const dir = join(sessionStateDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'events.jsonl');
  writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return filePath;
}

function sessionStart(sessionId: string, cwd: string) {
  return {
    type: 'session.start',
    data: { sessionId, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.21', context: { cwd } },
    id: `${sessionId}-start`,
    timestamp: '2026-05-01T10:00:00.000Z',
    parentId: null,
  };
}

function sessionShutdown(modelMetrics: Record<string, any>, timestamp = '2026-05-01T11:00:00.000Z') {
  return {
    type: 'session.shutdown',
    data: {
      shutdownType: 'routine',
      totalPremiumRequests: 12,
      modelMetrics,
    },
    id: 'shutdown-1',
    timestamp,
    parentId: null,
  };
}

test('parses shutdown event with multi-model usage, one row per (session, model)', async () => {
  const f = setup();
  try {
    writeSession(f.sessionStateDir, 'sess-multi', [
      sessionStart('sess-multi', '/Users/me/Projects/widget'),
      sessionShutdown({
        'claude-opus-4.6': {
          requests: { count: 50, cost: 9 },
          usage: { inputTokens: 5_000_000, outputTokens: 20_000, cacheReadTokens: 4_000_000, cacheWriteTokens: 0 },
        },
        'claude-sonnet-4.6': {
          requests: { count: 200, cost: 15 },
          usage: { inputTokens: 22_000_000, outputTokens: 90_000, cacheReadTokens: 20_000_000, cacheWriteTokens: 0 },
        },
      }),
    ]);

    const res = await f.scanner.scanAll();
    expect(res.inserted).toBe(2);

    const rows = f.sqlite.prepare(
      "SELECT source, model, project, session_id, input_tokens, output_tokens, cache_read_tokens FROM token_usage WHERE source = 'copilot-cli' ORDER BY model",
    ).all() as Array<{ source: string; model: string; project: string; session_id: string; input_tokens: number; output_tokens: number; cache_read_tokens: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].model).toBe('claude-opus-4.6');
    expect(rows[0].input_tokens).toBe(5_000_000);
    expect(rows[0].project).toBe('widget');
    expect(rows[0].session_id).toBe('sess-multi');
    expect(rows[1].model).toBe('claude-sonnet-4.6');
    expect(rows[1].input_tokens).toBe(22_000_000);
  } finally {
    teardown(f);
  }
});

test('skips sessions without session.shutdown', async () => {
  const f = setup();
  try {
    writeSession(f.sessionStateDir, 'sess-active', [
      sessionStart('sess-active', '/Users/me/Projects/wip'),
      // assistant.message etc. would go here, but no shutdown
      { type: 'assistant.message', data: { content: 'hi', outputTokens: 12 }, id: 'm1', timestamp: '2026-05-01T10:05:00.000Z' },
    ]);

    const res = await f.scanner.scanAll();
    expect(res.inserted).toBe(0);

    // But scan_state should still advance so we don't re-read the same bytes
    const state = f.sqlite.prepare("SELECT last_offset FROM scan_state WHERE source = 'copilot-cli'").get() as { last_offset: number } | undefined;
    expect(state).toBeDefined();
    expect(state!.last_offset).toBeGreaterThan(0);
  } finally {
    teardown(f);
  }
});

test('re-running scan is idempotent (no duplicate rows)', async () => {
  const f = setup();
  try {
    writeSession(f.sessionStateDir, 'sess-dedup', [
      sessionStart('sess-dedup', '/Users/me/Projects/demo'),
      sessionShutdown({
        'gpt-4.1': {
          requests: { count: 5 },
          usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      }),
    ]);

    const first = await f.scanner.scanAll();
    expect(first.inserted).toBe(1);
    const second = await f.scanner.scanAll();
    expect(second.inserted).toBe(0);

    const count = (f.sqlite.prepare("SELECT COUNT(*) as c FROM token_usage WHERE source = 'copilot-cli'").get() as { c: number }).c;
    expect(count).toBe(1);
  } finally {
    teardown(f);
  }
});

test('appended bytes after shutdown still get re-parsed once file grows', async () => {
  // Sanity check: when the file grows (rare for a shut-down session, but possible
  // if Copilot ever appends more events post-shutdown), the adapter re-reads.
  const f = setup();
  try {
    const path = writeSession(f.sessionStateDir, 'sess-grow', [
      sessionStart('sess-grow', '/Users/me/Projects/grow'),
      sessionShutdown({
        'gpt-4.1': {
          requests: { count: 1 },
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      }),
    ]);
    expect((await f.scanner.scanAll()).inserted).toBe(1);

    // Append a noop event — file grows but no new shutdown, dedup keeps row count stable.
    appendFileSync(path, JSON.stringify({ type: 'session.info', data: {}, id: 'x', timestamp: '2026-05-01T12:00:00.000Z' }) + '\n');
    expect((await f.scanner.scanAll()).inserted).toBe(0);
    const count = (f.sqlite.prepare("SELECT COUNT(*) as c FROM token_usage WHERE source = 'copilot-cli'").get() as { c: number }).c;
    expect(count).toBe(1);
  } finally {
    teardown(f);
  }
});

test('cacheWriteTokens field maps to cache_creation_tokens column', async () => {
  const f = setup();
  try {
    writeSession(f.sessionStateDir, 'sess-cache', [
      sessionStart('sess-cache', '/Users/me/Projects/cache'),
      sessionShutdown({
        'claude-opus-4.6': {
          requests: { count: 1 },
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 300 },
        },
      }),
    ]);
    expect((await f.scanner.scanAll()).inserted).toBe(1);
    const row = f.sqlite.prepare("SELECT cache_creation_tokens FROM token_usage WHERE source = 'copilot-cli'").get() as { cache_creation_tokens: number };
    expect(row.cache_creation_tokens).toBe(300);
  } finally {
    teardown(f);
  }
});
