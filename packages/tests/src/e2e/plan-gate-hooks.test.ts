import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Behavioral test for the CogniStore ExitPlanMode gate handshake. The gate
// (pre-exit-plan-check.sh) opens when the session marker
// /tmp/.cognistore-<sid>-plan-persisted exists. Regression coverage for v2.3.5:
// updatePlan() must ALSO open the gate (not just createPlan+planFilePath), the
// gate must NOT consume the marker (so retries stay open), and the marker must be
// reset per plan-mode cycle by pre-enter-plan-check.sh.

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = resolve(__dirname, '../../../../apps/dashboard/templates/hooks/claude-code');

// _common.sh hardcodes the marker base to /tmp (not $TMPDIR).
const markerBase = (sid: string) => `/tmp/.cognistore-${sid}`;

// Run a hook script with a JSON payload on stdin. The child env explicitly clears
// COGNISTORE_DISABLE_HOOKS so a developer who muted hooks in their shell can't turn
// the scripts into silent {} no-ops mid-test. (The ~/.cognistore/hooks-disabled
// file escape hatch would also no-op them — this test assumes it is absent.)
function runHook(script: string, payload: object): string {
  const env = { ...process.env };
  delete env.COGNISTORE_DISABLE_HOOKS;
  return execFileSync('bash', [join(HOOKS_DIR, script)], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf-8',
  });
}

// A realistic Claude Code PostToolUse envelope: tool_input holds the call args,
// tool_response holds the MCP result. The serialized plan inside tool_response is
// an *escaped* JSON string — mirrors what the hooks actually receive on stdin.
function updatePlanEnvelope(sid: string, planId: string, status?: string) {
  const input: Record<string, unknown> = { planId };
  if (status) input.status = status;
  const planJson = JSON.stringify({ id: planId, status: status ?? 'active' });
  return {
    session_id: sid,
    tool_name: 'mcp__cognistore__updatePlan',
    tool_input: input,
    tool_response: { content: [{ type: 'text', text: planJson }] },
  };
}

let sid: string;
let n = 0;

test.beforeEach(() => {
  // Unique per test so we never collide with a real concurrent Claude session's
  // /tmp/.cognistore-<uuid>-* markers.
  sid = `plan-gate-itest-${process.pid}-${n++}`;
});

test.afterEach(() => {
  for (const suffix of ['-plan-persisted', '-active-plan', '-edit-count', '-task-updated']) {
    rmSync(`${markerBase(sid)}${suffix}`, { force: true });
  }
});

test('updatePlan() opens the ExitPlanMode gate and the gate is not consumed', () => {
  // 1. No marker yet -> ExitPlanMode denied.
  const denied = runHook('pre-exit-plan-check.sh', { session_id: sid });
  expect(denied).toContain('"permissionDecision":"deny"');
  expect(existsSync(`${markerBase(sid)}-plan-persisted`)).toBe(false);

  // 2. A non-completion updatePlan persists a plan -> gate marker created, and the
  //    task-sync markers are seeded from planId (not the escaped tool_response id).
  const upd = runHook('post-update-plan-cleanup.sh', updatePlanEnvelope(sid, 'p1'));
  expect(upd.trim()).toBe('{}');
  expect(existsSync(`${markerBase(sid)}-plan-persisted`)).toBe(true);
  expect(existsSync(`${markerBase(sid)}-active-plan`)).toBe(true);

  // 3. ExitPlanMode now allowed, and the marker survives repeated checks (not
  //    consumed) so a retry after another PreToolUse denier stays open.
  expect(runHook('pre-exit-plan-check.sh', { session_id: sid }).trim()).toBe('{}');
  expect(runHook('pre-exit-plan-check.sh', { session_id: sid }).trim()).toBe('{}');
  expect(existsSync(`${markerBase(sid)}-plan-persisted`)).toBe(true);
});

test('EnterPlanMode resets the gate for the next plan-mode cycle', () => {
  runHook('post-update-plan-cleanup.sh', updatePlanEnvelope(sid, 'p1'));
  expect(existsSync(`${markerBase(sid)}-plan-persisted`)).toBe(true);

  // Entering a new plan-mode cycle clears the marker...
  runHook('pre-enter-plan-check.sh', { session_id: sid });
  expect(existsSync(`${markerBase(sid)}-plan-persisted`)).toBe(false);

  // ...so ExitPlanMode requires a fresh persist.
  expect(runHook('pre-exit-plan-check.sh', { session_id: sid })).toContain('"permissionDecision":"deny"');
});

test('completion updatePlan clears the gate and all session markers', () => {
  runHook('post-update-plan-cleanup.sh', updatePlanEnvelope(sid, 'p1'));
  expect(existsSync(`${markerBase(sid)}-active-plan`)).toBe(true);

  // A completion update tears everything down (past planning).
  runHook('post-update-plan-cleanup.sh', updatePlanEnvelope(sid, 'p1', 'completed'));
  expect(existsSync(`${markerBase(sid)}-plan-persisted`)).toBe(false);
  expect(existsSync(`${markerBase(sid)}-active-plan`)).toBe(false);
  expect(existsSync(`${markerBase(sid)}-edit-count`)).toBe(false);
});

test('createPlan without planFilePath still opens the gate with a non-blocking message', () => {
  const out = runHook('post-create-plan-marker.sh', {
    session_id: sid,
    tool_name: 'mcp__cognistore__createPlan',
    tool_input: {},
    tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: 'p2' }) }] },
  });
  expect(existsSync(`${markerBase(sid)}-plan-persisted`)).toBe(true);
  expect(out).toContain('"systemMessage"');
  // The old deadlock wording must be gone.
  expect(out).not.toContain('stays blocked');
});

test('a createPlan without planFilePath actually lets ExitPlanMode through', () => {
  // The end-to-end shape of the v2.3.6 incident: an agent on an older MCP server
  // whose createPlan schema has no planFilePath property (additionalProperties:
  // false rejects it) must still be able to leave plan mode. Asserting the marker
  // exists is not enough — run the gate itself.
  expect(runHook('pre-exit-plan-check.sh', { session_id: sid })).toContain('"permissionDecision":"deny"');

  runHook('post-create-plan-marker.sh', {
    session_id: sid,
    tool_name: 'mcp__cognistore__createPlan',
    tool_input: { title: 'no path', content: '## Context' },
    tool_response: { content: [{ type: 'text', text: JSON.stringify({ id: 'p3' }) }] },
  });

  expect(runHook('pre-exit-plan-check.sh', { session_id: sid }).trim()).toBe('{}');
});
