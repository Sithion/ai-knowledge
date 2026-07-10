#!/usr/bin/env bash
# PreToolUse (ExitPlanMode): deny leaving plan mode until a plan has been persisted
# this plan-mode cycle via createPlan() OR updatePlan(). Both post-create-plan-marker.sh
# and post-update-plan-cleanup.sh set the gate marker. The marker is NOT consumed here,
# so ExitPlanMode retries (e.g. after another PreToolUse denier) stay open; the marker
# is reset per cycle by pre-enter-plan-check.sh, which re-requires a persist next time.
source "$(dirname "$0")/_common.sh"

if [ -f "${COG_MARK}-plan-persisted" ]; then
  echo '{}'
  exit 0
fi

REASON="CogniStore: persist your plan before ExitPlanMode — call mcp__cognistore__createPlan() (or mcp__cognistore__updatePlan() if a plan already exists this session). The local plan file is temporary; the persisted plan is the source of truth. createPlan content should include title, ## Context, ## Approach, ## Files to Modify, ## Verification, tags, scope, source, tasks. All CogniStore tools are pre-approved."
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$REASON"
exit 0
