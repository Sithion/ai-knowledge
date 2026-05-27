#!/usr/bin/env bash
# CogniStore global hook helpers for GitHub Copilot CLI (~/.copilot/hooks/).
# Copilot hooks are REMINDER-ONLY: the Copilot CLI does not define a block/deny
# output, so these scripts only inject systemMessage context. They still fail open.
# Sourced by every cognistore Copilot hook. Do NOT use `set -e`.

if [ "${COGNISTORE_DISABLE_HOOKS:-}" = "1" ] || [ -f "$HOME/.cognistore/hooks-disabled" ]; then
  echo '{}'
  exit 0
fi

COG_INPUT="$(cat 2>/dev/null || true)"

cog_field() {
  printf '%s' "$COG_INPUT" \
    | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 \
    | sed -E 's/.*:[[:space:]]*"(.*)"$/\1/' 2>/dev/null || true
}

COG_SID="$(cog_field session_id)"
[ -z "$COG_SID" ] && COG_SID="default"
COG_MARK="/tmp/.cognistore-copilot-${COG_SID}"

COG_DB="${SQLITE_PATH:-$HOME/.cognistore/knowledge.db}"
cog_db_present() { [ -f "$COG_DB" ]; }
cog_noop() { echo '{}'; exit 0; }
