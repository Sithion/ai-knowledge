import { test, expect } from '@playwright/test';
import { ConfigManager } from '@cognistore/config';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Feature 1 — global hook injection into a settings.json. Uses explicit temp paths
// (injectHooks/removeHooks are parameterized), so the real ~/.claude is untouched.

let dir: string;
let settings: string;
const cm = new ConfigManager();
const userHookCmd = '/usr/local/bin/my-user-hook.sh';

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cog-hooks-'));
  settings = join(dir, 'settings.json');
});
test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function cogHookCount(cfg: any): number {
  const all = Object.values(cfg.hooks ?? {}).flat() as any[];
  return all.filter((g) => JSON.stringify(g).includes(ConfigManager.COGNISTORE_HOOKS_DIR)).length;
}

test('injectHooks creates settings.json with cognistore hooks when none exists', async () => {
  const r = await cm.injectHooks(settings, ConfigManager.buildClaudeHookConfig(ConfigManager.CLAUDE_HOOKS_DIR));
  expect(r.action).toBe('created');
  const cfg = JSON.parse(readFileSync(settings, 'utf-8'));
  expect(cogHookCount(cfg)).toBeGreaterThan(0);
  expect(cfg.hooks.PreToolUse.length).toBeGreaterThan(0);
});

test('injectHooks is idempotent and preserves user hooks + other keys', async () => {
  writeFileSync(settings, JSON.stringify({
    permissions: { allow: ['Bash(ls)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: userHookCmd }] }] },
  }));

  const cfg = ConfigManager.buildClaudeHookConfig(ConfigManager.CLAUDE_HOOKS_DIR);
  const first = await cm.injectHooks(settings, cfg);
  const second = await cm.injectHooks(settings, cfg);
  expect(first.action).toBe('updated');
  expect(second.action).toBe('skipped'); // idempotent — strip-then-append yields identical output

  const after = JSON.parse(readFileSync(settings, 'utf-8'));
  expect(after.permissions.allow).toContain('Bash(ls)');
  expect(JSON.stringify(after.hooks.PreToolUse)).toContain(userHookCmd); // user hook survived
  // No duplicate cognistore groups across re-runs.
  const ptuCog = after.hooks.PreToolUse.filter((g: any) => JSON.stringify(g).includes(ConfigManager.COGNISTORE_HOOKS_DIR)).length;
  expect(ptuCog).toBe(5);
});

test('removeHooks strips only cognistore entries, leaving user hooks intact', async () => {
  writeFileSync(settings, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: userHookCmd }] }] },
  }));
  await cm.injectHooks(settings, ConfigManager.buildClaudeHookConfig(ConfigManager.CLAUDE_HOOKS_DIR));

  const r = await cm.removeHooks(settings);
  expect(r.removed).toBe(true);

  const after = JSON.parse(readFileSync(settings, 'utf-8'));
  expect(cogHookCount(after)).toBe(0);
  expect(JSON.stringify(after.hooks?.PreToolUse ?? [])).toContain(userHookCmd);
  // Cognistore-only events (UserPromptSubmit/Stop) should be gone entirely.
  expect(after.hooks.UserPromptSubmit).toBeUndefined();
  expect(after.hooks.Stop).toBeUndefined();
});

test('removeHooks is a no-op when there are no cognistore hooks', async () => {
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: userHookCmd }] }] } }));
  const r = await cm.removeHooks(settings);
  expect(r.removed).toBe(false);
});
