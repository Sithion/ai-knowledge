#!/usr/bin/env bash
# Stop: enforce knowledge capture at session end — but ONLY when this session did
# real work (created a plan or made edits) and hasn't captured yet. Trivial /
# read-only sessions are never blocked. Blocks at most once per session to avoid
# wedging. COGNISTORE_DISABLE_HOOKS=1 bypasses entirely (handled in _common.sh).
source "$(dirname "$0")/_common.sh"

CAPTURED="${COG_MARK}-knowledge-captured"
PLAN_MARKER="${COG_MARK}-active-plan"
EDITS="${COG_MARK}-edit-count"
STOP_BLOCKED="${COG_MARK}-stop-blocked"

cleanup() {
  rm -f "${COG_MARK}-queried" "${COG_MARK}-plan-persisted" "$PLAN_MARKER" \
        "$EDITS" "${COG_MARK}-task-updated" "$CAPTURED" \
        "${COG_MARK}-capture-nudge-count" "$STOP_BLOCKED"
}

# Already captured → light pattern reminder, then clean up session state.
if [ -f "$CAPTURED" ]; then
  cleanup
  printf '{"systemMessage":"[CogniStore] Session ending — knowledge captured. Final check: mark any remaining plan tasks completed via updatePlanTask(). Discover a reusable PATTERN about a language/framework/library/tool? Store it with type: \\"pattern\\", scope: \\"global\\" — patterns compound across every project."}\n'
  exit 0
fi

# Did real CogniStore-relevant work happen this session?
DID_WORK=false
{ [ -f "$PLAN_MARKER" ] || [ -f "$EDITS" ]; } && DID_WORK=true

# Block once to force capture when work was done but nothing captured.
if [ "$DID_WORK" = true ] && [ ! -f "$STOP_BLOCKED" ]; then
  touch "$STOP_BLOCKED"
  printf '{"decision":"block","reason":"[CogniStore] Before finishing: capture what you learned. Call mcp__cognistore__addKnowledge({ title, content, tags, type: \\"fix|decision|pattern|constraint|gotcha\\", scope: \\"global\\" or \\"workspace:<project>\\", source, planId: \\"<active plan id>\\" }). Reusable insights about a language/framework/tool should be type: \\"pattern\\", scope: \\"global\\". Also mark remaining plan tasks completed. All CogniStore tools are pre-approved. (Set COGNISTORE_DISABLE_HOOKS=1 to bypass.)"}\n'
  exit 0
fi

# No work this session, or already blocked once → remind without wedging; clean up.
cleanup
if [ "$DID_WORK" = true ]; then
  printf '{"systemMessage":"[CogniStore] Session ending — no knowledge captured. If you learned/fixed/decided anything reusable, call mcp__cognistore__addKnowledge() next time."}\n'
else
  echo '{}'
fi
exit 0
