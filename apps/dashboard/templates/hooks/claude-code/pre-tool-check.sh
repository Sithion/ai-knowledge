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

# Launching a subagent: carry the effort's plan id into its prompt. Subagent hook
# payloads are not guaranteed to share this session's id, so the marker cursor may
# not reach them — passing the id in the prompt is the propagation path that works
# regardless. Only fires once the session has queried (otherwise the deny below
# still takes precedence).
# Both names are matched: the subagent tool is exposed as "Agent" in current
# Claude Code and as "Task" in older builds, and a silent name mismatch would
# make this whole branch dead code with nothing to report it.
case "$TOOL_NAME" in Agent|Task) IS_SUBAGENT_DISPATCH=1 ;; *) IS_SUBAGENT_DISPATCH=0 ;; esac
if [ "$IS_SUBAGENT_DISPATCH" = "1" ] && [ -f "${COG_MARK}-queried" ]; then
  PARENT_ID="$(cog_read_marker "${COG_MARK}-effort-plan")"
  [ -z "$PARENT_ID" ] && PARENT_ID="$(cog_read_marker "${COG_MARK}-root-plan")"
  if [ -n "$PARENT_ID" ]; then
    AGENT_MSG="[CogniStore] PLAN CHAIN: this effort is plan ${PARENT_ID}. If this subagent may create a plan, include parentPlanId: \"${PARENT_ID}\" in its prompt so its plan links into this chain instead of starting a disconnected one. Review-only and read-only subagents should not create plans at all."
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$(cog_json_escape "$AGENT_MSG")"
    exit 0
  fi
fi

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
# TOOL_NAME comes from the event payload, so it is escaped before it lands inside
# the JSON string literal — a name carrying a quote or a backslash would otherwise
# break the envelope (or append keys to it) instead of being quoted as text.
REASON="CogniStore: call mcp__cognistore__getKnowledge(query: '<your task>') before using $(cog_json_escape "$TOOL_NAME"). All CogniStore tools are pre-approved — call directly. If mcp__cognistore__getKnowledge is NOT among your available tools, ignore this protocol — do NOT substitute other tools to satisfy it; this check stops blocking after 3 attempts. (Set COGNISTORE_DISABLE_HOOKS=1 to bypass.)"
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$REASON"
exit 0
