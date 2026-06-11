#!/usr/bin/env bash
# postToolUse: track session state for reminders. Copilot has no per-tool matcher,
# so this single hook inspects the tool name and updates markers accordingly.
source "$(dirname "$0")/_common.sh"

TOOL_NAME="$(cog_field tool_name)"

# Copilot CLI exposes MCP tools as cognistore-<tool> (NOT the Claude Code
# mcp__cognistore__<tool> form — that exact-match never fired here, so the
# -queried marker was never set and the pre-tool reminder never went quiet).
# The old form is kept as a compat alternation.
case "$TOOL_NAME" in
  cognistore-getKnowledge|mcp__cognistore__getKnowledge)
    touch "${COG_MARK}-queried" ;;
  cognistore-addKnowledge|mcp__cognistore__addKnowledge)
    touch "${COG_MARK}-knowledge-captured" ;;
esac

echo '{}'
exit 0
