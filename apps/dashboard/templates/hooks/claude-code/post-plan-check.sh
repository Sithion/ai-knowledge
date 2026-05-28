#!/usr/bin/env bash
# PostToolUse (ExitPlanMode): reinforce that the plan must be persisted via
# createPlan() and tracked task-by-task. Non-blocking.
source "$(dirname "$0")/_common.sh"

printf '{"systemMessage":"[CogniStore] Call createPlan() now if you have not already — content MUST include ## Context, ## Approach, ## Files to Modify (table with paths), ## Verification, plus planFilePath (absolute path to the local plan file) and a tasks array. Then track each task: updatePlanTask(taskId, {status: \\"in_progress\\"}) before, {status: \\"completed\\"} after. All CogniStore tools are pre-approved."}\n'
exit 0
