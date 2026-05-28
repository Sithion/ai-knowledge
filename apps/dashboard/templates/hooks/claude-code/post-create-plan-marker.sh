#!/usr/bin/env bash
# PostToolUse (mcp__cognistore__createPlan): record the active plan and open the
# ExitPlanMode gate — but ONLY when a planFilePath was recorded, so the persisted
# plan always keeps a reference to the local plan file.
source "$(dirname "$0")/_common.sh"

PLAN_ID="$(cog_field id)"
PLAN_FILE="$(cog_field planFilePath)"

if [ -n "$PLAN_ID" ]; then
  echo "$PLAN_ID" > "${COG_MARK}-active-plan"
  echo "0" > "${COG_MARK}-edit-count"
fi

if [ -n "$PLAN_FILE" ]; then
  touch "${COG_MARK}-plan-persisted"
  printf '{"systemMessage":"STOP. Plan %s created and linked to %s. Now track every task in real time: call mcp__cognistore__listPlanTasks(\\"%s\\") to get taskIds, then updatePlanTask(taskId, {status: \\"in_progress\\"}) BEFORE each task and {status: \\"completed\\", notes: \\"...\\"} AFTER. Mark the first task in_progress before implementing."}\n' "$PLAN_ID" "$PLAN_FILE" "$PLAN_ID"
else
  # No local-file reference recorded — do NOT open the ExitPlanMode gate.
  printf '{"systemMessage":"[CogniStore] Plan %s created WITHOUT a planFilePath. Record the ABSOLUTE path of your local plan file now: mcp__cognistore__updatePlan(\\"%s\\", { planFilePath: \\"<absolute path>\\" }). Any agent that later edits this plan needs the original local-file reference. ExitPlanMode stays blocked until this is set."}\n' "$PLAN_ID" "$PLAN_ID"
fi
exit 0
