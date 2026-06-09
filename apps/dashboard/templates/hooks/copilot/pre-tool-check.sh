#!/usr/bin/env bash
# preToolUse: remind the agent to query the knowledge base before edit/exec tools.
# Reminder-only (Copilot cannot block). Goes quiet once queried this session.
#
# Anti no-op-loop hardening (v2.2.0, from a field incident where an agent emitted
# hundreds of placeholder SQL calls trying to appease this reminder):
#  1. Tool allow-list — only edit/exec tools get the reminder; unknown/third-party
#     tools (e.g. a `sql` MCP tool) never trigger it (mirrors the Claude matcher).
#  2. Reminder cap — at most 2 reminders per session, then silent.
#  3. Escape hatch — the text tells the agent to IGNORE the protocol when the
#     cognistore tools aren't available, instead of substituting other tools.
source "$(dirname "$0")/_common.sh"

TOOL_NAME="$(cog_field tool_name)"

# CogniStore MCP tools are always exempt (the agent is already using the KB).
case "$TOOL_NAME" in
  mcp__cognistore__*) cog_noop ;;
esac

# Allow-list: remind ONLY before edit/exec tools. Anything else (sql, browser,
# search, third-party MCP tools…) proceeds silently — reminding there caused
# agents to emit no-op calls just to "satisfy" the protocol.
case "$TOOL_NAME" in
  bash|Bash|shell|run_in_terminal|write|Write|write_file|create|create_file|edit|Edit|edit_file|str_replace|str_replace_editor|apply_patch|MultiEdit|NotebookEdit) : ;;
  *) cog_noop ;;
esac

[ -f "${COG_MARK}-queried" ] && cog_noop
cog_db_present || cog_noop

# Cap: at most 2 reminders per session — a reminder loop only teaches the agent
# to produce performative no-op tool calls.
if [ -f "${COG_MARK}-reminded2" ]; then
  cog_noop
elif [ -f "${COG_MARK}-reminded1" ]; then
  touch "${COG_MARK}-reminded2" 2>/dev/null || true
else
  touch "${COG_MARK}-reminded1" 2>/dev/null || true
fi

printf '{"systemMessage":"[CogniStore] Before %s: call mcp__cognistore__getKnowledge(query: \\"<your task>\\") if you have not yet this task. All CogniStore tools are pre-approved. If a plan is active, ensure the current task is marked in_progress via updatePlanTask(). If mcp__cognistore__getKnowledge is NOT among your available tools, ignore this protocol entirely — do NOT substitute other tools (e.g. raw SQL) to satisfy it."}\n' "$TOOL_NAME"
exit 0
