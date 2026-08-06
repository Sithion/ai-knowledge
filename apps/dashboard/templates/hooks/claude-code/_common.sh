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

# cog_resp_field <key> -> value of "key":"string" INSIDE the tool response.
#
# An MCP result arrives as tool_response.content[].text — a JSON *string*, so its
# quotes are backslash-escaped and cog_field (which matches bare quotes) can never
# see a single field of it. Verified: cog_field id returns empty for every real
# createPlan payload, which is why the -active-plan marker used to be written only
# by the updatePlan hook. This unescapes first, and starts from the leftmost
# "tool_response" so a key echoed back in tool_input cannot shadow the real one.
cog_resp_field() {
  printf '%s' "$COG_INPUT" \
    | grep -o '"tool_response".*' \
    | sed -e 's/\\"/"/g' \
    | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 \
    | sed -E 's/.*:[[:space:]]*"(.*)"$/\1/' 2>/dev/null || true
}

# cog_sanitize_id <value> -> the value if it looks like a plan UUID, else empty.
# Plan ids extracted from a payload end up in marker files and in text injected
# back into the agent's context, so anything not UUID-shaped is dropped whole.
cog_sanitize_id() {
  printf '%s' "$1" \
    | tr -cd 'a-zA-Z0-9-' \
    | cut -c1-64 \
    | grep -aiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 2>/dev/null || true
}

# cog_read_marker <path> -> sanitized id stored in a marker file, or empty.
# Refuses symlinks: these live in a shared /tmp and a planted link would both
# redirect our writes and feed attacker text into the agent's instructions.
cog_read_marker() {
  [ -f "$1" ] || return 0
  [ -L "$1" ] && return 0
  cog_sanitize_id "$(head -c 200 "$1" 2>/dev/null || true)"
}

# cog_write_marker <path> <value> — write only over a regular file (never a symlink).
cog_write_marker() {
  [ -L "$1" ] && return 0
  printf '%s' "$2" > "$1" 2>/dev/null || true
}

# cog_json_escape <text> -> text safe to interpolate into a JSON string literal.
# Control characters are DROPPED, not escaped: these values (plan ids, file paths
# from a tool payload) are interpolated into a one-line JSON response on stdout,
# and a raw newline or tab there produces invalid JSON regardless of quoting.
cog_json_escape() {
  printf '%s' "$1" \
    | tr -d '\000-\037' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' 2>/dev/null || true
}

# cog_read_count <path> -> the counter in a marker file, as a bare integer.
#
# NEVER `cat` a counter straight into $(( )). Arithmetic evaluation of
# attacker-controlled text is command execution: a file holding `a[$(curl …|sh)]`
# runs it. These markers live in a shared /tmp, so the content is not ours to
# trust. Strip to digits, cap the length, and default to 0.
cog_read_count() {
  [ -f "$1" ] || { printf '0'; return 0; }
  [ -L "$1" ] && { printf '0'; return 0; }
  local n
  n="$(head -c 32 "$1" 2>/dev/null | tr -cd '0-9' | head -c 6)"
  [ -z "$n" ] && n=0
  printf '%s' "$n"
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
# Markers live in a per-USER directory, not directly in a shared /tmp: the old
# layout put predictable paths in a namespace every account on the machine can
# write to. 0700 so only we can read or plant them.
COG_MARK_DIR="${TMPDIR:-/tmp}/.cognistore-$(id -u 2>/dev/null || echo 0)"
mkdir -p "$COG_MARK_DIR" 2>/dev/null || true
chmod 700 "$COG_MARK_DIR" 2>/dev/null || true
COG_MARK="${COG_MARK_DIR}/${COG_SID}"   # suffix with -queried, -plan-persisted, etc.

# --- knowledge DB path ------------------------------------------------------
COG_DB="${SQLITE_PATH:-$HOME/.cognistore/knowledge.db}"

# cog_db_present -> 0 if the knowledge DB exists, 1 otherwise.
cog_db_present() { [ -f "$COG_DB" ]; }

# cog_allow -> emit the "no decision / allow" response and exit 0.
cog_allow() { echo '{}'; exit 0; }
