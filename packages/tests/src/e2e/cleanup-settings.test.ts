import { test, expect } from '@playwright/test';
import {
  sanitizeSettings,
  isValidOllamaModelName,
  SETTINGS_DEFAULTS,
} from '../../../../apps/dashboard/server/settings.js';
import { maybeGenerateReport } from '../../../../apps/dashboard/server/cleanup-routes.js';

/**
 * Settings validation and the scheduling predicate.
 *
 * These values used to be inert display preferences. The cleanup ones drive a
 * schedule, a deletion predicate and an `ollama rm` argument, and they arrive
 * both from an unvalidated HTTP body and from a file the user can edit by hand.
 */

test.describe('@e2e cleanup settings validation', () => {
  test('clamps the unread window into a sane range', () => {
    // A negative window puts the cutoff in the FUTURE, which would make every
    // entry in the base a deletion candidate.
    expect(sanitizeSettings({ cleanupUnreadDays: -100_000 }).cleanupUnreadDays).toBe(30);
    expect(sanitizeSettings({ cleanupUnreadDays: 5 }).cleanupUnreadDays).toBe(30);
    expect(sanitizeSettings({ cleanupUnreadDays: 99_999 }).cleanupUnreadDays).toBe(3650);
    expect(sanitizeSettings({ cleanupUnreadDays: 200 }).cleanupUnreadDays).toBe(200);
  });

  test('clamps the duplicate threshold, so everything cannot become a duplicate', () => {
    expect(sanitizeSettings({ cleanupDupThreshold: 0 }).cleanupDupThreshold).toBe(0.8);
    expect(sanitizeSettings({ cleanupDupThreshold: 5 }).cleanupDupThreshold).toBe(1);
    expect(sanitizeSettings({ cleanupDupThreshold: 0.95 }).cleanupDupThreshold).toBe(0.95);
  });

  test('clamps the interval and coerces the enabled flag', () => {
    expect(sanitizeSettings({ cleanupIntervalDays: 0 }).cleanupIntervalDays).toBe(1);
    expect(sanitizeSettings({ cleanupIntervalDays: 10_000 }).cleanupIntervalDays).toBe(365);
    expect(sanitizeSettings({ cleanupEnabled: 'yes' as any }).cleanupEnabled).toBe(true);
    expect(sanitizeSettings({ cleanupEnabled: 0 as any }).cleanupEnabled).toBe(false);
  });

  test('falls back to the default for non-numeric input', () => {
    expect(sanitizeSettings({ cleanupUnreadDays: NaN }).cleanupUnreadDays).toBe(SETTINGS_DEFAULTS.cleanupUnreadDays);
    expect(sanitizeSettings({ cleanupDupThreshold: 'abc' as any }).cleanupDupThreshold).toBe(SETTINGS_DEFAULTS.cleanupDupThreshold);
  });

  test('rejects a model name that is not a bare model reference', () => {
    // This value reaches execFile('ollama', ['rm', model]) during uninstall.
    expect(isValidOllamaModelName('llama3.2:3b')).toBe(true);
    expect(isValidOllamaModelName('qwen2.5-coder')).toBe(true);
    expect(isValidOllamaModelName('a; rm -rf /')).toBe(false);
    expect(isValidOllamaModelName('model && curl evil')).toBe(false);
    expect(isValidOllamaModelName('../../etc/passwd')).toBe(false);
    expect(isValidOllamaModelName('--flag')).toBe(false);
    expect(isValidOllamaModelName('$(whoami)')).toBe(false);
    expect(isValidOllamaModelName('')).toBe(false);
    expect(isValidOllamaModelName('x'.repeat(200))).toBe(false);
    expect(isValidOllamaModelName(42 as any)).toBe(false);
  });

  test('a rejected model name is replaced by the default, never persisted', () => {
    expect(sanitizeSettings({ cleanupLlmModel: 'evil; rm -rf ~' }).cleanupLlmModel)
      .toBe(SETTINGS_DEFAULTS.cleanupLlmModel);
  });

  test('rejects an unparseable report timestamp', () => {
    expect(sanitizeSettings({ lastCleanupReportAt: 'not a date' }).lastCleanupReportAt).toBeNull();
    const valid = new Date().toISOString();
    expect(sanitizeSettings({ lastCleanupReportAt: valid }).lastCleanupReportAt).toBe(valid);
  });

  test('leaves unrelated settings untouched', () => {
    const out = sanitizeSettings({ autoUpdate: true, tokenProviderFilter: 'claude' });
    expect(out).toEqual({ autoUpdate: true, tokenProviderFilter: 'claude' });
  });
});

test.describe('@e2e cleanup scheduling predicate', () => {
  const fakeSdk = (overrides: Record<string, any> = {}) => ({
    getLatestCleanupReport: () => null,
    generateCleanupReport: async () => ({ created: true, report: { id: 'r1', stats: { counts: {} } } }),
    closeCleanupReport: () => ({ removed: 0 }),
    ...overrides,
  });
  const noopLog = () => {};

  /**
   * In-memory settings. Never let this call the real accessors: the suite runs
   * against the developer's actual HOME, so the default writeSettings would
   * persist lastCleanupReportAt into their live ~/.cognistore/settings.json.
   */
  const fakeSettings = (over: Record<string, any> = {}) => {
    let state: any = {
      cleanupEnabled: true, cleanupIntervalDays: 10, cleanupUnreadDays: 180,
      cleanupDupThreshold: 0.92, cleanupLlmModel: 'llama3.2:3b',
      lastCleanupReportAt: null, ...over,
    };
    return {
      readSettings: () => state,
      writeSettings: (patch: any) => { state = { ...state, ...patch }; return state; },
      get current() { return state; },
    };
  };

  test('does nothing while a report is still open', async () => {
    const sdk = fakeSdk({
      getLatestCleanupReport: () => ({
        report: { id: 'open-1', status: 'open', createdAt: new Date().toISOString() },
      }),
      generateCleanupReport: async () => { throw new Error('must not generate'); },
    });
    const s = fakeSettings();
    const result = await maybeGenerateReport({ sdk, log: noopLog, ...s });
    expect(result.action).toBe('open-report');
  });

  test('auto-closes a report ignored for more than twice the interval', async () => {
    // Otherwise one ignored report blocks the cycle permanently: only one report
    // may be open, and the timestamp only advances when one is created.
    let closed = false;
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const sdk = fakeSdk({
      getLatestCleanupReport: () => ({ report: { id: 'stale', status: 'open', createdAt: old } }),
      closeCleanupReport: () => { closed = true; return { removed: 0 }; },
    });
    const s = fakeSettings();
    const result = await maybeGenerateReport({ sdk, log: noopLog, ...s });
    expect(closed).toBe(true);
    expect(result.action).toBe('generated');
  });

  test('never throws when generation fails', async () => {
    // It runs from a setInterval: an escaping rejection would take down the sidecar.
    const sdk = fakeSdk({ generateCleanupReport: async () => { throw new Error('db is gone'); } });
    const s = fakeSettings();
    const result = await maybeGenerateReport({ sdk, log: noopLog, ...s });
    expect(result.action).toBe('error');
  });
});
