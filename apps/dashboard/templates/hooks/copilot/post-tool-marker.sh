#!/usr/bin/env bash
# postToolUse: track session state for reminders. Copilot has no per-tool matcher,
# so this single hook inspects the tool name and updates markers accordingly.
source "$(dirname "$0")/_common.sh"

TOOL_NAME="$(cog_field tool_name)"

case "$TOOL_NAME" in
  mcp__cognistore__getKnowledge)
    touch "${COG_MARK}-queried" ;;
  mcp__cognistore__addKnowledge)
    touch "${COG_MARK}-knowledge-captured" ;;
esac

echo '{}'
exit 0
