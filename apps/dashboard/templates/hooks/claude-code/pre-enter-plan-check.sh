#!/usr/bin/env bash
# PreToolUse (EnterPlanMode): reset the plan-persistence gate and remind the agent
# of the plan-mode protocol. Non-blocking.
source "$(dirname "$0")/_common.sh"

rm -f "${COG_MARK}-plan-persisted"
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"[CogniStore] PLAN MODE: 1) getKnowledge() first (pre-approved). 2) Write your plan file. 3) Call createPlan() BEFORE ExitPlanMode with content including ## Context, ## Approach, ## Files to Modify (table with paths), ## Verification — AND planFilePath set to the ABSOLUTE path of your local plan file. 4) ExitPlanMode. 5) During execution call updatePlanTask() for EVERY task (in_progress then completed)."}}\n'
exit 0
