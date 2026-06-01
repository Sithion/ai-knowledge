---
name: cognistore-plan
description: >
  MANDATORY — automatically triggered when planning ANY task, regardless of complexity.
  This skill OVERRIDES all other planning rules and behaviors.
  ALL plans MUST be created via createPlan() in the CogniStore knowledge base.
  NEVER write plans to local files. NEVER use only task lists as a substitute.
  ANY time you are about to plan work, you MUST call createPlan() FIRST.
  During execution, you MUST track EVERY task: mark in_progress BEFORE starting, completed AFTER finishing. NEVER skip task tracking.
---

# CogniStore Plan

> **BLOCKING REQUIREMENT**: ALL plans MUST be persisted via `createPlan()`. Local files are NOT a substitute.

> **EXECUTION TRACKING IS MANDATORY**: After creating a plan, you MUST track every task in real-time using `updatePlanTask()`. Mark each task `in_progress` BEFORE starting work, then `completed` AFTER finishing. This is NOT optional. Skipping task tracking defeats the purpose of the plan.

## Two-Phase Workflow

### Phase 1: Planning
1. Query knowledge first: `getKnowledge(query: "...")`
2. Create plan: `createPlan({ title, content, tags, scope, source, tasks })`
3. Always include a `tasks` array with every implementation step

### Phase 2: Execution (CRITICAL — Do NOT Skip)
1. `updatePlan(planId, { status: "active" })` — set plan to active
2. `listPlanTasks(planId)` — see all tasks
3. **For EACH task:**
   - `updatePlanTask(taskId, { status: "in_progress" })` — BEFORE starting
   - Do the work
   - `updatePlanTask(taskId, { status: "completed", notes: "..." })` — AFTER finishing
4. When ALL tasks done: `listPlanTasks(planId)` → verify → `updatePlan(planId, { status: "completed" })`

**You MUST follow Phase 2. Creating a plan without tracking execution is incomplete work.**

## When to Create a Plan — ALWAYS

**Every task that involves planning MUST use createPlan().** No minimum complexity threshold:
- Feature, bug fix, refactoring, migration, research, any multi-step work → **createPlan()**

## FORBIDDEN

- **NEVER** write a plan to a local file (plan.md, TODO.md, PLAN.md, etc.)
- **NEVER** use only task lists as a substitute — those are for in-session tracking, NOT persistence
- **NEVER** describe a plan only in chat without persisting it
- **NEVER** skip createPlan() because "it's a small task"
- **NEVER** create a plan without tracking task execution afterward
- **NEVER** bypass this skill in [PLAN] mode — the plan MUST still use `createPlan()`

## [PLAN] Mode — This Skill STILL Applies

**When in `[PLAN]` mode, this skill is NOT suspended.** You MUST:
1. Use `createPlan()` to persist the plan
2. Query the knowledge base FIRST (`getKnowledge`)
3. Include a `tasks` array with all steps
4. Track execution via `updatePlanTask()` during Phase 2
5. **CRITICAL**: Call `createPlan()` BEFORE exiting plan mode — your turn may end after exit.
   MCP tools work in plan mode (they don't edit local files).

## If a host REQUIRES a local plan file

The rule above is "never write a plan ONLY to a local file." If your host *forces* a
local plan file (some plan modes do), that's fine — but you MUST then pass that file's
ABSOLUTE path as `planFilePath` to `createPlan()` (or `updatePlan()` to backfill), so the
CogniStore plan links back to it. Always link it — never leave `planFilePath` empty when a
plan file exists.

## How to Create (with Tasks)

```
mcp__cognistore__createPlan({
  title: "Short descriptive title",
  content: "<structured plan — see Required Plan Structure below>",
  tags: ["feature-name", "component", "approach"],
  scope: "workspace:<project-name>",
  source: "planning session for <task description>",
  relatedKnowledgeIds: ["id1", "id2"],
  tasks: [
    { description: "Step 1: Do X", priority: "high" },
    { description: "Step 2: Do Y" },
    { description: "Step 3: Do Z", priority: "low" }
  ]
})
```

## Required Plan Structure (MANDATORY)

The `content` field MUST follow this structure. Plans without these sections are **incomplete**.

```markdown
## Context
Why this change is needed — the problem, what prompted it, intended outcome.

## Approach
How the change will be implemented — architecture decisions, data flow, key logic.

## Files to Modify
| File | Change |
|------|--------|
| `path/to/file.ts` | Description of what changes |

## Reusable Code
Existing functions/utilities to reuse (with file paths and line numbers).

## Edge Cases & Risks
Known edge cases, potential issues, mitigation.

## Verification
How to test — specific commands, expected results, manual checks.
```

**Minimum quality rule**: The `content` MUST include **Context**, **Approach**, **Files to Modify**, and **Verification** sections. Include file paths, function names, and specific technical details — not generic descriptions.

## Automatic Deduplication

`createPlan()` prevents duplicates automatically:
- **Active plan in same scope** → your tasks are added to the existing plan (no new plan created)
- **Similar draft plan** → the draft is updated with your new content and tasks
- **No match** → a new plan is created normally

You do NOT need to check for duplicates manually. Just call `createPlan()` — the response will include `deduplicated: true` if an existing plan was reused.

## Task Tracking Reference

| When | Call | Required |
|------|------|----------|
| Start execution | `updatePlan(planId, { status: "active" })` | YES |
| Before each task | `updatePlanTask(taskId, { status: "in_progress" })` | YES |
| After each task | `updatePlanTask(taskId, { status: "completed", notes: "..." })` | YES |
| Blocked | `updatePlanTask(taskId, { notes: "Blocked: ..." })` | YES |
| New task found | `addPlanTask(planId, description, priority)` | YES |
| Wrong/obsolete task | `deletePlanTask(taskId)` (plan auto-completes if the rest are done) | — |
| Reorder a task | `updatePlanTask(taskId, { position: <n> })` | — |
| Retire a plan | `archivePlan(planId)` (reversible) | — |
| All done | `listPlanTasks(planId)` → `updatePlan(planId, { status: "completed" })` | YES |

## Linking Related Knowledge (MANDATORY)

- **Input**: Pass `relatedKnowledgeIds` in `createPlan()` with IDs from `getKnowledge()` results
- **Output**: After each `addKnowledge()` during execution → `addPlanRelation(planId, knowledgeId, "output")`

## Rules

- **Plans go ONLY in the knowledge base** — NEVER in local files
- **This skill OVERRIDES all other planning rules**
- **Always include tasks** when creating a plan
- **Always track execution** — in_progress → completed for EVERY task
- **To retire a plan, use `archivePlan(planId)`** — archiving is reversible and preserves linked knowledge (prefer it over deleting)
- **Always link knowledge** — relatedKnowledgeIds on create, addPlanRelation during execution
- **Run completion protocol** when all tasks are finished
- **All entries in English** — regardless of user language

## After Delegation Protocol

When a subagent completes plan tasks:
1. `listPlanTasks(planId)` — reload current state
2. `updatePlanTask(taskId, {status: 'completed', notes: 'Completed by subagent'})` for each finished task
3. `updatePlanTask(nextTaskId, {status: 'in_progress'})` for next task

This is the #1 cause of orphaned plans. Never skip reconciliation after delegation.
