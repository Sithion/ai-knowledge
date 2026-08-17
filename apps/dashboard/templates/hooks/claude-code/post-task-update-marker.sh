#!/usr/bin/env bash
# PostToolUse (updatePlanTask|updatePlanTasks): positive reinforcement — reset the
# edit counter and mark that a task was just updated.
source "$(dirname "$0")/_common.sh"

cog_write_marker "${COG_MARK}-edit-count" "0"
touch "${COG_MARK}-task-updated"
echo '{}'
exit 0
