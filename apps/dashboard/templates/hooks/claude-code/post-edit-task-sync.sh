#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit|Bash|NotebookEdit): when an active plan exists,
# remind the agent to keep plan tasks in sync. Throttled (every 5th edit), with a
# stronger reminder past 15 edits without a task update. PostToolUse cannot undo a
# tool, so this nudges via systemMessage rather than blocking.
source "$(dirname "$0")/_common.sh"

PLAN_MARKER="${COG_MARK}-active-plan"
COUNTER_FILE="${COG_MARK}-edit-count"
TASK_UPDATED="${COG_MARK}-task-updated"

[ -f "$PLAN_MARKER" ] || cog_allow
PLAN_ID="$(cat "$PLAN_MARKER" 2>/dev/null || true)"
[ -z "$PLAN_ID" ] && cog_allow

COUNT="$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)"
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

# Recent task update → reset and stay quiet.
if [ -f "$TASK_UPDATED" ]; then
  rm -f "$TASK_UPDATED"
  echo "0" > "$COUNTER_FILE"
  cog_allow
fi

if [ "$COUNT" -ge 15 ]; then
  echo "0" > "$COUNTER_FILE"
  printf '{"systemMessage":"[CogniStore] 15+ edits without updating plan tasks. Call mcp__cognistore__listPlanTasks(\\"%s\\") then updatePlanTask(taskId, {status: \\"completed\\"}) for finished tasks and {status: \\"in_progress\\"} for the next one NOW."}\n' "$PLAN_ID"
  exit 0
fi

if [ $((COUNT % 5)) -ne 0 ]; then
  cog_allow
fi

printf '{"systemMessage":"[CogniStore] Active plan %s: call updatePlanTask(taskId, {status: \\"completed\\"}) for finished tasks, then updatePlanTask(nextTaskId, {status: \\"in_progress\\"})."}\n' "$PLAN_ID"
exit 0
