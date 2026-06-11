import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Each platform exposes the cognistore MCP tools under its own naming
// convention (Claude Code: mcp__cognistore__<tool>, Copilot CLI:
// cognistore-<tool>, OpenCode: cognistore_<tool>). The instruction compiler
// must rewrite the canonical names per platform — shipping Claude-style names
// to Copilot produced real "Tool does not exist" failures in the field.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIGS_DIR = resolve(__dirname, '../../../../apps/dashboard/templates/configs');
const HOOKS_DIR = resolve(__dirname, '../../../../apps/dashboard/templates/hooks');

function compileInTemp(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'cognistore-compile-'));
  copyFileSync(join(CONFIGS_DIR, '_base-instructions.md'), join(tmp, '_base-instructions.md'));
  copyFileSync(join(CONFIGS_DIR, 'compile-instructions.mjs'), join(tmp, 'compile-instructions.mjs'));
  execSync('node compile-instructions.mjs', { cwd: tmp, env: { ...process.env, NODE_OPTIONS: '' } });
  return tmp;
}

test('compiler rewrites tool names per platform', () => {
  const tmp = compileInTemp();
  try {
    const claude = readFileSync(join(tmp, 'claude-code-instructions.md'), 'utf-8');
    const copilot = readFileSync(join(tmp, 'copilot-instructions.md'), 'utf-8');
    const opencode = readFileSync(join(tmp, 'opencode-instructions.md'), 'utf-8');

    // Claude keeps the canonical form.
    expect(claude).toContain('mcp__cognistore__getKnowledge');

    // Copilot: hyphen form only — no Claude-style residue anywhere.
    expect(copilot).toContain('cognistore-getKnowledge');
    expect(copilot).not.toContain('mcp__cognistore__');

    // OpenCode: underscore form only.
    expect(opencode).toContain('cognistore_getKnowledge');
    expect(opencode).not.toContain('mcp__cognistore__');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copilot post-tool-marker sets -queried for the REAL Copilot tool name', () => {
  const sid = `tooltest${process.pid}${Math.floor(Math.random() * 1e6)}`;
  const marker = `/tmp/.cognistore-copilot-${sid}-queried`;
  try {
    // Regression: the marker used to match only mcp__cognistore__getKnowledge,
    // a name that never occurs in Copilot — so the reminder never went quiet.
    execSync(`bash ${join(HOOKS_DIR, 'copilot/post-tool-marker.sh')}`, {
      input: JSON.stringify({ session_id: sid, tool_name: 'cognistore-getKnowledge' }),
    });
    expect(existsSync(marker)).toBe(true);

    // Old Claude-style name still accepted (compat).
    rmSync(marker, { force: true });
    execSync(`bash ${join(HOOKS_DIR, 'copilot/post-tool-marker.sh')}`, {
      input: JSON.stringify({ session_id: sid, tool_name: 'mcp__cognistore__getKnowledge' }),
    });
    expect(existsSync(marker)).toBe(true);
  } finally {
    execSync(`rm -f /tmp/.cognistore-copilot-${sid}*`);
  }
});

test('copilot pre-tool-check exempts cognistore- tools and reminds with the right name', () => {
  const sid = `tooltest${process.pid}${Math.floor(Math.random() * 1e6)}`;
  const hook = join(HOOKS_DIR, 'copilot/pre-tool-check.sh');
  // The reminder only fires when the knowledge DB exists (cog_db_present) —
  // point SQLITE_PATH at any existing file so the test works on CI too.
  const env = { ...process.env, SQLITE_PATH: hook };
  try {
    // cognistore-* tools are exempt — no reminder.
    const exempt = execSync(`bash ${hook}`, {
      input: JSON.stringify({ session_id: sid, tool_name: 'cognistore-addKnowledge' }),
      env,
    }).toString();
    expect(exempt.trim()).toBe('{}');

    // An edit/exec tool gets the reminder, and it names the Copilot form.
    const reminded = execSync(`bash ${hook}`, {
      input: JSON.stringify({ session_id: sid, tool_name: 'bash' }),
      env,
    }).toString();
    expect(reminded).toContain('cognistore-getKnowledge');
    expect(reminded).not.toContain('mcp__cognistore__');
  } finally {
    execSync(`rm -f /tmp/.cognistore-copilot-${sid}*`);
  }
});

test('copilot user-prompt-check escapes multi-line DB content into VALID JSON (macOS/BSD-sed regression)', () => {
  // Regression: the hook used the GNU-only sed idiom `:a;N;$!ba` to fold
  // newlines, which errors on macOS/BSD sed and emitted a raw newline inside the
  // JSON string → Copilot silently dropped the [COGNISTORE-PROTOCOL]. The awk
  // escape must produce a single line of valid JSON with literal \n, on any sed.
  const sid = `prompttest${process.pid}${Math.floor(Math.random() * 1e6)}`;
  const hook = join(HOOKS_DIR, 'copilot/user-prompt-check.sh');
  const dbPath = join(tmpdir(), `cognistore-hook-${sid}.db`);
  // Content with the exact chars that break naive escaping: backslash, double
  // quote, and multiple newlines.
  const content = 'line one with "quotes"\nline two with \\ backslash\nline three';
  try {
    if (!sqlite3Available()) test.skip();
    // Feed SQL via stdin (NOT the shell) so the content's quotes/newlines reach
    // SQLite verbatim instead of being mangled by shell word-splitting.
    const sql = `CREATE TABLE knowledge_entries(type TEXT, content TEXT);\nINSERT INTO knowledge_entries(type, content) VALUES('system', ${sqlLiteral(content)});`;
    execSync(`sqlite3 ${JSON.stringify(dbPath)}`, { input: sql });

    const out = execSync(`bash ${hook}`, {
      input: JSON.stringify({ session_id: sid }),
      env: { ...process.env, SQLITE_PATH: dbPath },
    }).toString().trim();

    // Single line, valid JSON, and the multi-line content survived as \n.
    expect(out.split('\n')).toHaveLength(1);
    const parsed = JSON.parse(out);
    expect(parsed.systemMessage).toContain('[COGNISTORE-PROTOCOL]');
    expect(parsed.systemMessage).toContain('line one with "quotes"');
    expect(parsed.systemMessage).toContain('line two with \\ backslash');
  } finally {
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    execSync(`rm -f /tmp/.cognistore-copilot-${sid}*`);
  }
});

function sqlite3Available(): boolean {
  try { execSync('command -v sqlite3', { stdio: 'ignore' }); return true; } catch { return false; }
}
function sqlLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
