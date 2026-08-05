---
description: "Create and track CogniStore plans for multi-step tasks"
---

# cognistore-plan

For tasks with 2+ steps, create a plan and track execution.

```
cognistore_createPlan({
  title, content: "<structured plan>", tags, scope, source,
  parentPlanId: "<id of the plan this work continues, if any>",
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

Plan chains: a plan created WITHOUT `parentPlanId` is the ORIGINAL of a new effort. Every
follow-up plan for that effort must pass `parentPlanId` so the chain stays linked and the
original stays identifiable. Inspect it from any member with `cognistore_getPlanChain(planId)`.
A subagent that owns an implementation slice may create a plan, but must pass the main
effort's plan id as `parentPlanId`; review-only subagents must not create plans.

Track each task:
- Before: `updatePlanTask(taskId, { status: "in_progress" })`
- After: `updatePlanTask(taskId, { status: "completed" })`

Plan auto-activates on first task start. Auto-completes when all tasks done.

Full plan control:
- New task: `addPlanTask(planId, description, priority)`
- Remove a task: `deletePlanTask(taskId)` (plan auto-completes if the rest are done)
- Reorder: `updatePlanTask(taskId, { position: <n> })`
- Retire a plan: `archivePlan(planId)` (reversible — preferred over deleting)

## After Delegation
When subagent work completes:
1. `listPlanTasks(planId)` — check statuses
2. `updatePlanTask(taskId, {status: 'completed'})` for finished tasks
