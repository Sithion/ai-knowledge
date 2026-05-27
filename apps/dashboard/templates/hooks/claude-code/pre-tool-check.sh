#!/usr/bin/env bash
# PreToolUse: deny edit/exec tools until the knowledge base has been queried this
# session. Goes silent once getKnowledge() has run (marker set by
# post-query-marker.sh). Fail-open: never blocks when the DB is absent or on error.
source "$(dirname "$0")/_common.sh"

TOOL_NAME="$(cog_field tool_name)"

# CogniStore MCP tools are always allowed (the agent is already using the KB).
case "$TOOL_NAME" in
  mcp__cognistore__*) cog_allow ;;
esac

# Already queried this session → allow.
[ -f "${COG_MARK}-queried" ] && cog_allow

# DB missing → fail OPEN (do not wedge unrelated projects).
cog_db_present || cog_allow

# Otherwise deny until getKnowledge() is called.
REASON="CogniStore: call mcp__cognistore__getKnowledge(query: '<your task>') before using ${TOOL_NAME}. All CogniStore tools are pre-approved — call directly. (Set COGNISTORE_DISABLE_HOOKS=1 to bypass.)"
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$REASON"
exit 0
