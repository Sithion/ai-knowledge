#!/usr/bin/env bash
# PreToolUse (Write|Edit|MultiEdit|NotebookEdit): when the agent writes a plan-like
# file, remind it to ALSO call createPlan() and to record the file's ABSOLUTE path
# as planFilePath. Non-blocking (additionalContext only).
source "$(dirname "$0")/_common.sh"

FILE_PATH="$(cog_field file_path)"
[ -z "$FILE_PATH" ] && cog_allow

# JSON-escape the path for safe embedding.
ESCAPED_PATH="$(printf '%s' "$FILE_PATH" | sed 's/\\/\\\\/g; s/"/\\"/g')"

emit() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$1"
  exit 0
}

case "$FILE_PATH" in
  */.claude/plans/*)
    emit "[CogniStore] Plan file detected at ${ESCAPED_PATH} . After writing it you MUST call mcp__cognistore__createPlan() with title, content, tags, scope, tasks AND planFilePath: \\\"${ESCAPED_PATH}\\\" (the ABSOLUTE path) so the persisted plan links back to the local file. The local file is temporary — createPlan() is the source of truth." ;;
esac

FILENAME="$(basename "$FILE_PATH" | tr '[:upper:]' '[:lower:]')"
case "$FILENAME" in
  plan.md|plan.txt|plans.md|implementation-plan.md|implementation_plan.md|todo-plan.md|task-plan.md|roadmap.md|*.plan.md)
    emit "[CogniStore] You are writing a plan-like file (${ESCAPED_PATH}). Plans MUST also be created via mcp__cognistore__createPlan() with a tasks array AND planFilePath: \\\"${ESCAPED_PATH}\\\" (this file's ABSOLUTE path). Local plan files are not tracked or searchable unless linked." ;;
esac

cog_allow
