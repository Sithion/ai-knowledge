#!/usr/bin/env bash
# userPromptSubmitted: inject the CogniStore workflow protocol (from the DB's
# system entry when available, else a built-in fallback) and reset the per-session
# query marker. Reminder-only.
source "$(dirname "$0")/_common.sh"

rm -f "${COG_MARK}-queried"

if ! cog_db_present; then
  printf '{"systemMessage":"[CogniStore] Knowledge database not found at %s. Run the setup wizard in the CogniStore app."}\n' "$COG_DB"
  exit 0
fi

SYSTEM_CONTENT=""
if command -v sqlite3 >/dev/null 2>&1; then
  SYSTEM_CONTENT="$(sqlite3 "$COG_DB" "SELECT content FROM knowledge_entries WHERE type='system' LIMIT 1" 2>/dev/null || true)"
fi

if [ -n "$SYSTEM_CONTENT" ]; then
  ESCAPED="$(printf '%s' "$SYSTEM_CONTENT" | sed 's/\\/\\\\/g; s/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')"
  printf '{"systemMessage":"[COGNISTORE-PROTOCOL]\\n%s\\n[END PROTOCOL]"}\n' "$ESCAPED"
else
  printf '{"systemMessage":"[COGNISTORE-PROTOCOL] On EVERY task: (1) cognistore-getKnowledge(query) FIRST — save entry IDs. (2) For 2+ steps cognistore-createPlan({title,content,tags,scope,source,tasks,relatedKnowledgeIds}) with planFilePath (absolute path of the local plan file). (3) cognistore-updatePlanTask(taskId,{status}) before/after each task. (4) cognistore-addKnowledge({...,planId}) before finishing. All CogniStore tools are pre-approved. [END PROTOCOL]"}\n'
fi
exit 0
