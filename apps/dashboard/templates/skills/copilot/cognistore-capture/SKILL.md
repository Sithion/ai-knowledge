---
name: cognistore-capture
description: >
  MANDATORY — automatically triggered after completing ANY task. Store discoveries,
  decisions, fixes, and patterns in the CogniStore knowledge base.
  This skill MUST run as your LAST action before finishing work.
  Do NOT skip. Do NOT forget. Capture knowledge, then finish.
---

# CogniStore Capture

**BLOCKING REQUIREMENT**: After completing ANY task that produces new knowledge — fixing a bug, making a decision, discovering a pattern, finding a constraint — you MUST capture it in the knowledge base immediately. This is NOT optional.

## When to Capture

| Event | What to Document | Type |
|-------|-----------------|------|
| Bug fixed | Root cause, fix applied, how to prevent | `fix` |
| Technical decision made | Choice, reasoning, discarded alternatives | `decision` |
| Pattern identified | Convention, where used, why | `pattern` |
| Limitation found | Constraint, impact, workarounds | `constraint` |
| Unexpected behavior | The gotcha, workaround, why it happens | `gotcha` |

## How to Call

```
cognistore-addKnowledge({
  title: "Descriptive title for semantic search",
  content: "Description of what was learned",
  type: "fix" | "decision" | "pattern" | "constraint" | "gotcha",
  scope: "global" | "workspace:<project-name>",
  source: "Where this was discovered",
  tags: ["relevant", "tags"],
  confidenceScore: 0.9,
  planId: "<your-plan-id>"
})
```

**Important**: Always include a descriptive `title` — it powers semantic search. Always pass `planId` if you have an active plan.

## What NOT to Capture

Only store knowledge that **saves significant time in future sessions**. Do NOT capture:

- **Publicly documented facts** — standard API docs, language syntax, framework basics
- **Trivial fixes** — typos, missing imports, simple syntax errors
- **Temporary state** — work-in-progress notes, current debugging status

**Rule of thumb**: If a web search answers it in 30 seconds, don't store it. If it took 5+ minutes of investigation, store it.

## Update Existing Knowledge, Don't Duplicate

**CRITICAL**: Before calling `addKnowledge`, check if a related entry already exists from your initial query:

1. If yes → **UPDATE it** with `cognistore-updateKnowledge(id, { content, tags })` instead of creating a new entry
2. If the existing entry is wrong → **DELETE it** with `cognistore-deleteKnowledge(id)` and create a fresh one
3. Only **ADD** when the knowledge is genuinely new — no existing entry covers the topic

## Rules

- **LAST action of every task** — capture before finishing
- **No exceptions** — no task is "too simple" to capture knowledge from
- **All entries in English** — regardless of conversation language
- **Be concise but complete** — full context without re-investigation needed

## Automatic Deduplication

`addKnowledge()` checks for semantically similar entries (threshold 0.85). If a match is found, it updates the existing entry instead of creating a duplicate. The response includes `deduplicated: true`.

## Scope Guidelines

| Scope | When |
|-------|------|
| `workspace:<project>` | Knowledge specific to one project — architecture decisions, project-specific patterns |
| `global` | Cross-project knowledge (language patterns, tools, conventions, framework gotchas) |

### Prefer Global Scope for Reusable Knowledge

**Actively create `scope: "global"` entries** for insights about languages, frameworks, libraries, tools, and general patterns. If it took investigation to discover and applies beyond this codebase, make it global.

## Pattern Checklist

Before finishing, ask yourself each question. If YES to any, store a `type: "pattern"` entry with `scope: "global"`:

1. Did I discover a **reusable coding pattern** for a language or framework?
2. Did I learn a **library usage pattern** not obvious from docs?
3. Did I find a **tool workflow** that saves time?
4. Did I use an **architectural pattern** worth repeating?
5. Did I discover a **testing or debugging technique**?

Patterns compound across every future project — actively look for them.

## Pre-Capture: Plan Completion Check

Before capturing knowledge, ensure active plans are complete:
1. `listPlanTasks(planId)` — if any tasks are not `completed`, update them first
2. Only after plan tracking is current, proceed with knowledge capture
