#!/usr/bin/env bash
# PreToolUse (ExitPlanMode): deny leaving plan mode until createPlan() has been
# called WITH a planFilePath this session. The gate marker is set by
# post-create-plan-marker.sh only when a planFilePath was recorded.
source "$(dirname "$0")/_common.sh"

if [ -f "${COG_MARK}-plan-persisted" ]; then
  rm -f "${COG_MARK}-plan-persisted"   # consume the gate
  echo '{}'
  exit 0
fi

REASON="CogniStore: call mcp__cognistore__createPlan() before ExitPlanMode, and pass planFilePath (the ABSOLUTE path of your local plan file) so the persisted plan links back to it. The local plan file is temporary — createPlan() is the source of truth. Include title, content (## Context, ## Approach, ## Files to Modify, ## Verification), tags, scope, source, tasks. All CogniStore tools are pre-approved."
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$REASON"
exit 0
