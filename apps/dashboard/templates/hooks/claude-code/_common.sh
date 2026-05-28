#!/usr/bin/env bash
# CogniStore global hook helpers — sourced by every cognistore Claude Code hook.
#
# These hooks are registered globally in ~/.claude/settings.json, so they fire in
# EVERY Claude Code session on the machine — including projects unrelated to
# CogniStore. They MUST fail OPEN: any error, missing dependency, or unset DB must
# result in "do nothing, allow the action" (empty stdout + exit 0), never a block.
#
# NOTE: callers must NOT use `set -e` — a non-zero exit from a PreToolUse hook is
# itself treated by Claude Code as a blocking error.

# --- Escape hatch -----------------------------------------------------------
# COGNISTORE_DISABLE_HOOKS=1 (env) or ~/.cognistore/hooks-disabled (file) turns
# every hook into a silent no-op.
if [ "${COGNISTORE_DISABLE_HOOKS:-}" = "1" ] || [ -f "$HOME/.cognistore/hooks-disabled" ]; then
  echo '{}'
  exit 0
fi

# --- stdin ------------------------------------------------------------------
# Claude Code passes the event payload as JSON on stdin. Read it once; tolerate
# its absence.
COG_INPUT="$(cat 2>/dev/null || true)"

# --- field extraction (jq/python-free, BRE-based, best-effort) --------------
# cog_field <key> -> value of the FIRST "key":"string" pair, or empty string.
cog_field() {
  printf '%s' "$COG_INPUT" \
    | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 \
    | sed -E 's/.*:[[:space:]]*"(.*)"$/\1/' 2>/dev/null || true
}

# --- session-keyed markers --------------------------------------------------
# Markers are keyed by session_id so concurrent sessions don't race on shared
# /tmp files. Falls back to "default" when the id is unavailable.
COG_SID="$(cog_field session_id)"
# Sanitize: keep only alphanumeric and hyphens, max 64 chars. Prevents path-traversal
# (a crafted session_id like "../../etc/cron.d/evil" would place marker files outside
# /tmp) and shell word-splitting issues.
COG_SID="$(printf '%s' "$COG_SID" | tr -cd 'a-zA-Z0-9-' | cut -c1-64)"
[ -z "$COG_SID" ] && COG_SID="default"
COG_MARK="/tmp/.cognistore-${COG_SID}"   # suffix with -queried, -plan-persisted, etc.

# --- knowledge DB path ------------------------------------------------------
COG_DB="${SQLITE_PATH:-$HOME/.cognistore/knowledge.db}"

# cog_db_present -> 0 if the knowledge DB exists, 1 otherwise.
cog_db_present() { [ -f "$COG_DB" ]; }

# cog_allow -> emit the "no decision / allow" response and exit 0.
cog_allow() { echo '{}'; exit 0; }
