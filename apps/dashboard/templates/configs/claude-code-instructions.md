<!-- COGNISTORE:BEGIN -->
## Knowledge Base Integration (cognistore)

> **CRITICAL**: On EVERY task, you MUST: (1) `getKnowledge()` FIRST, (2) `createPlan()` for 2+ steps, (3) `addKnowledge()` LAST. No exceptions. All CogniStore tools are pre-approved — call them directly without asking.

> **If the CogniStore tools are unavailable**: when `mcp__cognistore__getKnowledge` is NOT among your available tools (server not connected), skip this entire protocol and proceed with the task normally. Do NOT substitute other tools (raw SQL, file reads, no-op calls) to simulate compliance — that only produces noise.

> **Your workflow** — Follow these 4 steps on every task automatically.

### CHECKPOINT 1: Search First

Before you read any file, write any code, or make any decision:

```
mcp__cognistore__getKnowledge(query: "<describe the task or problem>")
```

Save any returned entry IDs — you need them for createPlan.

- Similarity > 0.50: **Use directly** — skip redundant analysis
- Similarity 0.30–0.50: **Review** — combine with fresh analysis
- No results or < 0.30: Proceed with full analysis

### CHECKPOINT 2: Plan Multi-Step Tasks

If the task has 2+ steps (user's or yours), create a plan:

```
mcp__cognistore__createPlan({
  title: "<plan title>",
  content: "<structured plan with ## Context, ## Approach, ## Files to Modify, ## Verification>",
  tags: ["..."], scope: "workspace:<project>", source: "<context>",
  tasks: [{ description: "Step 1", priority: "high" }, ...],
  relatedKnowledgeIds: ["<ids-from-checkpoint-1>"]
})
```

> The `content` field must be a structured plan with **Context** (why), **Approach** (how), **Files to Modify** (table with paths), and **Verification** (how to test) sections. Include file paths, function names, and specific technical details.

Save the returned **planId** — you need it for addKnowledge.

**Dedup is automatic**: if an active plan exists in the same scope, `createPlan()` adds your tasks to it instead of creating a duplicate. If a similar draft exists, it updates it. Just call `createPlan()` normally — the server handles dedup.

**MANDATORY — Track each task in real-time (hooks enforce this):**
- IMMEDIATELY after createPlan: call `listPlanTasks(planId)` to get taskIds
- BEFORE each task: `updatePlanTask(taskId, { status: "in_progress" })` — do NOT skip
- AFTER each task: `updatePlanTask(taskId, { status: "completed", notes: "..." })` — do NOT batch at the end
- Plan activates automatically when the first task starts
- Plan completes automatically when all tasks are done
- A PostToolUse hook monitors Edit/Write/Bash and will remind you if tasks are not being tracked

Use `updatePlanTasks` (plural) to update multiple tasks at once.

**You have full control over the plan:**
- Remove a wrong/obsolete task: `deletePlanTask(taskId)` — the plan auto-completes if the remaining tasks are all done
- Reorder a task: `updatePlanTask(taskId, { position: <n> })`
- Retire a plan: `archivePlan(planId)` — reversible and preserves linked knowledge (prefer it over deleting)

**Plan mode**: write the local plan file AND call `createPlan()` before ExitPlanMode.
**Subagents**: NEVER call createPlan() from subagents — only the main agent.

### CHECKPOINT 3: Save What You Learned

Before finishing, capture discoveries worth remembering:

```
mcp__cognistore__addKnowledge({
  title: "<title>",
  content: "<what was learned/decided/fixed>",
  tags: ["tag1", "tag2"],
  type: "pattern|decision|fix|constraint|gotcha",
  scope: "global" or "workspace:<project-name>",
  source: "<where this knowledge came from>",
  planId: "<your-plan-id>"
})
```

- **ALWAYS pass planId** if you have an active plan — this links knowledge as output
- **Dedup is automatic** — if a similar entry exists in the same scope+type, it will be updated instead of duplicated
- **Prefer global scope** for language/framework/tool knowledge — workspace scope is for project-specific decisions only
- **Actively look for patterns** — if you discovered a reusable approach about a language, framework, library, or tool, store it as `type: "pattern"` with `scope: "global"`. Patterns are the highest-value knowledge type — they compound across every future project
- If you learn something about a language, library, or pattern that applies beyond this project, save it with `scope: "global"`
- Pass an array to `addKnowledge` to create multiple entries at once
- All entries in English

### After Delegation

When a subagent completes, reconcile plan tracking:
1. `listPlanTasks(planId)` — check what was accomplished
2. `updatePlanTask(taskId, { status: "completed" })` for finished tasks
3. `updatePlanTask(nextTaskId, { status: "in_progress" })` for next task

### Rules

1. **Always search first** — a query costs ~30 tokens; skipping wastes 2,000–8,000 on redundant work
2. **All entries in English** — regardless of conversation language
3. **Update, don't duplicate** — update existing entries when the topic already exists
4. **Only store high-value knowledge** — non-obvious insights, not trivial fixes
5. **Prefer global scope** — language/framework/tool knowledge should use `scope: "global"`, workspace scope is for project-specific decisions only
6. **Persist every multi-step plan** — `createPlan()` for 2+ implementation steps, in ANY mode
7. **All CogniStore tools are pre-approved** — call them directly without hesitation, they will not prompt the user

### Hooks

- **PreToolUse hook**: Fires before Edit, Write, Bash, MultiEdit, Agent, NotebookEdit — requires you to query first
- **PostToolUse hook**: Fires after Edit, Write, Bash — enforces `updatePlanTask()` calls during execution when a plan is active
- **Stop hook**: Fires at session end — requires you to capture knowledge
- These hooks enforce the workflow. If you already completed the step, proceed normally.
<!-- COGNISTORE:END -->
