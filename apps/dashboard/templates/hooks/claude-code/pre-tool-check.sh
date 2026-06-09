#!/usr/bin/env bash
# PreToolUse: deny edit/exec tools until the knowledge base has been queried this
# session. Goes silent once getKnowledge() has run (marker set by
# post-query-marker.sh). Fail-open: never blocks when the DB is absent or on error.
#
# Deny cap (v2.2.0): after 3 denies without a query the hook FAILS OPEN for the
# rest of the session. If the cognistore MCP server isn't connected (e.g. Ollama
# down → server never boots) the tool the deny message demands doesn't exist —
# without the cap, every Edit/Bash would be denied forever and the session wedged.
source "$(dirname "$0")/_common.sh"

TOOL_NAME="$(cog_field tool_name)"

# CogniStore MCP tools are always allowed (the agent is already using the KB).
case "$TOOL_NAME" in
  mcp__cognistore__*) cog_allow ;;
esac

# Already queried this session → allow.
[ -f "${COG_MARK}-queried" ] && cog_allow

# Deny cap reached earlier this session → fail OPEN (never wedge a session).
[ -f "${COG_MARK}-deny-capped" ] && cog_allow

# DB missing → fail OPEN (do not wedge unrelated projects).
cog_db_present || cog_allow

# Count this deny; cap at 3 per session.
if [ -f "${COG_MARK}-deny2" ]; then
  touch "${COG_MARK}-deny-capped" 2>/dev/null || true
elif [ -f "${COG_MARK}-deny1" ]; then
  touch "${COG_MARK}-deny2" 2>/dev/null || true
else
  touch "${COG_MARK}-deny1" 2>/dev/null || true
fi

# Otherwise deny until getKnowledge() is called.
REASON="CogniStore: call mcp__cognistore__getKnowledge(query: '<your task>') before using ${TOOL_NAME}. All CogniStore tools are pre-approved — call directly. If mcp__cognistore__getKnowledge is NOT among your available tools, ignore this protocol — do NOT substitute other tools to satisfy it; this check stops blocking after 3 attempts. (Set COGNISTORE_DISABLE_HOOKS=1 to bypass.)"
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$REASON"
exit 0
