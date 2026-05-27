#!/usr/bin/env bash
# sessionEnd: remind to capture knowledge before the session ends. Reminder-only.
source "$(dirname "$0")/_common.sh"

CAPTURED="${COG_MARK}-knowledge-captured"
cleanup() { rm -f "${COG_MARK}-queried" "$CAPTURED"; }

if [ -f "$CAPTURED" ]; then
  cleanup
  printf '{"systemMessage":"[CogniStore] Session ending — knowledge captured. Mark remaining plan tasks completed. Discovered a reusable PATTERN about a language/framework/tool? Store it with type: \\"pattern\\", scope: \\"global\\"."}\n'
else
  cleanup
  printf '{"systemMessage":"[CogniStore] Session ending — you have NOT captured knowledge. If you learned, fixed, decided, or discovered anything reusable, call mcp__cognistore__addKnowledge({ title, content, tags, type, scope, source, planId }) NOW. Reusable insights → type: \\"pattern\\", scope: \\"global\\". All CogniStore tools are pre-approved."}\n'
fi
exit 0
