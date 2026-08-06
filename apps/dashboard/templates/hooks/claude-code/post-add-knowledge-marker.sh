#!/usr/bin/env bash
# PostToolUse (mcp__cognistore__addKnowledge): mark capture done for the session so
# the Stop hook stops blocking, and reset the nudge counter.
source "$(dirname "$0")/_common.sh"

touch "${COG_MARK}-knowledge-captured"
cog_write_marker "${COG_MARK}-capture-nudge-count" "0"
echo '{}'
exit 0
