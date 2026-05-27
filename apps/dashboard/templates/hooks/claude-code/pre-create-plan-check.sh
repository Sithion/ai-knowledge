#!/usr/bin/env bash
# PreToolUse (mcp__cognistore__createPlan): nudge plan quality. The persistence
# gate marker is set AFTER the call by post-create-plan-marker.sh (only when a
# planFilePath was recorded), so this hook does not set it. Non-blocking.
source "$(dirname "$0")/_common.sh"

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"[CogniStore] PLAN QUALITY: createPlan() content MUST include ## Context (why), ## Approach (how — architecture, data flow, key logic), ## Files to Modify (table with file paths + changes), ## Verification (commands, expected results). Use concrete file paths, function names, line numbers. Pass planFilePath (ABSOLUTE path to your local plan file) so the plan keeps its original reference."}}\n'
exit 0
