#!/usr/bin/env bash
# UserPromptSubmit: reset the per-session query gate (each new task must query
# again) and inject the workflow reminder as additionalContext. Never blocks.
source "$(dirname "$0")/_common.sh"

# New prompt → require a fresh getKnowledge() before edits.
rm -f "${COG_MARK}-queried"

if ! cog_db_present; then
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[CogniStore] Knowledge database not found at %s. Run the setup wizard in the CogniStore app."}}\n' "$COG_DB"
  exit 0
fi

printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[CogniStore] Workflow: (1) getKnowledge() FIRST (2) createPlan() for multi-step tasks — include planFilePath (absolute path to the local plan file), and parentPlanId when this continues an existing effort (3) updatePlanTask() during execution (4) addKnowledge() before finishing. All CogniStore tools are pre-approved."}}\n'
exit 0
