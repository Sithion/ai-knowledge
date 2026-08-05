#!/usr/bin/env bash
# PostToolUse (updatePlan): a successful updatePlan targets an existing plan, so a
# plan is persisted this session — open the ExitPlanMode gate (same marker used by
# post-create-plan-marker.sh). Also, when a plan is marked completed, clear its
# session markers so later edits don't trigger stale task-sync reminders.
source "$(dirname "$0")/_common.sh"

# Open the ExitPlanMode gate. Unconditional: updatePlan requires a planId, so its
# success proves a plan exists — createPlan() OR updatePlan() may satisfy the gate.
touch "${COG_MARK}-plan-persisted"

if printf '%s' "$COG_INPUT" | grep -q '"status"[[:space:]]*:[[:space:]]*"completed"'; then
  # Plan completed — drop all session markers (including the gate) so a later,
  # unrelated plan-mode cycle must persist afresh.
  rm -f "${COG_MARK}-active-plan" "${COG_MARK}-edit-count" "${COG_MARK}-task-updated" "${COG_MARK}-plan-persisted" "${COG_MARK}-effort-plan" "${COG_MARK}-root-plan"
else
  # Not a completion: seed task-sync markers if this session has none yet, so
  # updatePlan-first flows get the same tracking createPlan would set up. Prefer
  # planId (unescaped in tool_input); `id` only appears escaped inside
  # tool_response, which cog_field's unescaped grep cannot read.
  PLAN_ID="$(cog_field planId)"
  [ -z "$PLAN_ID" ] && PLAN_ID="$(cog_field id)"
  if [ -n "$PLAN_ID" ] && [ ! -f "${COG_MARK}-active-plan" ]; then
    echo "$PLAN_ID" > "${COG_MARK}-active-plan"
    echo "0" > "${COG_MARK}-edit-count"
    # updatePlan-first flows get the lineage cursor too (createPlan's hook is
    # the usual writer). Only when it is UUID-shaped — see cog_sanitize_id.
    SAFE_PLAN_ID="$(cog_sanitize_id "$PLAN_ID")"
    [ -n "$SAFE_PLAN_ID" ] && cog_write_marker "${COG_MARK}-effort-plan" "$SAFE_PLAN_ID"
  fi
fi
echo '{}'
exit 0
