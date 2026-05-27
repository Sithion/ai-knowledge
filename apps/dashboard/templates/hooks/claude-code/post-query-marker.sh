#!/usr/bin/env bash
# PostToolUse (mcp__cognistore__getKnowledge): mark the session as queried so
# pre-tool-check.sh stops blocking.
source "$(dirname "$0")/_common.sh"

touch "${COG_MARK}-queried"
echo '{}'
exit 0
