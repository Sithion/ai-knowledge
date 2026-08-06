import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Persisted user settings (`~/.cognistore/settings.json`).
 *
 * Extracted from index.ts so the validation below can be unit-tested: everything
 * inside `start()` is a closure and can only be reached by booting a real
 * server. That matters more now than it did — these values used to be inert
 * display preferences, but the cleanup settings drive scheduling, a deletion
 * predicate and an `ollama rm` argument, so they are load-bearing.
 */

/**
 * Install directory, overridable via COGNISTORE_HOME.
 *
 * The override exists for tests: the e2e suite spawns this server with
 * SQLITE_PATH pointed at a tmpdir, but every other path here is derived from
 * `homedir()`, so a route that persists a setting (the cleanup scheduler does)
 * writes into the developer's real ~/.cognistore/settings.json on every run.
 * Production never sets it — the Tauri shell relies on the default.
 */
const INSTALL_DIR = process.env.COGNISTORE_HOME
  ? resolve(process.env.COGNISTORE_HOME)
  : resolve(homedir(), '.cognistore');
const SETTINGS_FILE = resolve(INSTALL_DIR, 'settings.json');

export interface AppSettings {
  autoUpdate: boolean;
  dateRangePreset: '1d' | '1w' | '1m' | '1y' | '2y' | 'custom';
  lastSelectedRange: { from: string; to: string } | null;
  tokenProviderFilter: 'all' | 'claude' | 'copilot';
  alwaysSearchExternalProviders: boolean;

  // ─── External-provider security policy ───
  // Installation-scoped on purpose: the sidecar and the MCP server both load the
  // same providers.json, so a per-process env flag would make them disagree
  // about which providers exist. See packages/providers/src/policy.ts.
  /** Permit `transport: 'stdio'` providers — these run an arbitrary local command. */
  allowStdioProviders: boolean;
  /** Permit `auth.allowInsecure` — this disables the https and private-network guards. */
  allowInsecureProviderUrls: boolean;

  // ─── Cleanup cycle ───
  /** Master switch for the periodic cleanup report. */
  cleanupEnabled: boolean;
  /** Minimum days between reports. The cycle only advances while the app runs, so this is a floor, not a schedule. */
  cleanupIntervalDays: number;
  /** How long an entry must go unretrieved before it becomes a candidate. */
  cleanupUnreadDays: number;
  /** Similarity above which entries are proposed for consolidation. */
  cleanupDupThreshold: number;
  /** Ollama chat model used to draft merges. */
  cleanupLlmModel: string;
  /** When the last report was generated. Persisted so the interval survives restarts. */
  lastCleanupReportAt: string | null;
}

export const SETTINGS_DEFAULTS: AppSettings = {
  autoUpdate: false,
  dateRangePreset: '1w',
  lastSelectedRange: null,
  tokenProviderFilter: 'all',
  alwaysSearchExternalProviders: false,
  // Both default OFF: each one re-opens a capability this release closed.
  allowStdioProviders: false,
  allowInsecureProviderUrls: false,
  cleanupEnabled: true,
  cleanupIntervalDays: 10,
  cleanupUnreadDays: 180,
  cleanupDupThreshold: 0.92,
  cleanupLlmModel: 'llama3.2:3b',
  lastCleanupReportAt: null,
};

/**
 * An Ollama model reference: `name`, `name:tag`.
 *
 * This value reaches `execFile('ollama', ['rm', model])` during uninstall, and
 * it arrives from a file the user can edit and from `PUT /api/settings`. The
 * allow-list keeps it a model name and nothing else — no shell metacharacters,
 * no flags, no paths.
 */
// Must start alphanumeric: `execFile` uses no shell, so injection is already
// impossible, but a leading dash would still be read by ollama as an option.
export const OLLAMA_MODEL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(:[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;
export const MAX_MODEL_NAME_LENGTH = 100;

export function isValidOllamaModelName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_MODEL_NAME_LENGTH
    && OLLAMA_MODEL_NAME_RE.test(value);
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const clampFloat = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * Coerce a settings patch into safe bounds.
 *
 * Applied on write AND on read, because settings.json is a plain file the user
 * can edit. Out-of-range values are not cosmetic here: `cleanupUnreadDays: -1`
 * would put the cutoff in the future and make every entry a deletion candidate,
 * and `cleanupDupThreshold: 0` would make every pair a duplicate group.
 * Unknown keys are preserved so unrelated settings still round-trip.
 */
export function sanitizeSettings<T extends Partial<AppSettings>>(patch: T): T {
  const out: Record<string, unknown> = { ...patch };

  if ('cleanupEnabled' in out) out.cleanupEnabled = Boolean(out.cleanupEnabled);
  if ('cleanupIntervalDays' in out) {
    out.cleanupIntervalDays = clampInt(out.cleanupIntervalDays, 1, 365, SETTINGS_DEFAULTS.cleanupIntervalDays);
  }
  if ('cleanupUnreadDays' in out) {
    out.cleanupUnreadDays = clampInt(out.cleanupUnreadDays, 30, 3650, SETTINGS_DEFAULTS.cleanupUnreadDays);
  }
  if ('cleanupDupThreshold' in out) {
    out.cleanupDupThreshold = clampFloat(out.cleanupDupThreshold, 0.8, 1, SETTINGS_DEFAULTS.cleanupDupThreshold);
  }
  if ('cleanupLlmModel' in out && !isValidOllamaModelName(out.cleanupLlmModel)) {
    out.cleanupLlmModel = SETTINGS_DEFAULTS.cleanupLlmModel;
  }
  if ('lastCleanupReportAt' in out) {
    const v = out.lastCleanupReportAt;
    out.lastCleanupReportAt = typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
  }

  return out as T;
}

export function readSettings(): AppSettings {
  try {
    if (!existsSync(SETTINGS_FILE)) return { ...SETTINGS_DEFAULTS };
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) as Partial<AppSettings>;
    return { ...SETTINGS_DEFAULTS, ...sanitizeSettings(parsed) };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

export function writeSettings(patch: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = { ...readSettings(), ...sanitizeSettings(patch) };
  mkdirSync(INSTALL_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  try {
    renameSync(tmp, SETTINGS_FILE);
  } catch {
    copyFileSync(tmp, SETTINGS_FILE);
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
  return merged;
}

export { SETTINGS_FILE, INSTALL_DIR };
