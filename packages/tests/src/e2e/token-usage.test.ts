import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDbClient,
  TokenUsageRepository,
  TokenUsageScanner,
  TokenUsageService,
  ClaudeCodeAdapter,
  type SQLiteDatabase,
} from '@cognistore/core';

function isoMinus(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function makeUsageLine(opts: {
  ts: string;
  sessionId: string;
  messageId?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.ts,
    sessionId: opts.sessionId,
    message: {
      id: opts.messageId,
      model: opts.model ?? 'claude-opus-4-7',
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
      },
    },
  });
}

interface Fixture {
  dir: string;
  sqlite: SQLiteDatabase;
  dbPath: string;
  service: TokenUsageService;
  repo: TokenUsageRepository;
  scanner: TokenUsageScanner;
  projectsDir: string;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'cognistore-token-test-'));
  const dbPath = join(dir, 'test.db');
  const projectsDir = join(dir, 'projects');
  mkdirSync(projectsDir, { recursive: true });
  const { sqlite } = createDbClient(dbPath);
  const repo = new TokenUsageRepository(sqlite);
  const adapter = new ClaudeCodeAdapter({ projectsDir });
  const scanner = new TokenUsageScanner(repo, [adapter]);
  const service = new TokenUsageService(repo, [adapter]);
  return { dir, sqlite, dbPath, service, repo, scanner, projectsDir };
}

function teardown(f: Fixture): void {
  try { f.sqlite.close(); } catch { /* ignore */ }
  try { rmSync(f.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('adapter parses JSONL with mixed usage / no-usage lines', async () => {
  const f = setup();
  try {
    const projectFolder = join(f.projectsDir, '-Users-test-Projects-demo');
    mkdirSync(projectFolder, { recursive: true });
    const jsonl = join(projectFolder, 'session1.jsonl');

    const noUsage = JSON.stringify({ type: 'user', timestamp: isoMinus(60), message: { content: 'hi' } });
    const line1 = makeUsageLine({ ts: isoMinus(50), sessionId: 'session1', messageId: 'm1', input: 100, output: 50, cacheRead: 200 });
    const line2 = makeUsageLine({ ts: isoMinus(40), sessionId: 'session1', messageId: 'm2', input: 80, output: 30, cacheCreation: 150 });
    writeFileSync(jsonl, [noUsage, line1, line2].join('\n') + '\n');

    const result = await f.scanner.scanAll();
    expect(result.inserted).toBe(2);
    expect(result.scanned).toBe(2);
    expect(result.bySource['claude-code'].inserted).toBe(2);

    const totals = f.repo.totals({ from: isoMinus(120), to: new Date().toISOString() });
    expect(totals.inputTokens).toBe(180);
    expect(totals.outputTokens).toBe(80);
    expect(totals.cacheReadTokens).toBe(200);
    expect(totals.cacheCreationTokens).toBe(150);
  } finally {
    teardown(f);
  }
});

test('dedup: same scan run twice inserts each row only once', async () => {
  const f = setup();
  try {
    const projectFolder = join(f.projectsDir, '-tmp-proj');
    mkdirSync(projectFolder, { recursive: true });
    const jsonl = join(projectFolder, 'sess.jsonl');
    writeFileSync(jsonl, makeUsageLine({ ts: isoMinus(10), sessionId: 's', messageId: 'm', input: 5 }) + '\n');

    const first = await f.scanner.scanAll();
    expect(first.inserted).toBe(1);

    // Reset scan_state so the adapter re-reads the file from offset 0.
    f.sqlite.prepare('DELETE FROM scan_state').run();
    const second = await f.scanner.scanAll();
    // Adapter sees the row again, but INSERT OR IGNORE keeps the count at 1.
    expect(second.scanned).toBe(1);
    expect(second.inserted).toBe(0);

    const totalRows = (f.sqlite.prepare('SELECT COUNT(*) as c FROM token_usage').get() as { c: number }).c;
    expect(totalRows).toBe(1);
  } finally {
    teardown(f);
  }
});

test('scan_state advances and resumes for appended lines', async () => {
  const f = setup();
  try {
    const projectFolder = join(f.projectsDir, '-x-proj');
    mkdirSync(projectFolder, { recursive: true });
    const jsonl = join(projectFolder, 'sess.jsonl');
    writeFileSync(jsonl, makeUsageLine({ ts: isoMinus(30), sessionId: 's', messageId: 'm1', input: 10 }) + '\n');

    const first = await f.scanner.scanAll();
    expect(first.inserted).toBe(1);

    const stateAfter = f.repo.getScanState('claude-code', jsonl);
    expect(stateAfter).toBeDefined();
    expect(stateAfter!.lastOffset).toBeGreaterThan(0);

    appendFileSync(jsonl, makeUsageLine({ ts: isoMinus(10), sessionId: 's', messageId: 'm2', input: 20 }) + '\n');

    const second = await f.scanner.scanAll();
    expect(second.inserted).toBe(1);
    expect(second.scanned).toBe(1);
  } finally {
    teardown(f);
  }
});

test('aggregations group by day, model, and project correctly', async () => {
  const f = setup();
  try {
    const proj1 = join(f.projectsDir, '-Users-x-Projects-alpha');
    const proj2 = join(f.projectsDir, '-Users-x-Projects-beta');
    mkdirSync(proj1, { recursive: true });
    mkdirSync(proj2, { recursive: true });

    const opus = makeUsageLine({ ts: isoMinus(120), sessionId: 's1', messageId: 'a1', model: 'claude-opus-4-7', input: 1000, output: 500 });
    const sonnet = makeUsageLine({ ts: isoMinus(60), sessionId: 's2', messageId: 'a2', model: 'claude-sonnet-4-6', input: 200, output: 80 });
    writeFileSync(join(proj1, 'a.jsonl'), opus + '\n');
    writeFileSync(join(proj2, 'b.jsonl'), sonnet + '\n');

    await f.scanner.scanAll();

    const filter = { from: isoMinus(180), to: new Date().toISOString() };
    const agg = f.service.getAggregates(filter);
    expect(agg.totals.inputTokens).toBe(1200);

    const models = agg.byModel.map((m) => m.model).sort();
    expect(models).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);
    expect(agg.byModel[0].totalTokens).toBeGreaterThanOrEqual(agg.byModel[1].totalTokens);

    const projects = agg.byProject.map((p) => p.project).sort();
    expect(projects).toEqual(['alpha', 'beta']);
  } finally {
    teardown(f);
  }
});
