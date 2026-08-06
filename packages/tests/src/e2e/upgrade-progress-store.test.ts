import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Unit tests for the upgrade progress store. These cover the invariants the
 * sidecar depends on — when state may be reset, and what is allowed to escape
 * onto the unauthenticated poll endpoint — without booting a server, so a
 * regression fails in milliseconds instead of inside the 180s upgrade e2e.
 *
 * Imports the BUILT module (tsc output), same convention as the sidecar e2e:
 * requires `pnpm build` first.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_MODULE = resolve(__dirname, '../../../../apps/dashboard/dist-server/upgrade-progress.js');

type DeployStep = { step: string; status: string; message?: string };
type Store = {
  snapshot(): {
    running: boolean; startedAt: string | null; fromVersion: string | null;
    toVersion: string; currentStep: string | null;
    steps: { step: string; status: string }[];
  };
  steps(): DeployStep[];
  lastRun(): { fromVersion: string | null; steps: DeployStep[] } | null;
  begin(fromVersion: string | null): void;
  setStep(step: string | null): void;
  record(step: DeployStep): void;
  finish(): void;
};

async function loadStore(): Promise<{
  createUpgradeProgress: (toVersion: string) => Store;
  toProgressStep: (s: DeployStep) => { step: string; status: string };
  deployWentWell: (steps: DeployStep[]) => boolean;
}> {
  return (await import(STORE_MODULE)) as any;
}

test.describe('upgrade progress store', () => {
  test.skip(!existsSync(STORE_MODULE), `built module missing at ${STORE_MODULE} — run \`pnpm build\` first`);

  test('starts idle with no steps', async () => {
    const { createUpgradeProgress } = await loadStore();
    const p = createUpgradeProgress('2.4.1');
    const s = p.snapshot();
    expect(s.running).toBe(false);
    expect(s.startedAt).toBeNull();
    expect(s.steps).toEqual([]);
    expect(s.toVersion).toBe('2.4.1');
  });

  test('the projection drops message — it never reaches the poll endpoint', async () => {
    const { createUpgradeProgress, toProgressStep } = await loadStore();
    // Real messages embed absolute paths (and with them the OS username).
    const leaky: DeployStep = {
      step: 'instructions-claude',
      status: 'error',
      message: "EACCES: permission denied, open '/Users/someone/.claude/settings.json'",
    };
    expect(toProgressStep(leaky)).toEqual({ step: 'instructions-claude', status: 'error' });

    const p = createUpgradeProgress('2.4.1');
    p.begin('2.4.0');
    p.record(leaky);
    const published = p.snapshot().steps;
    expect(published).toHaveLength(1);
    expect(published[0]).not.toHaveProperty('message');
    expect(JSON.stringify(published)).not.toContain('someone');

    // Redaction happens on the way OUT, so the message is still available to
    // the upgrade response — nothing can append a step that bypasses it.
    expect(p.steps()[0].message).toBe(leaky.message);
  });

  test('begin marks the run, records accumulate, finish leaves them readable', async () => {
    const { createUpgradeProgress } = await loadStore();
    const p = createUpgradeProgress('2.4.1');

    p.begin('2.4.0');
    let s = p.snapshot();
    expect(s.running).toBe(true);
    expect(s.fromVersion).toBe('2.4.0');
    expect(s.startedAt).not.toBeNull();

    p.setStep('database');
    expect(p.snapshot().currentStep).toBe('database');
    p.record({ step: 'database', status: 'success' });
    p.setStep('version');
    p.record({ step: 'version', status: 'success' });
    expect(p.snapshot().steps.map((x) => x.step)).toEqual(['database', 'version']);

    p.finish();
    s = p.snapshot();
    expect(s.running).toBe(false);
    expect(s.currentStep).toBeNull();
    // Deliberate: a client that connects late can still see what happened.
    expect(s.steps).toHaveLength(2);
  });

  test('begin clears the previous run, and startedAt identifies which run a snapshot describes', async () => {
    const { createUpgradeProgress } = await loadStore();
    const p = createUpgradeProgress('2.4.1');

    p.begin('2.4.0');
    p.record({ step: 'database', status: 'success' });
    p.finish();
    const first = p.snapshot();

    await new Promise((r) => setTimeout(r, 5));
    p.begin('2.4.0');
    const second = p.snapshot();
    expect(second.steps).toEqual([]);
    expect(second.startedAt).not.toBe(first.startedAt);
  });

  test('lastRun is null until a run finishes, then carries the full steps and its origin version', async () => {
    const { createUpgradeProgress } = await loadStore();
    const p = createUpgradeProgress('2.4.1');
    expect(p.lastRun()).toBeNull();

    p.begin('2.4.0');
    p.record({ step: 'database', status: 'success', message: 'Schema up to date' });
    // Still running: nothing to replay yet.
    expect(p.lastRun()).toBeNull();

    p.finish();
    const last = p.lastRun();
    expect(last).not.toBeNull();
    // The origin version is captured, not re-read — the run overwrote the marker.
    expect(last!.fromVersion).toBe('2.4.0');
    expect(last!.steps[0].message).toBe('Schema up to date');
  });

  test('deployWentWell is the replay guard: skipped blocks a replay, warning does not', async () => {
    const { deployWentWell } = await loadStore();
    expect(deployWentWell([{ step: 'database', status: 'success' }])).toBe(true);
    // The global-MCP shadow check is advisory.
    expect(deployWentWell([
      { step: 'database', status: 'success' },
      { step: 'mcp-shadow-check', status: 'warning' },
    ])).toBe(true);
    // A skipped re-embed (Ollama still starting) must NOT be replayed, or Retry
    // would return the same failure forever.
    expect(deployWentWell([
      { step: 'database', status: 'success' },
      { step: 'reembed', status: 'skipped' },
    ])).toBe(false);
    expect(deployWentWell([{ step: 'skills', status: 'error' }])).toBe(false);
  });

  test('snapshot is a copy — callers cannot mutate the live state', async () => {
    const { createUpgradeProgress } = await loadStore();
    const p = createUpgradeProgress('2.4.1');
    p.begin(null);
    p.record({ step: 'skills', status: 'success' });

    const s = p.snapshot();
    s.steps.push({ step: 'hooks', status: 'error' });
    expect(p.snapshot().steps).toHaveLength(1);

    p.steps().push({ step: 'hooks', status: 'error' });
    expect(p.steps()).toHaveLength(1);

    p.finish();
    p.lastRun()!.steps.push({ step: 'hooks', status: 'error' });
    expect(p.lastRun()!.steps).toHaveLength(1);
  });
});
