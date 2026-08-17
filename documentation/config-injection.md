# Config Injection System

## Overview

The `@cognistore/config` package manages automatic configuration of AI clients. It uses a **marker-based injection** system to safely add and remove configuration blocks in shared files without overwriting user content.

**File:** `packages/config/src/config-manager.ts`

## Supported Clients

| Client | MCP Config | Instructions File | Skills Location | Plugins |
|--------|-----------|-------------------|-----------------|---------|
| Claude Code | `~/.claude/mcp-config.json` | `~/.claude/CLAUDE.md` | `~/.claude/skills/cognistore-*/` | — |
| GitHub Copilot | `~/.copilot/mcp-config.json` | `~/.github/copilot-instructions.md` | `~/.copilot/skills/cognistore-*/` | — |
| OpenCode | `~/.config/opencode/opencode.json` | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/skills/cognistore-*/` | `~/.config/opencode/plugins/` |

## Marker-Based Injection

### How It Works

Instructions and configuration blocks are wrapped in markers:

```markdown
<!-- COGNISTORE:BEGIN -->
... injected content ...
<!-- COGNISTORE:END -->
```

### Injection Logic

```
IF file does not exist:
    Create file with template content between markers

ELSE IF file exists but has no markers:
    Backup file (filename.bak.TIMESTAMP)
    Append markers + template at end of file

ELSE IF markers exist:
    Backup file
    Replace content between markers with new template
```

### Removal Logic

```
1. Find markers in file
2. Remove everything between BEGIN and END markers (inclusive)
3. Trim whitespace
4. If file is now empty → delete file
5. Otherwise → write back trimmed content
```

## MCP Config Injection

### Standard Format (Claude Code, Copilot)

```json
{
  "mcpServers": {
    "cognistore": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cognistore/mcp-server@2.5.1"],
      "env": {
        "SQLITE_PATH": "~/.cognistore/knowledge.db",
        "OLLAMA_HOST": "http://localhost:11434",
        "npm_config_ignore_scripts": "false"
      }
    }
  }
}
```

Entries are built by `buildMcpEntry()` in `apps/dashboard/server/mcp-entry.ts` (the SoT for the
generated shape). Two rules apply to every client:

- **The package spec is always versioned.** `resolveMcpSpec()` emits `@cognistore/mcp-server@<app version>`
  when that version is published, and falls back to `@latest` when it is not (source builds, or the
  window before the npm publish job runs). It never emits the bare package name — `npm exec` would
  resolve a globally installed copy from `PATH` instead of the registry.
- **`npm_config_ignore_scripts=false`** is set on the entry so `npx` can compile `better-sqlite3` even
  when the user's `~/.npmrc` has `ignore-scripts=true`.

Setup and upgrade also run `detectGlobalMcpShadow()`. If a globally installed `@cognistore/mcp-server`
with a different version is found, the step is reported as a **warning** suggesting
`npm uninstall -g @cognistore/mcp-server`. The app never modifies global npm packages itself.

The `setupMcpConfig(path, entry)` function:
1. Reads existing JSON (or creates `{}`)
2. Ensures `mcpServers` object exists
3. Sets `mcpServers['cognistore']` = entry
4. Writes back with 2-space indentation

### OpenCode Format

OpenCode uses a different JSON structure:

```json
{
  "mcp": {
    "cognistore": {
      "type": "local",
      "command": ["npx", "-y", "@cognistore/mcp-server@2.5.1"],
      "enabled": true,
      "environment": {
        "SQLITE_PATH": "~/.cognistore/knowledge.db",
        "OLLAMA_HOST": "http://localhost:11434",
        "npm_config_ignore_scripts": "false"
      }
    }
  }
}
```

Key differences:
- Root key is `mcp` (not `mcpServers`)
- `type` is `local` (not `stdio`)
- `command` is an array (not separate `command` + `args`)
- `env` is named `environment`

## Skills Installation

### Claude Code Skills

Copied to `~/.claude/skills/`:

| Skill | Directory | Hook | Purpose |
|-------|-----------|------|---------|
| `cognistore-capture` | `~/.claude/skills/cognistore-capture/SKILL.md` | `Stop` | Capture knowledge after completing tasks |
| `cognistore-query` | `~/.claude/skills/cognistore-query/SKILL.md` | `PreToolUse` | Query knowledge before starting tasks |
| `cognistore-plan` | `~/.claude/skills/cognistore-plan/SKILL.md` | `PostToolUse` (ExitPlanMode) | Save plans to knowledge base with task management workflow |

### Copilot Skills

Copied to `~/.copilot/skills/` (directory format with hooks, same as Claude Code):

| Skill | Directory | Hook | Purpose |
|-------|-----------|------|---------|
| `cognistore-query` | `~/.copilot/skills/cognistore-query/SKILL.md` | `preToolUse` | Query knowledge before starting tasks |
| `cognistore-capture` | `~/.copilot/skills/cognistore-capture/SKILL.md` | `sessionEnd` | Capture knowledge after completing tasks |
| `cognistore-plan` | `~/.copilot/skills/cognistore-plan/SKILL.md` | `postToolUse` | Save plans to knowledge base with task management workflow |

### OpenCode Skills

Copied to `~/.config/opencode/skills/`:

| Skill | Directory | Purpose |
|-------|-----------|---------|
| `cognistore-query` | `~/.config/opencode/skills/cognistore-query/SKILL.md` | Query knowledge before starting tasks |
| `cognistore-capture` | `~/.config/opencode/skills/cognistore-capture/SKILL.md` | Capture knowledge after completing tasks |
| `cognistore-plan` | `~/.config/opencode/skills/cognistore-plan/SKILL.md` | Save plans to knowledge base with task management workflow |

### OpenCode Plugins

Deployed to `~/.config/opencode/plugins/`:

| Plugin | File | Event Handlers |
|--------|------|----------------|
| `cognistore-plan-enforcement` | `cognistore-plan-enforcement.ts` | `tool.execute.after`, `session.end`, `experimental.session.compacting` |

The plugin provides three event handlers:
- **`tool.execute.after`** — Fires after Write/Edit/Bash tools; reminds the agent to check plan tasks
- **`session.end`** — Fires at session end; reminds to check plan completion and capture knowledge
- **`experimental.session.compacting`** — Fires after context compaction; reminds to reload plan state

Managed by `ConfigManager.setupOpenCodePlugins()` and `ConfigManager.removeOpenCodePlugins()`.

### Hook Catalog (Claude Code + Copilot)

| Hook | Trigger | Purpose |
|------|---------|---------|
| `PreToolUse` | Before Edit/Write/Bash | Reminds to query knowledge base first |
| `Stop` / `sessionEnd` | Session end | Reminds to capture knowledge |
| `PostToolUse` (ExitPlanMode) | After exiting plan mode | Reminds to persist plans via createPlan |
| `UserPromptSubmit` | User submits a prompt | Injects system knowledge as protocol |
| `SubagentStop` | Subagent completes | Reminds to reconcile plan tasks via listPlanTasks/updatePlanTask |
| `PostCompact` (experimental) | After context compaction | Reminds to reload plan state |
| `TaskCompleted` | After updatePlanTask | Reminds to start the next task |

All hooks output standardized JSON format: `{"systemMessage": "..."}`.

## Instruction Compilation

### Overview

Agent instruction templates are compiled from a single source of truth (`_base-instructions.md`) into three platform-specific files. This eliminates drift between platforms and ensures all agents receive consistent protocol instructions.

**Source:** `apps/dashboard/templates/configs/_base-instructions.md`
**Compiler:** `apps/dashboard/templates/configs/compile-instructions.mjs`

### Conditional Syntax

The base file uses HTML comment-style conditionals:

```markdown
<!-- IF:claude-code -->
This text only appears in claude-code-instructions.md
<!-- ENDIF -->

<!-- IF:copilot -->
This text only appears in copilot-instructions.md
<!-- ENDIF -->
```

### Compilation Pipeline

1. `compile-instructions.mjs` reads `_base-instructions.md`
2. Evaluates all `<!-- IF:platform -->...<!-- ENDIF -->` blocks
3. Writes `claude-code-instructions.md`, `copilot-instructions.md`, `opencode-instructions.md`
4. Generated files are gitignored — the source of truth is `_base-instructions.md`

The `bundle-sidecar.mjs` script runs the compiler before copying templates to the sidecar bundle.

## Instruction Templates

### Claude Code (`~/.claude/CLAUDE.md`)

Injected block teaches Claude Code the knowledge-first protocol:
1. Always query `getKnowledge` before starting work
2. Always capture with `addKnowledge` after completing work
3. Update stale knowledge with `updateKnowledge`
4. Priority order: knowledge base → codebase → web search

### Copilot (`~/.github/copilot-instructions.md`)

Similar protocol adapted for Copilot's instruction format.

### Plan Persistence Rule

Both Claude Code and Copilot instructions include the rule: **plans must be stored in the knowledge base** using `createPlan`, never as local files. The `cognistore-plan` skill reinforces this with a `PostToolUse` hook on `ExitPlanMode` that reminds agents to persist their plans before leaving plan mode.

The same instructions carry the **plan-chain rule**: a plan created without `parentPlanId` is the ORIGINAL of an effort, and every follow-up plan — including one created by a subagent — must pass `parentPlanId` so the chain stays linked. Subagents that own an implementation slice may create plans under that condition; review-only subagents must not. On Claude Code the rule is also assisted by hooks (the current effort's plan id is suggested before `createPlan` and injected when a subagent is dispatched); on Copilot and OpenCode it is instruction text only.

## Hook-Based Protocol Injection

In addition to marker-based instruction injection and skills, CogniStore uses `UserPromptSubmit` hooks to dynamically inject protocol instructions at the start of every agent session.

### How It Works

1. During setup, mandatory protocol entries are created as `type=system` knowledge entries in the database
2. `UserPromptSubmit` hooks (installed as part of the skills) fire when a user submits a prompt to their AI client
3. The hook reads all system knowledge entries from the local SQLite database
4. The entries are formatted and injected as a `[COGNISTORE-PROTOCOL]` system message
5. The agent receives the protocol instructions before processing the user's prompt

### Why Both Markers and Hooks?

| Mechanism | Purpose | Reliability |
|-----------|---------|-------------|
| Marker injection (CLAUDE.md, etc.) | Static protocol instructions in agent instruction files | Depends on user not removing markers |
| Hook injection (UserPromptSubmit) | Dynamic protocol from database, injected every session | Always present as long as skills are installed |

The hook-based approach provides a second layer of protocol delivery. Even if a user modifies or removes the injected CLAUDE.md markers, the hooks still deliver protocol instructions from the database. System entries in the database are protected from deletion and modification.

## Backup Strategy

Before modifying any file, the config manager creates a timestamped backup:

```
~/.claude/CLAUDE.md          →  ~/.claude/CLAUDE.md.bak.1710720000000
~/.claude/mcp-config.json    →  ~/.claude/mcp-config.json.bak.1710720000000
```

During uninstall, backup files matching `*.bak.*` are also cleaned up.

## Removal Entry Points

| Function | What It Removes |
|----------|----------------|
| `removeMarkers(path)` | Content between `COGNISTORE:BEGIN/END` markers |
| `removeMcpEntry(path, 'cognistore')` | `cognistore` key from `mcpServers` object |
| `removeOpenCodeMcp()` | `cognistore` key from OpenCode `mcp` object |
| `removeOpenCodeSkills()` | `~/.config/opencode/skills/cognistore-*/` directories |
| `removeOpenCodePlugins()` | `~/.config/opencode/plugins/cognistore-*` files |
