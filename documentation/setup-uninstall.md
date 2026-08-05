# Setup Wizard & Uninstall

## Setup Wizard

### Overview

The setup wizard runs on first launch and installs all dependencies automatically. It is implemented as a React page (`SetupPage`) that calls Fastify API endpoints sequentially.

**Frontend:** `apps/dashboard/src/pages/SetupPage.tsx`
**Backend:** `apps/dashboard/server/index.ts` (setup routes)

### Steps

| # | Step | API Endpoint | What It Does |
|---|------|-------------|-------------|
| 1 | Node.js | `POST /api/setup/node` | Detect or install Node.js v24 via nvm |
| 2 | Ollama | `POST /api/setup/ollama` | Install Ollama via brew (macOS) or curl (Linux) |
| 3 | Start Ollama | `POST /api/setup/ollama-start` | Spawn `ollama serve` as background daemon, wait 15s |
| 4 | Database | `POST /api/setup/database` | Create `~/.cognistore/knowledge.db` with schema + indices |
| 5 | Model | `POST /api/setup/model` | Pull `nomic-embed-text` embedding model via Ollama API |
| 6 | Configure | `POST /api/setup/configure` | Inject MCP configs, instructions, skills, and seed system knowledge |
| 7 | Complete | `POST /api/setup/complete` | Finalize setup, re-initialize SDK |

### Status Check

`GET /api/setup/status` returns the current state of each component:

```json
{
  "node": true,
  "ollama": true,
  "database": true,
  "model": true,
  "mcpConfig": true,
  "sdkReady": true
}
```

The app checks this on every launch. If all components are ready, it skips the wizard and shows the dashboard directly.

### Step UI States

Each step displays one of four states:
- Pending (not started)
- Running (in progress, with spinner)
- Done (green checkmark)
- Error (red X with retry button)

### Ollama Installation Details

**macOS:**
```bash
brew install ollama
```

**Linux:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Fallback (both platforms):**
If brew/curl fails, downloads the Ollama binary directly to `~/.ollama-bin/` and adds it to PATH.

### Model Pull

Uses Ollama's HTTP API with streaming progress:

```
POST http://localhost:11434/api/pull
Body: { "name": "nomic-embed-text", "stream": true }
```

The `nomic-embed-text` model is ~274MB and takes 15-60 seconds to download.

The cleanup cycle uses a second, larger model (`llama3.2:3b` by default, ~2GB) to
draft merges for duplicate entries. It is **not** pulled at setup: the download
starts the first time you preview a consolidation, and never happens if you do
not use that feature. Uninstall removes it only if it is present.

### Configure Step Details

The configure step performs multiple actions:

1. **Inject CLAUDE.md markers** — Adds knowledge-first protocol instructions
2. **Inject copilot-instructions.md markers** — Same for Copilot
3. **Inject OpenCode AGENTS.md markers** — Same for OpenCode (`~/.config/opencode/AGENTS.md`)
4. **Add MCP entries** — Adds `cognistore` to all client configs:
   - `~/.claude/mcp-config.json`
   - `~/.claude.json`
   - `~/.copilot/mcp-config.json`
   - `~/.config/opencode/opencode.json`
5. **Compile instructions** — Runs `compile-instructions.mjs` to generate platform-specific instruction files from `_base-instructions.md`
6. **Copy skills** — Installs AI skills for Claude Code (query, capture, plan), Copilot (query, capture, plan), and OpenCode (query, capture, plan)
7. **Deploy OpenCode plugins** — Copies plan enforcement plugin to `~/.config/opencode/plugins/`
8. **Seed system knowledge** — Creates mandatory `type=system` knowledge entries in the database containing protocol instructions (knowledge-first workflow, plan persistence rules, etc.). These entries are injected into agent sessions via `UserPromptSubmit` hooks as `[COGNISTORE-PROTOCOL]` system messages. System entries are hidden from the dashboard, undeletable, and protected from modification

---

## Uninstall

### Overview

The uninstall feature is accessed via the Settings page (formerly Infrastructure/Monitoring). It performs a complete teardown of all installed components, then self-deletes the application.

**Endpoint:** `POST /api/uninstall`
**Frontend:** `apps/dashboard/src/pages/SettingsPage.tsx` (Danger Zone section)

### Safety: 3-Step Confirmation

The uninstall button requires a 3-step confirmation to prevent accidental data loss:

1. Click "Uninstall Everything" → shows confirmation dialog
2. Type confirmation text → enables confirm button
3. Click confirm → starts uninstall

### Uninstall Steps

| # | Action | Details |
|---|--------|---------|
| 1 | Remove instruction markers | Delete `COGNISTORE:BEGIN/END` blocks from CLAUDE.md, copilot-instructions.md |
| 2 | Remove MCP entries | Delete `cognistore` from all `mcpServers`/`mcp` configs |
| 3 | Remove skills | Delete `~/.claude/skills/cognistore-*/` directories (query, capture, plan) and `~/.copilot/skills/cognistore-*.md` files |
| 4 | Uninstall Ollama models | `ollama rm <embedding model>` and, when it was pulled, `ollama rm <cleanup model>` |
| 5 | Uninstall Ollama binary | `brew uninstall ollama` (macOS) or remove binary (Linux) |
| 6 | Clear provider secrets | `cleanup_provider_secrets` removes each provider's OS-keychain entry (run before the data dir is deleted) |
| 7 | Close SDK | Gracefully close database connections |
| 8 | Remove data directory | `rm -rf ~/.cognistore/` (database + WAL files + `providers.json`) |
| 9 | Clean backup files | Remove `*.bak.*` files created during config injection |
| 10 | Self-delete app | `setTimeout` → remove app from `/Applications/` (macOS) or `~/.local/bin/` (Linux) |

### Setup/Uninstall Symmetry Rule

Every resource created by setup **must** be removed by uninstall. This is a mandatory architectural constraint documented in `CLAUDE.md`:

| Setup Creates | Uninstall Removes |
|---------------|-------------------|
| `~/.cognistore/` directory | Remove recursively |
| `knowledge.db` (SQLite) | Removed with directory |
| Ollama via brew/curl | Uninstall via brew or remove binary |
| `ollama serve` process | Stop via `pkill` |
| `nomic-embed-text` model | Remove via `ollama rm` |
| Cleanup LLM model (lazily pulled) | Remove via `ollama rm <cleanupLlmModel>` |
| CLAUDE.md markers | Remove via ConfigManager |
| copilot-instructions.md markers | Remove via ConfigManager |
| MCP config entries (4 files) | Remove via ConfigManager |
| Claude skills directories | Remove directories |
| Copilot skill files | Remove files |
| Claude plan skill directory | Remove `~/.claude/skills/cognistore-plan/` |
| Copilot plan skill file | Remove `~/.copilot/skills/cognistore-plan.md` |
| OpenCode skill directories | Remove `~/.config/opencode/skills/cognistore-*/` |
| OpenCode plugins | Remove `~/.config/opencode/plugins/cognistore-*` files |
| Compiled instruction files | Removed with sidecar bundle (not deployed to user filesystem) |
| System knowledge entries (`type=system`) | Removed with database directory |
| `~/.cognistore/providers.json` | Removed with directory |
| Provider secrets in OS keychain | `cleanup_provider_secrets` (Tauri) before the directory is deleted |
| App in /Applications/ | Self-delete via rmSync |
