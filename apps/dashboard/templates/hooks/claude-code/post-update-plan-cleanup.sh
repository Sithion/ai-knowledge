#!/usr/bin/env bash
# PostToolUse (updatePlan): when a plan is marked completed, clear its session
# markers so later edits don't trigger stale task-sync reminders.
source "$(dirname "$0")/_common.sh"

if printf '%s' "$COG_INPUT" | grep -q '"status"[[:space:]]*:[[:space:]]*"completed"'; then
  rm -f "${COG_MARK}-active-plan" "${COG_MARK}-edit-count" "${COG_MARK}-task-updated"
fi
echo '{}'
exit 0
