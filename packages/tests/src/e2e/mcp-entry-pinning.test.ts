import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MCP_PACKAGE,
  UNKNOWN_VERSION,
  buildMcpEntry,
  clearPublishedCache,
  detectGlobalMcpShadow,
  getDeployedVersion,
  resolveMcpSpec,
  saveDeployedVersion,
  versionFile,
} from '../../../../apps/dashboard/server/mcp-entry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Regression coverage for the version-skew deadlock: an unversioned
// `npx -y @cognistore/mcp-server` let npm exec run a stale globally-installed bin
// from PATH, so agents talked to an old tool schema while the deployed hooks came
// from a newer release. See PATCH-NOTES v2.3.6.

function tmpInstallDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'cognistore-mcp-entry-'));
}

test.describe('@e2e MCP entry pinning', () => {
  test.beforeEach(() => clearPublishedCache());

  test('pins to the app version when it is published', () => {
    const spec = resolveMcpSpec('2.3.6', () => true);
    expect(spec).toBe(`${MCP_PACKAGE}@2.3.6`);
  });

  test('falls back to @latest when the version is not published yet', () => {
    // Happens for source builds and between a desktop release and the npm publish
    // job. A pin to an unpublished version would 404 and kill the MCP server.
    const spec = resolveMcpSpec('9.9.9', () => false);
    expect(spec).toBe(`${MCP_PACKAGE}@latest`);
  });

  test('never emits an unversioned or 0.0.0 spec', () => {
    for (const version of [UNKNOWN_VERSION, '']) {
      const spec = resolveMcpSpec(version, () => true);
      expect(spec).toBe(`${MCP_PACKAGE}@latest`);
      expect(spec).not.toBe(MCP_PACKAGE);
      expect(spec).not.toContain(UNKNOWN_VERSION);
    }
  });

  test('entry carries the pinned spec and forces install scripts on', () => {
    const entry = buildMcpEntry({
      platform: 'claude-code',
      installDir: '/tmp/cognistore-test',
      binDir: null,
      spec: `${MCP_PACKAGE}@2.3.6`,
      env: {},
    });

    expect(entry.args).toEqual(['-y', `${MCP_PACKAGE}@2.3.6`]);
    // Without this, a user with `ignore-scripts=true` in ~/.npmrc gets a server
    // that starts but cannot open the DB (better-sqlite3 binding never builds).
    expect(entry.env.npm_config_ignore_scripts).toBe('false');
    expect(entry.env.COGNISTORE_PLATFORM).toBe('claude-code');
    expect(entry.command).toBe('npx');
  });

  test('entry uses the nvm npx path and PATH when a bin dir is given', () => {
    const entry = buildMcpEntry({
      platform: 'copilot',
      installDir: '/tmp/cognistore-test',
      binDir: '/nvm/v24.14.0/bin',
      spec: `${MCP_PACKAGE}@latest`,
      env: {},
    });

    expect(entry.command).toBe(resolve('/nvm/v24.14.0/bin', 'npx'));
    expect(entry.env.PATH?.startsWith('/nvm/v24.14.0/bin:')).toBe(true);
  });

  test('forwards provider secrets but not unrelated env', () => {
    const entry = buildMcpEntry({
      platform: 'opencode',
      installDir: '/tmp/cognistore-test',
      binDir: null,
      spec: `${MCP_PACKAGE}@latest`,
      env: { COGNISTORE_PROVIDER_SECRET__ACME: 'tok', UNRELATED: 'nope' },
    });

    expect(entry.env.COGNISTORE_PROVIDER_SECRET__ACME).toBe('tok');
    expect(entry.env.UNRELATED).toBeUndefined();
  });
});

test.describe('@e2e deployed-version marker', () => {
  test('writes the version on a clean deploy', () => {
    const dir = tmpInstallDir();
    try {
      expect(saveDeployedVersion(dir, '2.3.6', [{ status: 'success' }])).toBe(true);
      expect(getDeployedVersion(dir)).toBe('2.3.6');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to persist an unknown version', () => {
    // This is the bug that froze every deployed artifact: a shipped build that
    // could not read its own package.json wrote 0.0.0, after which
    // compareSemver('0.0.0','0.0.0') > 0 was false forever and no upgrade ran.
    const dir = tmpInstallDir();
    try {
      expect(saveDeployedVersion(dir, UNKNOWN_VERSION)).toBe(false);
      expect(getDeployedVersion(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to record success when a step errored', () => {
    const dir = tmpInstallDir();
    try {
      const wrote = saveDeployedVersion(dir, '2.3.6', [
        { status: 'success' },
        { status: 'error' },
      ]);
      expect(wrote).toBe(false);
      // A missing marker re-runs the upgrade; a marker claiming success does not.
      expect(getDeployedVersion(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a warning step does not block the version write', () => {
    const dir = tmpInstallDir();
    try {
      expect(saveDeployedVersion(dir, '2.3.6', [{ status: 'warning' }])).toBe(true);
      expect(readFileSync(versionFile(dir), 'utf-8')).toBe('2.3.6');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('@e2e global shadow detection', () => {
  test('reports a divergent global install', () => {
    const json = JSON.stringify({ dependencies: { [MCP_PACKAGE]: { version: '1.1.0' } } });
    expect(detectGlobalMcpShadow('2.3.6', () => json)).toBe('1.1.0');
  });

  test('stays quiet when the global install matches', () => {
    const json = JSON.stringify({ dependencies: { [MCP_PACKAGE]: { version: '2.3.6' } } });
    expect(detectGlobalMcpShadow('2.3.6', () => json)).toBeNull();
  });

  test('never throws when npm is missing or output is junk', () => {
    expect(detectGlobalMcpShadow('2.3.6', () => 'not json')).toBeNull();
    expect(detectGlobalMcpShadow('2.3.6', () => { throw new Error('npm not found'); })).toBeNull();
  });
});

test.describe('@e2e generated configs stay pinned', () => {
  test('setupOpenCodeMcp keeps the caller command instead of the hardcoded npx', async () => {
    const { ConfigManager } = await import('@cognistore/config');

    const home = mkdtempSync(resolve(tmpdir(), 'cognistore-opencode-'));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      // ConfigManager resolves its static paths from homedir() at import time in
      // some builds, so assert against whatever path it reports back.
      const cm = new ConfigManager();
      const entry = buildMcpEntry({
        platform: 'opencode',
        installDir: home,
        binDir: '/nvm/v24.14.0/bin',
        spec: `${MCP_PACKAGE}@2.3.6`,
        env: {},
      });

      const result = await cm.setupOpenCodeMcp(entry as unknown as Record<string, unknown>);
      const written = JSON.parse(readFileSync(result.path, 'utf-8'));
      const command: string[] = written.mcp.cognistore.command;

      expect(command).toEqual([resolve('/nvm/v24.14.0/bin', 'npx'), '-y', `${MCP_PACKAGE}@2.3.6`]);
      // The old hardcoded literal discarded both the pinned npx path and the spec.
      expect(command).not.toEqual(['npx', '-y', MCP_PACKAGE]);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test.describe('@e2e sidecar version bundling', () => {
  test('tauri bundles package.json so the runtime fallback can resolve', () => {
    // The packaged sidecar runs from Resources/dist-server/, so it looked for
    // Resources/package.json — which was never copied. That silently pinned the
    // app at 0.0.0 and disabled the upgrade system entirely.
    const conf = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../apps/dashboard/src-tauri/tauri.conf.json'), 'utf-8')
    );
    expect(conf.bundle.resources['../package.json']).toBe('package.json');
  });

  test('tsup inlines __APP_VERSION__ at build time', () => {
    const tsup = readFileSync(
      resolve(__dirname, '../../../../apps/dashboard/tsup.sidecar.ts'),
      'utf-8'
    );
    expect(tsup).toContain('__APP_VERSION__');
  });

  test('the sidecar is launched with COGNISTORE_MANAGED', () => {
    // Gates the startup self-heal so the e2e suite (which spawns the same server
    // against the developer's real HOME) never rewrites their agent configs.
    const rs = readFileSync(
      resolve(__dirname, '../../../../apps/dashboard/src-tauri/src/sidecar.rs'),
      'utf-8'
    );
    expect(rs).toContain('COGNISTORE_MANAGED');
  });
});
