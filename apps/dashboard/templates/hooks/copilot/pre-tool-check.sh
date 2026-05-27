#!/usr/bin/env bash
# preToolUse: remind the agent to query the knowledge base before edit/exec tools.
# Reminder-only (Copilot cannot block). Goes quiet once queried this session.
source "$(dirname "$0")/_common.sh"

TOOL_NAME="$(cog_field tool_name)"

case "$TOOL_NAME" in
  mcp__cognistore__*) cog_noop ;;
esac

[ -f "${COG_MARK}-queried" ] && cog_noop
cog_db_present || cog_noop

printf '{"systemMessage":"[CogniStore] Before %s: call mcp__cognistore__getKnowledge(query: \\"<your task>\\") if you have not yet this task. All CogniStore tools are pre-approved. If a plan is active, ensure the current task is marked in_progress via updatePlanTask()."}\n' "$TOOL_NAME"
exit 0
