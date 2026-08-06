import { test, expect } from '@playwright/test';
import { ConfigManager } from '@cognistore/config';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Claude Code permission injection into a settings.json. injectPermissions /
// removePermissions are parameterized on the settings path, so the real
// ~/.claude is never touched. Verifies the server-scope rule replaces the old
// per-tool list and migrates legacy installs without clobbering user rules.

let dir: string;
let settings: string;
const cm = new ConfigManager();

// The single server-scope rule that pre-approves every cognistore tool.
const SERVER_RULE = 'mcp__cognistore';
// A representative subset of the superseded per-tool rules an existing user has.
const LEGACY_RULES = [
  'mcp__cognistore__getKnowledge',
  'mcp__cognistore__addKnowledge',
  'mcp__cognistore__deleteKnowledge',
  'mcp__cognistore__createPlan',
];
// A granular rule from an older app version that was never in today's list.
const LEGACY_ORPHAN = 'mcp__cognistore__oldTool';
const USER_RULE = 'Bash(ls)';
// Hyphenated lookalike from a hypothetical different server — must survive.
const LOOKALIKE = 'mcp__cognistore-plus__x';

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cog-perms-'));
  settings = join(dir, 'settings.json');
});
test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function bakCount(): number {
  return readdirSync(dir).filter((f) => f.includes('settings.json.bak.')).length;
}

test('injectPermissions creates settings.json with the server-scope rule when none exists', async () => {
  const r = await cm.injectPermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);
  expect(r.action).toBe('created');

  const cfg = JSON.parse(readFileSync(settings, 'utf-8'));
  expect(cfg.permissions.allow).toEqual([SERVER_RULE]);
  // A freshly-created file needs no backup — there was nothing to preserve.
  expect(bakCount()).toBe(0);
});

test('injectPermissions migrates legacy per-tool rules, preserving user rules and other keys', async () => {
  writeFileSync(settings, JSON.stringify({
    permissions: { allow: [...LEGACY_RULES, LEGACY_ORPHAN, USER_RULE, LOOKALIKE] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
    model: 'opus',
  }));

  const r = await cm.injectPermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);
  expect(r.action).toBe('updated');
  expect(bakCount()).toBe(1);

  const cfg = JSON.parse(readFileSync(settings, 'utf-8'));
  const allow: string[] = cfg.permissions.allow;
  // Every legacy per-tool rule (incl. the orphan) is stripped...
  for (const rule of [...LEGACY_RULES, LEGACY_ORPHAN]) expect(allow).not.toContain(rule);
  // ...replaced by the single server-scope rule...
  expect(allow).toContain(SERVER_RULE);
  // ...while user rules, the hyphen lookalike, and other top-level keys survive.
  expect(allow).toContain(USER_RULE);
  expect(allow).toContain(LOOKALIKE);
  expect(cfg.hooks.PreToolUse.length).toBe(1);
  expect(cfg.model).toBe('opus');
});

test('injectPermissions is idempotent — no new backup once migrated', async () => {
  writeFileSync(settings, JSON.stringify({ permissions: { allow: [...LEGACY_RULES] } }));

  const first = await cm.injectPermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);
  const second = await cm.injectPermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);
  const third = await cm.injectPermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);

  expect(first.action).toBe('updated');   // migration happened
  expect(second.action).toBe('skipped');  // nothing to add and nothing to strip
  expect(third.action).toBe('skipped');
  // Backup count stays at exactly 1 across repeated runs — no .bak accumulation.
  expect(bakCount()).toBe(1);
});

test('injectPermissions skips a file already holding the server-scope rule AND the deny entries', async () => {
  writeFileSync(settings, JSON.stringify({
    permissions: {
      allow: [SERVER_RULE, USER_RULE],
      deny: [...ConfigManager.COGNISTORE_DENY_TOOLS],
    },
  }));

  const r = await cm.injectPermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);
  expect(r.action).toBe('skipped');
  expect(bakCount()).toBe(0);
});

test('injectPermissions denies the destructive tools back out of the whole-server allow', async () => {
  // The allow rule stays whole-server on purpose: a per-tool allow list would
  // match COGNISTORE_LEGACY_ALLOW_PREFIX and be stripped on the next deploy.
  // `deny` beats `allow`, so this is what makes deleteKnowledge prompt.
  writeFileSync(settings, JSON.stringify({ permissions: { allow: [USER_RULE] } }));

  await cm.injectPermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);

  const cfg = JSON.parse(readFileSync(settings, 'utf-8'));
  expect(cfg.permissions.allow).toContain(SERVER_RULE);
  for (const rule of ConfigManager.COGNISTORE_DENY_TOOLS) {
    expect(cfg.permissions.deny).toContain(rule);
  }

  // Idempotent: a second run adds nothing and takes no backup.
  const again = await cm.injectPermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);
  expect(again.action).toBe('skipped');
  const cfg2 = JSON.parse(readFileSync(settings, 'utf-8'));
  expect(cfg2.permissions.deny).toEqual(cfg.permissions.deny);
});

test('removePermissions takes our deny entries away again but leaves the user\'s', async () => {
  writeFileSync(settings, JSON.stringify({
    permissions: {
      allow: [SERVER_RULE, USER_RULE],
      deny: [...ConfigManager.COGNISTORE_DENY_TOOLS, 'Bash(rm -rf /)'],
    },
  }));

  await cm.removePermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);

  const cfg = JSON.parse(readFileSync(settings, 'utf-8'));
  expect(cfg.permissions.deny).toEqual(['Bash(rm -rf /)']);
});

test('injectPermissions never touches permissions.ask, and only ADDS to deny', async () => {
  writeFileSync(settings, JSON.stringify({
    permissions: {
      allow: [...LEGACY_RULES],
      deny: ['Bash(curl)'],
      ask: ['Bash(rm)'],
    },
  }));

  await cm.injectPermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);

  const cfg = JSON.parse(readFileSync(settings, 'utf-8'));
  // The user's own deny rule survives; ours are appended alongside it.
  expect(cfg.permissions.deny).toContain('Bash(curl)');
  for (const rule of ConfigManager.COGNISTORE_DENY_TOOLS) {
    expect(cfg.permissions.deny).toContain(rule);
  }
  expect(cfg.permissions.ask).toEqual(['Bash(rm)']);
});

test('removePermissions strips the server-scope rule + legacy leftovers, keeping user rules', async () => {
  writeFileSync(settings, JSON.stringify({
    permissions: { allow: [SERVER_RULE, ...LEGACY_RULES, USER_RULE, LOOKALIKE] },
  }));

  const r = await cm.removePermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);
  expect(r.removed).toBe(true);

  const cfg = JSON.parse(readFileSync(settings, 'utf-8'));
  const allow: string[] = cfg.permissions.allow;
  expect(allow).not.toContain(SERVER_RULE);
  for (const rule of LEGACY_RULES) expect(allow).not.toContain(rule);
  expect(allow).toContain(USER_RULE);
  expect(allow).toContain(LOOKALIKE);
});

test('removePermissions is a no-op when no cognistore rules are present', async () => {
  writeFileSync(settings, JSON.stringify({ permissions: { allow: [USER_RULE, LOOKALIKE] } }));

  const r = await cm.removePermissions(settings, ConfigManager.COGNISTORE_AUTO_ALLOW_TOOLS);
  expect(r.removed).toBe(false);
  expect(bakCount()).toBe(0);
});
