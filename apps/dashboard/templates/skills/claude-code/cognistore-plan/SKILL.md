---
name: cognistore-plan
description: >
  MANDATORY — automatically triggered when planning ANY task, regardless of complexity.
  ALL plans MUST be persisted via createPlan() in the CogniStore knowledge base.
  If plan mode (EnterPlanMode) requires a local plan file, write it AND ALSO call createPlan().
  The local file is temporary — createPlan() is the persistent source of truth.
  ANY time you finish planning, you MUST call createPlan().
user-invocable: true
argument-hint: <plan title and description>
---

# CogniStore Plan

> **BLOCKING REQUIREMENT**: ALL plans MUST be persisted via `createPlan()`. This is the persistent source of truth. Local plan files (`.claude/plans/`) are temporary artifacts of plan mode — they do NOT substitute for `createPlan()`.

## Plan Mode Integration

**When plan mode (EnterPlanMode) is active:**
1. Follow plan mode's workflow normally — write the local plan file as instructed
2. **BEFORE calling ExitPlanMode**, call `createPlan()` to persist the plan.
   MCP tools (createPlan, getKnowledge) work in plan mode — they don't edit local files.
   **MANDATORY**: pass the local plan file's ABSOLUTE path as `planFilePath` (e.g.
   `createPlan({ ..., planFilePath: "/home/you/.claude/plans/<name>.md" })`) so the
   persisted plan always links back to the on-disk file. Always link it — never omit it
   when a plan file exists.
3. Then call ExitPlanMode. The local plan file is ephemeral; createPlan() persists across sessions.

> **CRITICAL**: Call createPlan() BEFORE ExitPlanMode, not after. After ExitPlanMode your turn may end before you get a chance to persist the plan.

> **MANDATORY**: Any time you write a plan to a file (plan mode or otherwise), the
> createPlan()/updatePlan() call MUST carry that file's absolute `planFilePath`.

**When NOT in plan mode:**
- Call `createPlan()` directly — no local file needed

## When to Create a Plan — ALWAYS

**Every task that involves planning MUST use createPlan().** No minimum complexity threshold:
- Feature, bug fix, refactoring, migration, research, any multi-step work → **createPlan()**

## FORBIDDEN

- **NEVER** persist a plan ONLY as a local file without also calling `createPlan()`
- **NEVER** use only TodoWrite as a substitute — those are for in-session tracking, NOT persistence
- **NEVER** describe a plan only in chat without persisting it
- **NEVER** skip createPlan() because "it's a small task"
- **NEVER** call createPlan() from a subagent (Agent tool) — ONLY the main agent creates plans

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

**Important**: Always include a `tasks` array when creating a plan.

## Required Plan Structure (MANDATORY)

The `content` field MUST follow this structure. Plans without these sections are **incomplete and will be rejected**.

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

### Example

```
content: `## Context
Users report duplicate plans when multiple sessions run concurrently. The root cause is that KNN search returns completed plans, saturating the k-nearest results and hiding active duplicates.

## Approach
Replace KNN-based dedup with a pre-filter strategy: query the plans table for draft/active plans in the same scope first, then compute cosine similarity in JS for those candidates only. This avoids sqlite-vec WHERE clause limitations.

## Files to Modify
| File | Change |
|------|--------|
| \`packages/core/src/repositories/knowledge.repository.ts:332-352\` | Rewrite findSimilarActivePlans() to pre-filter by status/scope |
| \`packages/core/src/services/knowledge.service.ts:173\` | Throttle archiveStaleDrafts to once per hour |
| \`packages/tests/src/e2e/sdk-plans.test.ts\` | Add KNN saturation test with 15+ completed plans |

## Reusable Code
- \`cosineSimilarity()\` helper already exists in \`knowledge.repository.ts:450\`
- \`archiveStaleDrafts()\` at \`knowledge.repository.ts:380\`

## Edge Cases & Risks
- Empty embedding buffer from sqlite-vec → guard with length check
- Zero-magnitude vectors → return 0 similarity instead of NaN
- Concurrent createPlan calls → dedup is best-effort, not transactional

## Verification
- \`pnpm test\` — all plan dedup tests pass
- Create 15+ completed plans + 1 draft → verify dedup finds the draft
- \`pnpm --filter @cognistore/mcp-server build\` — no type errors
`
```

**Minimum quality rule**: The `content` MUST include **Context**, **Approach**, **Files to Modify**, and **Verification** sections. Include file paths, function names, and specific technical details — not generic descriptions.

## Automatic Deduplication

`createPlan()` prevents duplicates automatically:
- **Active plan in same scope** → your tasks are added to the existing plan (no new plan created)
- **Similar draft plan** → the draft is updated with your new content and tasks
- **No match** → a new plan is created normally

You do NOT need to check for duplicates manually. Just call `createPlan()` — the response will include `deduplicated: true` if an existing plan was reused.

## Task Management During Execution (MANDATORY — Real-Time Tracking)

**You MUST update task status as you work. Do NOT batch updates at the end.**

1. **Before starting work** → `listPlanTasks(planId)` + `updatePlan(planId, { status: "active" })`
2. **BEFORE each task** → `updatePlanTask(taskId, { status: "in_progress" })` — do NOT skip
3. **AFTER each task** → `updatePlanTask(taskId, { status: "completed", notes: "..." })` — do NOT batch
4. **If blocked** → `updatePlanTask(taskId, { notes: "Blocked: ..." })`
5. **When resuming** → find first `pending` or `in_progress` task
6. **New tasks** → `addPlanTask(planId, description, priority)`

**Flow: `in_progress` → do work → `completed`. Never skip `in_progress`.**

## Plan Lifecycle

1. **Create** → status: `draft` (automatic)
2. **Start execution** → `updatePlan(planId, { status: "active" })`
3. **During execution** → `addPlanRelation(planId, knowledgeId, "output")` for new knowledge
4. **Complete** → see completion protocol below

## Plan Completion Protocol (MANDATORY)

1. `listPlanTasks(planId)` to verify ALL completed
2. If all completed → `updatePlan(planId, { status: "completed" })`
3. If any NOT completed → leave `active`, add notes

## Linking Related Knowledge (MANDATORY)

- **Input** (consulted during planning): pass IDs as `relatedKnowledgeIds` in `createPlan()`, or use `addPlanRelation(planId, knowledgeId, "input")`
- **Output** (created during execution): `addPlanRelation(planId, knowledgeId, "output")` after each `addKnowledge()`

## Rules

- **createPlan() is the source of truth** — local files are temporary
- **Always include tasks** when creating a plan
- **Always link knowledge** — relatedKnowledgeIds on create, addPlanRelation during execution
- **Update task AND plan status in real-time** — in_progress → completed, draft → active → completed
- **NEVER set plan status to 'archived'** — this is a dashboard-only action, not for agents
- **Run completion protocol** when all tasks are finished
- **All entries in English** — regardless of user language

## After Delegation Protocol

When a subagent completes plan tasks:
1. `listPlanTasks(planId)` — reload current state
2. `updatePlanTask(taskId, {status: 'completed', notes: 'Completed by subagent'})` for each finished task
3. `updatePlanTask(nextTaskId, {status: 'in_progress'})` for next task

This is the #1 cause of orphaned plans. Never skip reconciliation after delegation. preference
