#!/usr/bin/env bash
# PostToolUse (mcp__cognistore__createPlan): record the active plan and open the
# ExitPlanMode gate. The gate opens whenever a plan is persisted (createPlan OR
# updatePlan); recording a planFilePath is recommended but no longer required to
# leave plan mode, so a missing path never deadlocks the agent.
source "$(dirname "$0")/_common.sh"

PLAN_ID="$(cog_field id)"
PLAN_FILE="$(cog_field planFilePath)"

if [ -n "$PLAN_ID" ]; then
  echo "$PLAN_ID" > "${COG_MARK}-active-plan"
  echo "0" > "${COG_MARK}-edit-count"
fi

# Open the ExitPlanMode gate unconditionally — a plan is now persisted.
touch "${COG_MARK}-plan-persisted"

if [ -n "$PLAN_FILE" ]; then
  printf '{"systemMessage":"STOP. Plan %s created and linked to %s. Now track every task in real time: call mcp__cognistore__listPlanTasks(\\"%s\\") to get taskIds, then updatePlanTask(taskId, {status: \\"in_progress\\"}) BEFORE each task and {status: \\"completed\\", notes: \\"...\\"} AFTER. Mark the first task in_progress before implementing."}\n' "$PLAN_ID" "$PLAN_FILE" "$PLAN_ID"
else
  # No local-file reference recorded — the gate is still open; recording the path
  # just keeps the persisted plan linked to the local file for later editors.
  printf '{"systemMessage":"[CogniStore] Plan %s created. Recommended: record your local plan file with mcp__cognistore__updatePlan(\\"%s\\", { planFilePath: \\"<absolute path>\\" }) so later agents can find the original. Then track tasks: updatePlanTask(taskId, {status: \\"in_progress\\"}) before each, {status: \\"completed\\"} after."}\n' "$PLAN_ID" "$PLAN_ID"
fi
exit 0
