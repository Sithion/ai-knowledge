#!/usr/bin/env bash
# PostToolUse (mcp__cognistore__createPlan): record the active plan and open the
# ExitPlanMode gate. The gate opens whenever a plan is persisted (createPlan OR
# updatePlan); recording a planFilePath is recommended but no longer required to
# leave plan mode, so a missing path never deadlocks the agent.
source "$(dirname "$0")/_common.sh"

# The created plan's id and its chain root live in the tool RESPONSE, which is an
# escaped JSON string — cog_field cannot read it (that is why -active-plan used to
# be written only by the updatePlan hook). rootPlanId is the EFFECTIVE root, so a
# root plan reports itself; if an older MCP server omits the key we fall back to
# the plan's own id rather than losing the chain cursor.
PLAN_ID="$(cog_sanitize_id "$(cog_resp_field id)")"
ROOT_PLAN_ID="$(cog_sanitize_id "$(cog_resp_field rootPlanId)")"
# planFilePath comes from the tool payload, i.e. it is model-controlled, and it
# is interpolated into the JSON response below. Escaped, unlike PLAN_ID which is
# already reduced to a UUID by cog_sanitize_id.
PLAN_FILE="$(cog_json_escape "$(cog_field planFilePath)")"

if [ -n "$PLAN_ID" ]; then
  cog_write_marker "${COG_MARK}-active-plan" "$PLAN_ID"
  cog_write_marker "${COG_MARK}-edit-count" "0"
  # The lineage cursor is a SEPARATE marker from -active-plan on purpose:
  # -active-plan also drives task-sync and stop-time reminders, and the lineage
  # cursor has to be cleared when a new plan-mode cycle starts. Clearing the
  # shared marker for that would silence an unrelated feature mid-effort.
  cog_write_marker "${COG_MARK}-effort-plan" "$PLAN_ID"
  [ -z "$ROOT_PLAN_ID" ] && ROOT_PLAN_ID="$PLAN_ID"
  cog_write_marker "${COG_MARK}-root-plan" "$ROOT_PLAN_ID"
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
