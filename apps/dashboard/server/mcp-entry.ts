/**
 * MCP server entry generation + deployed-version bookkeeping.
 *
 * These live outside `server/index.ts` on purpose: that module calls `start()` at
 * import time, so anything defined inside it boots a listening Fastify server and
 * cannot be unit-tested. Everything here is a pure function over explicit inputs.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Sentinel for "we could not figure out which version we are". */
export const UNKNOWN_VERSION = '0.0.0';

export const MCP_PACKAGE = '@cognistore/mcp-server';

/** Milliseconds we are willing to block on the npm registry during config writes. */
const NPM_VIEW_TIMEOUT_MS = 4000;

const publishedCache = new Map<string, boolean>();

/** Reset the memoised `npm view` results (tests only). */
export function clearPublishedCache(): void {
  publishedCache.clear();
}

/**
 * Best-effort check that `<MCP_PACKAGE>@<version>` exists on the registry.
 * Network failures answer `false` — callers must degrade to a spec that always
 * resolves rather than emit a pin that would 404.
 */
export function isMcpVersionPublished(
  version: string,
  runner: (spec: string) => string = defaultNpmView
): boolean {
  const cached = publishedCache.get(version);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    ok = runner(`${MCP_PACKAGE}@${version}`).trim().length > 0;
  } catch {
    ok = false;
  }
  publishedCache.set(version, ok);
  return ok;
}

function defaultNpmView(spec: string): string {
  return execFileSync('npm', ['view', spec, 'version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: NPM_VIEW_TIMEOUT_MS,
  });
}

/**
 * Pick the package spec to put in a generated MCP config.
 *
 * ALWAYS returns a versioned spec. An unversioned `@cognistore/mcp-server` lets
 * `npm exec` resolve a stale globally-installed bin from PATH instead of the
 * registry, which silently pins agents to an ancient tool schema. Falls back to
 * `@latest` (not to the bare name) when the running version is unknown or not
 * published yet — the latter happens for source builds and in the window between
 * a desktop release and the npm publish job.
 */
export function resolveMcpSpec(
  version: string,
  isPublished: (v: string) => boolean = isMcpVersionPublished
): string {
  if (!version || version === UNKNOWN_VERSION) return `${MCP_PACKAGE}@latest`;
  return isPublished(version) ? `${MCP_PACKAGE}@${version}` : `${MCP_PACKAGE}@latest`;
}

export interface McpEntryOptions {
  platform: 'claude-code' | 'copilot' | 'opencode';
  installDir: string;
  /** nvm bin dir for the required Node major, or null to use whatever `npx` is on PATH. */
  binDir: string | null;
  /** Package spec, from {@link resolveMcpSpec}. */
  spec: string;
  /** Defaults to `process.env`; injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the MCP server entry, pinned to the required Node major's npx path.
 * When that Node is found via nvm we use its `npx` binary and prepend its bin dir
 * to PATH, since npx delegates to whatever `node` is in PATH rather than its own
 * binary. better-sqlite3 is an external dep of the MCP server, so npx rebuilds it
 * against this Node, keeping the MCP child on the same major as the sidecar.
 */
export function buildMcpEntry(opts: McpEntryOptions) {
  const { platform, installDir, binDir, spec } = opts;
  const processEnv = opts.env ?? process.env;

  const env: Record<string, string> = {
    SQLITE_PATH: resolve(installDir, 'knowledge.db'),
    OLLAMA_HOST: processEnv.OLLAMA_HOST || 'http://localhost:11434',
    OLLAMA_MODEL: processEnv.OLLAMA_MODEL || 'nomic-embed-text',
    EMBEDDING_DIMENSIONS: processEnv.EMBEDDING_DIMENSIONS || '256',
    // Provenance: stamps which host app created each entry/plan via this config.
    COGNISTORE_PLATFORM: platform,
    // A version pin forces npx to populate a fresh cache entry, which must build
    // better-sqlite3. Users who harden ~/.npmrc with `ignore-scripts=true` would
    // otherwise get a server that starts but cannot open the database
    // ("Could not locate the bindings file"). Scoped to this subprocess only.
    npm_config_ignore_scripts: 'false',
  };
  if (binDir) {
    // Use a broad fallback PATH to cover common executable locations (mac + linux).
    env.PATH = `${binDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  }
  // Forward external-provider secrets (injected into the sidecar by the Tauri
  // shell from the OS keychain) so the MCP subprocess can authenticate.
  for (const [key, val] of Object.entries(processEnv)) {
    if (key.startsWith('COGNISTORE_PROVIDER_SECRET__') && val) env[key] = val;
  }

  return {
    type: 'stdio',
    command: binDir ? resolve(binDir, 'npx') : 'npx',
    args: ['-y', spec],
    env,
  };
}

/** Path of the deployed-version marker inside an install dir. */
export function versionFile(installDir: string): string {
  return resolve(installDir, '.version');
}

/** Read the last deployed version, or null when never written. */
export function getDeployedVersion(installDir: string): string | null {
  try {
    return readFileSync(versionFile(installDir), 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Persist `version` as deployed. Refuses to write an unknown version, or to
 * record success when a deploy step failed.
 *
 * This guard is the whole point: a MISSING marker is recoverable (it reads as a
 * first install), but a marker holding {@link UNKNOWN_VERSION} makes every later
 * `needsUpgrade` comparison false and permanently freezes deployed artifacts —
 * hooks, skills and MCP configs — at whatever shipped first.
 */
export function saveDeployedVersion(
  installDir: string,
  version: string,
  steps: { status: string }[] = []
): boolean {
  if (!version || version === UNKNOWN_VERSION) return false;
  if (steps.some((s) => s.status === 'error')) return false;
  mkdirSync(installDir, { recursive: true });
  writeFileSync(versionFile(installDir), version);
  return true;
}

/**
 * Detect a globally-installed MCP server whose version differs from the app's.
 * Such an install puts `cognistore-mcp` on PATH, where `npm exec` finds it before
 * consulting the registry. Returns the offending version, or null.
 *
 * Warn-only by design: the app never mutates the user's global npm.
 */
export function detectGlobalMcpShadow(
  appVersion: string,
  runner: () => string = defaultNpmLsGlobal
): string | null {
  try {
    const parsed = JSON.parse(runner());
    const installed: string | undefined = parsed?.dependencies?.[MCP_PACKAGE]?.version;
    if (!installed) return null;
    return installed === appVersion ? null : installed;
  } catch {
    return null;
  }
}

function defaultNpmLsGlobal(): string {
  return execFileSync('npm', ['ls', '-g', '--depth=0', '--json', MCP_PACKAGE], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: NPM_VIEW_TIMEOUT_MS,
  });
}
