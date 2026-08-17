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
# Sanitize: keep only alphanumeric and hyphens, max 64 chars (mirrors the Claude
# helper) — prevents a crafted session_id from placing marker files outside /tmp.
COG_SID="$(printf '%s' "$COG_SID" | tr -cd 'a-zA-Z0-9-' | cut -c1-64)"
[ -z "$COG_SID" ] && COG_SID="default"
# Markers live in a per-USER directory, not directly in a shared /tmp: the old
# layout put predictable paths in a namespace every account on the machine can
# write to. 0700 so only we can read or plant them.
COG_MARK_DIR="${TMPDIR:-/tmp}/.cognistore-$(id -u 2>/dev/null || echo 0)"
mkdir -p "$COG_MARK_DIR" 2>/dev/null || true
chmod 700 "$COG_MARK_DIR" 2>/dev/null || true
COG_MARK="${COG_MARK_DIR}/copilot-${COG_SID}"

COG_DB="${SQLITE_PATH:-$HOME/.cognistore/knowledge.db}"
cog_db_present() { [ -f "$COG_DB" ]; }
cog_noop() { echo '{}'; exit 0; }
