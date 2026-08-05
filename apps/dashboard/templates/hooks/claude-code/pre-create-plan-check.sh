#!/usr/bin/env bash
# PreToolUse (mcp__cognistore__createPlan): nudge plan quality. The persistence
# gate marker is set AFTER the call by post-create-plan-marker.sh (only when a
# planFilePath was recorded), so this hook does not set it. Non-blocking.
source "$(dirname "$0")/_common.sh"

QUALITY='[CogniStore] PLAN QUALITY: createPlan() content MUST include ## Context (why), ## Approach (how — architecture, data flow, key logic), ## Files to Modify (table with file paths + changes), ## Verification (commands, expected results). Use concrete file paths, function names, line numbers. Pass planFilePath (ABSOLUTE path to your local plan file) so the plan keeps its original reference.'

# Lineage: suggest the effort cursor as the parent so the chain stays linked.
# -effort-plan is the cursor (the plan this effort is on) and gives a real tree;
# -root-plan is the fallback. Both are re-sanitized on read and the suggestion is
# skipped entirely when empty, so a missing or tampered marker degrades to the
# plain quality nudge.
PARENT_ID="$(cog_read_marker "${COG_MARK}-effort-plan")"
[ -z "$PARENT_ID" ] && PARENT_ID="$(cog_read_marker "${COG_MARK}-root-plan")"

if [ -n "$PARENT_ID" ]; then
  QUALITY="${QUALITY} PLAN CHAIN: this effort already has plan ${PARENT_ID}. Pass parentPlanId: \"${PARENT_ID}\" so the new plan is linked to it instead of starting a disconnected chain — omit parentPlanId ONLY if this is genuinely a new, unrelated effort."
fi

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$(cog_json_escape "$QUALITY")"
exit 0
