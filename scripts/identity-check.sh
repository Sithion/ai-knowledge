#!/usr/bin/env bash
# Keeps contributor contact details out of commit METADATA and MESSAGES.
#
# v2.5.0 rewrote ~150 commits to strip corporate email addresses and a machine
# hostname out of author/committer fields — and 47 more occurrences out of
# `Co-authored-by:` trailers, which a repo-local `user.email` does not prevent
# from coming straight back. A one-off cleanup with no guard is a cleanup that
# gets undone by the next agent-assisted commit.
#
# Two entry points:
#   identity-check.sh author           — pre-commit: checks the identity git will stamp
#   identity-check.sh message <file>   — commit-msg: checks the message body/trailers
#
# The patterns are contact details, not secrets, so this is its own script rather
# than more entries in security-check.sh's PATTERNS array (which scans staged
# file CONTENT — a different surface entirely).

set -euo pipefail

# Contact details that must not enter this repo's history.
# `.local` catches any `user@machine.local` hostname git invents from a bare
# `user.name` with no configured email.
PATTERNS=(
  'acuityinc\.com'
  'acuitybrands\.com'
  'acuitysso\.com'
  'rrdtorres@'
  'REMRXT07'
  '@[A-Za-z0-9-]*\.local'
)

fail() {
  echo "[IDENTITY] $1"
  echo ""
  echo "[IDENTITY] This repo is public and its history was scrubbed of contact"
  echo "[IDENTITY] details in v2.5.0. Use a noreply address:"
  echo "[IDENTITY]   git config user.email '<id>+<name>@users.noreply.github.com'"
  echo "[IDENTITY] For a trailer, use the co-author's noreply address."
  echo "[IDENTITY] Bypass with --no-verify only if you are certain."
  exit 1
}

scan() {
  local label="$1" text="$2"
  for pattern in "${PATTERNS[@]}"; do
    if printf '%s' "$text" | grep -qiE "$pattern"; then
      fail "$label matches a contact-detail pattern: $pattern"
    fi
  done
}

case "${1:-}" in
  author)
    # What git will actually stamp, including any --author override in effect.
    scan "commit author/committer identity" \
      "$(git var GIT_AUTHOR_IDENT 2>/dev/null || true)
$(git var GIT_COMMITTER_IDENT 2>/dev/null || true)"
    ;;
  message)
    msg_file="${2:-}"
    [ -f "$msg_file" ] || exit 0
    # Strip comment lines — git's template explains nothing we need to scan.
    scan "commit message" "$(grep -v '^#' "$msg_file" || true)"
    ;;
  *)
    echo "usage: identity-check.sh author | message <file>" >&2
    exit 2
    ;;
esac

exit 0
