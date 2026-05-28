---
description: "Create and track CogniStore plans for multi-step tasks"
---

# cognistore-plan

For tasks with 2+ steps, create a plan and track execution.

```
mcp__cognistore__createPlan({
  title, content: "<structured plan>", tags, scope, source,
  tasks: [{ description: "Step 1" }, ...],
  relatedKnowledgeIds: ["<ids>"]
})
```

### Required Plan Structure

The `content` field MUST include these sections:
- **## Context** — why this change is needed
- **## Approach** — how it will be implemented (architecture, data flow, key logic)
- **## Files to Modify** — table with file paths and what changes
- **## Verification** — how to test (commands, expected results)

Optional: **## Reusable Code**, **## Edge Cases & Risks**

Include file paths, function names, and specific technical details — not generic descriptions.

If you wrote the plan to a local file (plan mode), pass its ABSOLUTE path as `planFilePath`
in `createPlan()` — mandatory whenever a plan file exists, so the plan links back to it.

Track each task:
- Before: `updatePlanTask(taskId, { status: "in_progress" })`
- After: `updatePlanTask(taskId, { status: "completed" })`

Plan auto-activates on first task start. Auto-completes when all tasks done.

## After Delegation
When subagent work completes:
1. `listPlanTasks(planId)` — check statuses
2. `updatePlanTask(taskId, {status: 'completed'})` for finished tasks
