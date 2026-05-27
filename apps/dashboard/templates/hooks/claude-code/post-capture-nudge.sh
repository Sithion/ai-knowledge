#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit|Bash|NotebookEdit): after substantial work with
# nothing captured yet, nudge about knowledge capture. Throttled: starts at 5 edits,
# then every 5th. Silent once knowledge is captured.
source "$(dirname "$0")/_common.sh"

CAPTURED="${COG_MARK}-knowledge-captured"
COUNTER_FILE="${COG_MARK}-capture-nudge-count"

[ -f "$CAPTURED" ] && cog_allow

COUNT="$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)"
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

if [ "$COUNT" -lt 5 ] || [ $((COUNT % 5)) -ne 0 ]; then
  cog_allow
fi

printf '{"systemMessage":"[CogniStore] Substantial work, no knowledge captured yet. Call mcp__cognistore__addKnowledge() for any non-trivial discovery, fix, decision, or pattern. Prefer type: \\"pattern\\", scope: \\"global\\" for reusable insights."}\n'
exit 0
