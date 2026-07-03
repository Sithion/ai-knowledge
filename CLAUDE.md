# CogniStore - Agent Rules

## Architecture (v1.0.4 — App-first, Docker-free)

- **Entry point**: Tauri desktop app (macOS .dmg, Linux .AppImage/.deb)
- **Database**: SQLite + sqlite-vec (file at `~/.cognistore/knowledge.db`)
- **Embeddings**: Ollama native (auto-installed by app on first launch)
- **Dashboard**: Tauri app (webview + Fastify sidecar)
- **MCP Server**: `@cognistore/mcp-server` npm package (only npm package remaining)
- **CLI**: Deprecated (removed in v0.6.0)
- **Docker**: Removed entirely

## Setup / Uninstall Symmetry (MANDATORY)

The Tauri app's setup wizard creates resources; the uninstall button must remove them.

**Rule:** If setup creates, copies, injects, or modifies anything, uninstall MUST remove or revert it.

| Setup action | Uninstall action |
|---|---|
| Create `~/.cognistore/` directory | Remove directory recursively |
| Create `~/.cognistore/knowledge.db` (SQLite + schema) | Removed with directory |
| Install Ollama via brew/curl | Uninstall Ollama via brew uninstall or remove binary |
| Start `ollama serve` | Stop `ollama serve` via pkill |
| Pull embedding model via Ollama API | Remove model via `ollama rm` |
| Inject `~/.claude/CLAUDE.md` markers | Remove markers via ConfigManager |
| Inject `~/.github/copilot-instructions.md` markers | Remove markers via ConfigManager |
| Inject `~/.copilot/copilot-instructions.md` markers | Remove markers via ConfigManager |
| Inject `~/.config/opencode/AGENTS.md` markers | Remove markers via ConfigManager |
| Add `cognistore` to `~/.claude/mcp-config.json` | Remove entry via ConfigManager |
| Add `cognistore` to `~/.claude.json` | Remove entry via ConfigManager |
| Add `cognistore` to `~/.copilot/mcp-config.json` | Remove entry via ConfigManager |
| Add `cognistore` to `~/.config/opencode/opencode.json` | Remove entry via ConfigManager |
| Inject `mcp__cognistore` server-scope allow rule (all tools) in `~/.claude/settings.json` | Remove the rule + any legacy `mcp__cognistore__*` entries via ConfigManager |
| Copy global hook scripts to `~/.cognistore/hooks/{claude-code,copilot}/` | Removed with `~/.cognistore` directory |
| Inject hooks into `~/.claude/settings.json` (`hooks` key) | Remove cognistore hook entries via `ConfigManager.removeHooks` |
| Write `~/.copilot/hooks/hooks.json` reminder hooks | Remove cognistore entries via `ConfigManager.removeCopilotHooks` |
| Copy Claude skills to `~/.claude/skills/cognistore-*/` | Remove skill directories |
| Copy Copilot skills to `~/.copilot/skills/cognistore-*/` | Remove skill directories |
| App installed in /Applications/ (macOS) | Self-delete via rmSync |
| Store external-provider secret in OS keychain (`set_provider_secret`) | Delete keychain entries via `cleanup_provider_secrets` on uninstall |
| Create `~/.cognistore/providers.json` (external knowledge providers) | Removed with directory |

> **Note (provenance):** Setup injects a per-platform `COGNISTORE_PLATFORM` env var (`claude-code` / `copilot` / `opencode`) into the `env` block of each MCP config entry. This is not a separate resource — it is part of the MCP config entries above and is removed when those entries are removed via ConfigManager, so no extra uninstall row is required.

## Development Rules (MANDATORY)

### Upgrade Scripts
Every feature that changes **any** of the following MUST include an upgrade script that runs automatically when the app updates:
- **Database schema** → add a `.sql` migration file in `packages/core/src/db/migrations/{version}.sql`
- **Skills** → the upgrade system re-copies all skill templates on version change (no extra work needed)
- **Hooks** → global hooks are re-deployed on version change via `deployGlobalHooks()` (idempotent `injectHooks`/`setupCopilotHooks`) in `/api/upgrade/run` and `/api/redeploy`. Hook scripts live in `~/.cognistore/hooks/`; settings-file entries are strip-then-append merged so re-runs never duplicate or clobber user hooks
- **Agent instructions** → re-injected automatically on version change
- **MCP configs** → re-written automatically on version change

The upgrade system (`/api/upgrade/run`) compares `~/.cognistore/.version` with the running app version. On mismatch, it re-deploys all artifacts.

### Patch Notes
Every change MUST update `PATCH-NOTES.md` at the project root. Group entries by version and category (features, fixes, improvements). This file is linked from README.md.

### Testing
Every new feature should have corresponding tests in `packages/tests/`. The test suite runs on CI for every PR and feature branch push.

## Path Resolution

The Tauri sidecar sets environment variables for the Fastify server:
- `SQLITE_PATH` — path to SQLite database
- `OLLAMA_HOST` — Ollama API endpoint
- `DASHBOARD_DIST_PATH` — path to bundled frontend assets
- `TEMPLATES_PATH` — path to bundled skills/config templates
