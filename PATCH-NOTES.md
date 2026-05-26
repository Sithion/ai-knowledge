# Patch Notes

## v1.4.2

### Security
- **Free dependency vulnerability scanning in CI**: New `.github/workflows/security.yml` runs [OSV-Scanner](https://google.github.io/osv-scanner/) (Google, OSS, backed by osv.dev) over the whole repo, covering both dependency ecosystems in a single pass — npm (`pnpm-lock.yaml`) and Cargo (`apps/dashboard/src-tauri/Cargo.lock`) — on pull requests, pushes to `main`, and weekly (Mondays 06:00 UTC). The check fails when a known vulnerability is found. To respect the repo's curated Actions allowlist, the workflow is self-contained: it uses only `actions/checkout` plus the official OSV-Scanner release binary, version-pinned (v2.3.8) and SHA256 checksum-verified — no third-party Action. This gives Snyk/Aqua-equivalent coverage at no cost.
- **Dependabot enabled**: New `.github/dependabot.yml` opens weekly update PRs for three ecosystems — npm/pnpm (root workspace), Cargo (Tauri shell), and GitHub Actions (keeps the workflow SHA pins current) — with minor/patch updates grouped to reduce PR noise. OSV-Scanner gates on known vulnerabilities; Dependabot opens the bump PRs that resolve them.

## v1.4.1

### Features
- **Filter Token Consumption by provider**: Both the Token Consumption page and the floating widget gain an `All / Claude / Copilot` filter. `All` shows the combined total of both supported tools (the previous behavior); `Claude` scopes everything to the Claude Code adapter (`source = 'claude-code'`) and `Copilot` to the GitHub Copilot CLI adapter (`source = 'copilot-cli'`). On the page the filter sits next to the date-range picker and drives every section (totals, activity chart, models, cache gauge, time-of-day heatmap, top projects and top sessions); on the widget it's a compact segmented toggle under the title. The backend already supported `source` filtering end-to-end (`token_usage.source` column indexed via `idx_token_usage_source_model`, threaded through every aggregation and the `/api/token-usage` endpoint), so this is a UI change plus one persisted setting.
- **Provider choice persists**: The selection is stored in `~/.cognistore/settings.json` as `tokenProviderFilter`, alongside the date-range preference, so it is shared between the page and the widget and survives app restarts and upgrades. Defaults to `All`.

## v1.4.0

### Features
- **GitHub Copilot CLI token consumption**: A second token adapter joins the existing Claude Code adapter and reads from `~/.copilot/session-state/<sessionId>/events.jsonl` (Copilot CLI v1.x). Sessions with a `session.shutdown` event emit one record per model used (Opus / Sonnet / Haiku / GPT-x) with input / output / cache-read / cache-creation tokens, plus the project decoded from `session.start.data.context.cwd`. Live verification on a real `~/.copilot` directory: 247 records across 25+ projects, all five models attributed correctly. Sessions still active when scanned are skipped until they shut down; no extra config required.
- **All distribution cards on Stats follow the date range picker**: Knowledge by Type, Knowledge by Scope, Top Tags, and Tag Cloud were always-time totals — useless once the user had picked a 1-week window for everything else. They now refetch on range change via the new `/api/metrics/by-type`, `/api/metrics/by-scope`, and the existing top-tags + tags endpoints (both now accept optional `from`/`to`). Card titles get a small `(this period)` suffix in en/es/pt so the source is obvious. Total Entries remains range-independent.
- **Range-aware Consulted / Written cards on Stats**: Brings back the at-a-glance Consulted and Written counters that were removed in v1.3.0, but now they reflect the period chosen by the global date-range picker (1D / 1W / 1M / 1Y / custom) instead of the old fixed 1h / 24h windows.
- **Scrollable Stats cards**: `WidgetCard` gains an optional `maxBodyHeight` prop. Knowledge by Type / Scope / Top Tags / Tag Cloud now cap at 380px with internal vertical scroll, so a user with 30+ workspaces no longer sees one card push everything else off-screen.

### Security
- **Drop unused `@tanstack/react-query` dependency**: The package was declared in `apps/dashboard/package.json` but never imported anywhere in the codebase. Removing it eliminates the transitive attack surface from a dependency that was providing zero functional value. Verified: zero `@tanstack/*` packages in the lockfile post-install.

### Infrastructure
- **Repository range overloads**: `countByType`, `countByScope`, `topTags`, and `listTags` in `knowledge.repository.ts` accept optional `{ from, to }` ISO date params. When both are present, queries filter `created_at >= from AND created_at < to` (closed-open, matching the existing contributions endpoint). When omitted, behavior is identical to today so the Knowledge Stats widget, MCP server, and any other no-range caller keep working unchanged.
- **Adapter pattern proven**: `TokenSourceAdapter.scan()` now allows `record === null` so adapters can mark a file as "seen at this size, nothing to store yet" (used by Copilot for in-progress sessions). The scanner still advances `scan_state` so the next pass skips it until more bytes arrive.

## v1.3.0

### Features
- **Token Consumption page**: New top-level `/tokens` view that tracks how many input / output / cache-read / cache-write tokens you spend in AI coding tools. Includes a stacked daily activity area chart, a model ranking, a cache-efficiency gauge (`cache_read / (input + cache_read + cache_write)`), a 7×24 time-of-day heatmap, and top-projects + top-sessions tables. v1.3.0 ships a Claude Code adapter that parses `~/.claude/projects/<cwd>/<session>.jsonl` incrementally; adapters for Copilot (OTel) and Cursor can be added later without schema or UI changes.
- **Token Consumption widget**: Compact floating widget showing the four 7-day totals; click the header to open the full page. Available from the Widgets page and the tray submenu, with position persistence.
- **Global date-range picker**: New picker (1D / 1W / 1M / 1Y / custom calendar via `react-day-picker` v9) at the top of the Stats and Token Consumption pages. The chosen range drives Activity, Contributions, and the entire Token Consumption page, replacing the previous fixed 15-day and 90-day windows.
- **`getTokenUsage` MCP tool**: Read-only tool that returns the same aggregations as the dashboard for a given date range, optionally filtered by source / model / project.

### Fixes
- **Auto-update preference now survives upgrades**: The toggle previously lived in `localStorage`, which the Tauri webview can wipe across app re-installs and major upgrades, silently flipping the preference back to OFF. It now lives in `~/.cognistore/settings.json` (next to `widgets.json`, which is already known to survive upgrades) and is migrated from the legacy localStorage key on first launch.

### Improvements
- **Dashboard redesign**: The Stats page drops the always-confusing hourly/daily op counters (Consulted/Written 1h/24h) and the duplicated `Last 24h` / `Last 7d` / `Database Size` cards. Only `Total Entries` and the two range-driven charts remain. `Database Size` moves to Settings next to the other infrastructure cards.

### Infrastructure
- **`@cognistore/core` build is now idempotent**: previously `cp -r src/db/migrations dist/db/migrations` (and the matching `seeds` line) would *nest* the source folder inside the existing target on every rebuild after the first one — a BSD-`cp` gotcha. The result: any migration added after the dist had been built once (e.g. `1.3.0.sql`) silently landed at `dist/db/migrations/migrations/1.3.0.sql` and was never picked up by the loader. The build now `rm -rf`s those two folders before copying, so repeated `pnpm build` invocations produce the same layout the first one did.
- **`token_usage` + `scan_state` tables** (migration `1.3.0.sql`, also mirrored to `migrate.ts`'s `EMBEDDED_MIGRATIONS` so the bundled sidecar and the bundled MCP server get the schema without an on-disk migrations directory).
- **Background token scan**: 5-minute incremental scan loop in the Fastify sidecar, plus a one-shot scan on SDK ready. `INSERT OR IGNORE` with a deterministic id (sha256 of `source|sessionId|messageId|occurredAt`) keeps re-scans idempotent; per-file `scan_state.last_offset` keeps them cheap.
- **New endpoints**: `GET /api/token-usage`, `POST /api/token-usage/scan`, `GET /api/metrics/activity?from&to`, `GET /api/metrics/contributions?from&to`, `GET /api/settings`, `PUT /api/settings`. The existing `/api/metrics` is preserved unchanged so the Knowledge Stats widget keeps working.

## v1.2.2

### Fixes
- **Dashboard "Database Size" stuck value**: The Stats page reported only the size of `knowledge.db` and ignored its SQLite sidecars (`knowledge.db-wal`, `knowledge.db-shm`). Between WAL checkpoints the main file barely grows, so the displayed size could appear frozen for days while writes piled up in the WAL. The `/api/metrics` endpoint now sums all three files, so the reported size reflects real on-disk usage and updates promptly after every write.
- **Activity (Last 15 Days) chart leading zeros**: The chart queries the last 15 days from `operations_log`, but the background maintenance job pruned anything older than 7 days, so the first ~8 days of the window always rendered as zero even for daily users. Retention is now aligned to the chart window via a single `OPERATIONS_RETENTION_DAYS = 30` constant in `packages/core/src/repositories/knowledge.repository.ts`, giving the chart full visibility plus a safety margin.

## v1.2.1

### Improvements
- **MIT license**: Changed project license from BUSL-1.1 (Business Source License) to MIT.

### Fixes
- **Linux Ollama install via graphical sudo**: On Linux, the Ollama install script requires root. The setup wizard now tries `pkexec` first (graphical password prompt on GNOME/KDE/XFCE), falls back to non-sudo attempt, then shows clear terminal instructions with the exact command to run. Error messages in the setup page now render multiline text correctly.

## v1.2.0

### Features
- **Multiple floating widgets**: Three draggable widget types — Knowledge Stats (total entries, reads/writes), Plan Stats (plan status breakdown, task completion %), and Active Plans (scrollable list with progress bars). Each widget auto-refreshes every 10 seconds.
- **Widgets page**: New `/widgets` page in the sidebar (Tauri only) to manage all widget types. Cards show widget status with green indicator dot. Open/close buttons for each widget type.
- **Widget position persistence**: Widget positions are saved to `~/.cognistore/widgets.json`. On app restart, all widgets that were open are restored at their last positions.
- **Plan navigation from widget**: Clicking an active plan in the Active Plans widget navigates the main app to the Plans page with focus on that plan.
- **System tray with Widgets submenu**: System tray icon with "Show CogniStore", "Widgets" submenu (Knowledge Stats, Plan Stats, Active Plans), and "Quit". Create new widget instances directly from the tray.
- **Widget actions**: Active Plans widget rows show a delete button on hover. Click to delete the plan directly from the widget.
- **Dynamic Active Plans widget**: Widget height adjusts automatically based on content (up to configurable max, default 5 slots). Scrollbar appears when content exceeds max. Max visible setting available on the Widgets page.
- **Task visibility in Active Plans widget**: In-progress tasks are shown inline under each plan with blue status dots. Click the expand arrow to see all tasks (pending, in-progress, completed with strikethrough). Widget resizes dynamically when expanding/collapsing.

### Fixes
- **Widget close button**: Fixed close button not working — was using `window.close()` which doesn't work in Tauri webviews. Now uses Tauri window API with `core:window:allow-close` permission.
- **Ollama download 404 on Linux/macOS**: Ollama v0.19.0 changed release format from standalone binaries to `.tar.zst` archives, breaking fallback download URLs. Removed broken binary download fallbacks; both platforms now use install script with clear manual install instructions if it fails.
- **Active Plans widget progress**: The `/api/plans` endpoint now enriches plans with `taskCount` and `completedTasks` (matching MCP server behavior). Progress bars in the Active Plans widget now show correct task completion.

### Improvements
- **Application logging**: Logs written to `~/.cognistore/cognistore.log` with automatic rotation (500 lines max). New log viewer in Settings page (collapsible, auto-refresh, color-coded by level). New `/api/logs` endpoint.
- **Friendly launcher errors**: Setup/server errors now show a branded error page with details toggle and retry button instead of raw technical messages.
- **macOS dock behavior**: Closing the main window hides it instead of quitting. Click the dock icon to reopen. Only "Quit" in tray actually exits.
- **Stats page label rework**: Renamed technical labels "Reads/Writes" to user-friendly "Consulted/Written" across all 3 languages (English, Spanish, Portuguese). Sub-labels changed from "searches/mutations" to "knowledge consulted/knowledge written".
- **CogniStore CLI adherence**: Improved hook enforcement for Claude Code — query hook now uses `decision: "block"` instead of `systemMessage` (advisory), with state-aware marker (`/tmp/.cognistore-queried`) so it only blocks until the first query. Plan task sync reduced noise (every 5th edit) with escalation to block after 15+ edits without tracking. Capture nudge starts earlier (5th edit instead of 10th).

### Infrastructure
- **Tauri multi-window support**: New Rust modules (`widgets.rs`, `widget_config.rs`, `tray.rs`) for widget window management, position persistence, and system tray. Widget windows use `WebviewWindowBuilder` with `always_on_top`, `transparent`, `decorations(false)`.
- **Vite multi-page build**: Three widget entry points (stats, plans, active-plans) alongside the main dashboard.
- **Dependency validation CI**: New `validate-dependencies` job in CI pipeline checks that external URLs (Ollama install script, GitHub Releases API) are reachable before merge.

## v1.1.0

### Fixes
- **Fix Ollama "input length exceeds context length" error**: The `/api/embeddings` request did not pass `options.num_ctx`, so Ollama used the model's default context window — which varies by Ollama version and could be too small for some inputs. Fix: explicitly pass `options: { num_ctx: 8192 }` in every embedding request (nomic-embed-text supports 8192 tokens).
- **Auto-resync embeddings on upgrade**: The upgrade endpoint only resynced vec tables when embedding dimensions changed. If entries existed without embeddings (e.g., from a previous failed embedding call), they were silently left orphaned. Added an integrity check (Step 1c) that compares `knowledge_entries` count vs `knowledge_embeddings` count — if any entries are missing embeddings, the upgrade drops vec tables and re-embeds all entries automatically.

### Features
- **`listPlans` MCP tool**: Agents can now browse and filter plans by status (`draft`, `active`, `completed`, `archived`) and scope. Each plan is enriched with task progress (`taskCount`/`completedTasks`). Response includes a hint when abandoned plans with incomplete tasks are detected, steering agents to resume existing plans instead of creating duplicates.
- **Auto-update toggle in Settings**: Added a checkbox to the Updates section (default: OFF). When disabled, the app will not automatically check for or download updates in the background. Manual "Check for updates" button remains always available. Preference is persisted in localStorage.

## v1.0.15

### Fixes
- **Serialize publish pipeline to eliminate race conditions**: `publish-mcp`, `create-release`, and `build-web` jobs ran in parallel with no dependency chain, causing intermittent pipeline failures. Added `needs` directives to create serial chain: `publish-mcp → create-release → build-web → publish-tauri`. Each job still handles its own setup (fast via pnpm/Turbo cache). npm publish runs first so failures stop the pipeline before creating releases or building desktop apps unnecessarily.
- **Fix embedding dimension mismatch (768→256)**: `sidecar.rs` hardcoded `EMBEDDING_DIMENSIONS=768`, which propagated to all MCP configs via `buildMcpEntry()`. The MCP server generated 768-dim embeddings while vec tables expected 256 (after Matryoshka migration in v1.0.12). Root cause chain: `sidecar.rs (768)` → Fastify `process.env` → `buildMcpEntry()` → `mcp-config.json (768)` → MCP server. Fixed by changing sidecar.rs to `256`. Existing user configs will be corrected on next upgrade run (re-writes all MCP configs).
- **Fix "Failed to start server" on fresh installs**: `sdk.initialize()` blocked the Fastify server from calling `app.listen()` — on first launch, `ensureModel()` streams the entire Ollama model download, which can take minutes. The Rust sidecar health check timed out after 15 seconds, showing an error screen. Fix: moved SDK initialization to a background async task after `app.listen()`, so the server binds the port immediately and the frontend loads with the setup wizard. Also increased health check timeout from 15s to 30s as safety net.
- **Fix upgrade screen showing after Tauri auto-update**: After Tauri auto-updates the binary, `~/.cognistore/.version` still contains the old version (Tauri only replaces the app bundle, not user data). On next launch, the version mismatch triggered the full upgrade screen. Fix: `App.tsx` now silently runs the upgrade in the background when a version mismatch is detected, going straight to the dashboard on success. Falls back to the visible upgrade screen with retry only if the silent upgrade fails.
- **Fix publish pipeline failing on re-run (asset conflict)**: `tauri-action` failed with "already_exists" when re-running the pipeline because updater artifacts (`.tar.gz`, `.tar.gz.sig`, `latest.json`) don't have versions in their filenames. Added a cleanup step before `tauri-action` that deletes stale updater assets from the release via `gh api`, making the pipeline idempotent.

### Security
- **Harden GitHub repo**: Enforce admins on branch protection (no direct push to main), dismiss stale reviews, require last push approval, require CODEOWNERS review. Pin all 8 external GitHub Actions to commit SHA hashes. Restrict Actions to GitHub-owned + verified creators + 4 explicit third-party patterns. Create `production` environment with required reviewer.

### Improvements
- **Mid-session knowledge capture enforcement**: Agents were only reminded to capture knowledge at session end (Stop/sessionEnd hook), making it easy to skip. Added PostToolUse hooks that nudge agents during work — after 10+ edits without calling `addKnowledge()`, a prescriptive reminder fires every 5th edit. Positive reinforcement: calling `addKnowledge()` sets a marker that silences all nudges. Stop/sessionEnd hooks are now context-aware: lighter reminder if knowledge was captured, very insistent if not. Applied to both Claude Code and Copilot skill templates.

## v1.0.13

- Version bump to recover npm publish pipeline (v1.0.10–v1.0.12 failed to publish due to expired NPM_TOKEN)
- Includes all v1.0.12 fixes and improvements below

## v1.0.12

### Improvements
- **Reduce embedding storage via Matryoshka truncation (768→256 dims)**: nomic-embed-text supports Matryoshka Representation Learning — the first 256 dimensions retain ~95% of semantic accuracy. Embeddings are now truncated to 256 dims + L2-normalized after Ollama returns the native 768-dim vector. Each embedding drops from 3 KB to 1 KB (67% reduction). Auto-migration detects dimension mismatch on startup and re-embeds all entries. Input text size (8192 token context window) is unchanged.
- **Periodic WAL checkpoint**: Added `walCheckpoint()` (PASSIVE mode) to the 6-hour maintenance interval alongside `cleanupOldOperations()`. Keeps the WAL file compact without blocking readers/writers.
- **Auto-cleanup completed plan embeddings**: Plans with status completed/archived older than 30 days have their embeddings deleted automatically. Semantic search only queries draft/active plans, so this has zero functional impact.
- **Encourage pattern storage in agent instructions**: Added Pattern Checklist (5 concrete questions) to all 3 capture skills (claude-code, copilot, opencode). Enhanced `addKnowledge` tool description to emphasize patterns with global scope. Added pattern prompt to stop-reminder hooks. Added pattern bullet to CHECKPOINT 3 in base instructions.

### Fixes
- **Fix plan detail markdown table rendering**: Added `remark-gfm` plugin to `react-markdown` in `PlansPage.tsx` and `KnowledgeCard.tsx`. Tables were rendering as raw text because `react-markdown` only supports CommonMark by default — GFM tables require the `remark-gfm` plugin. CSS styles for tables already existed in `styles.css`.
- **Fix MCP server stdout pollution breaking protocol handshake**: `packages/core/src/db/migrate.ts` had 4 `console.log()` calls that wrote migration status messages to stdout. Since the MCP server uses stdio transport (stdin/stdout for JSON-RPC), any non-JSON output on stdout corrupts the protocol handshake and causes Claude Code / Copilot to fail connecting. Changed all `console.log` → `console.error` in migrate.ts so diagnostic output goes to stderr instead
- **Fix plan task tracking enforcement**: Agents created plans via `createPlan()` but never called `updatePlanTask()` during execution — all tasks stayed "pending". Three root causes fixed:
  1. `SubagentStop`, `PostCompact`, `TaskCompleted` hooks were unsupported event types that never fired — removed dead hooks
  2. `PostToolUse` only fired on `ExitPlanMode`, not during Edit/Write/Bash where actual work happens — added state-aware PostToolUse hooks on execution tools
  3. Hook messages used advisory language ("sync CogniStore plan") instead of prescriptive ("STOP. Call X NOW") — rewrote all messages with exact function signatures
- **State-aware hook system**: New `/tmp` marker file mechanism tracks active planId across hooks. `post-create-plan-marker.sh` sets the marker after `createPlan()`, `post-edit-task-sync.sh` checks it before reminding, `post-task-update-marker.sh` resets the counter on compliance (positive reinforcement), `post-update-plan-cleanup.sh` cleans up on plan completion
- **Throttled reminders**: PostToolUse hook on Edit/Write/Bash fires every 3rd edit instead of every time, reducing noise while maintaining enforcement. Counter resets when agent calls `updatePlanTask()` — compliant agents get fewer reminders
- **Switch embedding model from all-minilm to nomic-embed-text**: `all-minilm` has a 256-token context window causing `createPlan()` to fail with large content. `nomic-embed-text` supports 8192 tokens (32x more) with 768 dimensions. Upgrade automatically detects dimension mismatch, pulls new model, drops/recreates vec tables, and re-embeds all existing entries and plans. `maxInputChars` raised from 500 to 2000.
- **Fix auto-update system (3 root causes)**: The entire auto-update pipeline was broken:
  1. `window.__TAURI__` was undefined because the WebView loads from `http://localhost:{port}` (Node.js sidecar) without IPC access configured — added `remote.urls` to `capabilities/default.json`
  2. `createUpdaterArtifacts` was missing from `tauri.conf.json` — no `.tar.gz`/`.sig` files were generated, so `latest.json` was never uploaded (confirmed 404 on all releases v1.0.7–v1.0.11)
  3. Non-Tauri fallback path skipped auto-checks on launch and "Update Now" silently did nothing when `__pendingUpdate` was null
- **Fix isTauri detection**: Now checks both `__TAURI_INTERNALS__` (Tauri v2) and `__TAURI__` (legacy) for reliable environment detection
- **Add CSP for GitHub CDN**: Added `objects.githubusercontent.com` to `connect-src` for update artifact downloads
- **Improve update error handling**: Tauri updater failures now fall back to GitHub API check instead of silently failing; all errors logged with `[UpdateChecker]` prefix
- **Fix "Update Now" button in Settings**: When native Tauri update is unavailable, button now opens GitHub release page instead of doing nothing
- **Fix plan dedup KNN saturation**: rewrote `findSimilarActivePlans()` to use pre-filter approach — query `plans` table for draft/active IDs first, then compute cosine similarity in JS. The old KNN approach returned from ALL plans (including completed), saturating results and hiding active duplicates. Now works correctly even with 15+ completed plans
- **Fix knowledge embedding quality**: embeddings were generated from tags only (`tags.join(' ')`), making semantic search unreliable. Now uses full text: `${title} ${content} ${tags.join(' ')}`
- **Fix dashboard read count undercount**: `logOp('read')` was called once per `getKnowledge` call regardless of results returned — a search returning 10 entries counted as 1 read. Now logs N reads for N results, consistent with how writes are counted (1 per entry). Uses a batched SQLite transaction for efficiency
- **Fix `createEmbeddingsTable` hardcoded 768 default**: the function parameter default was `768` instead of `DEFAULT_EMBEDDING_DIMENSIONS` (256). This caused the vec0 table to be created with 768 dims when the env var was absent, conflicting with the Matryoshka 256-dim config and breaking all searches with a dimension mismatch error
- **Scope-filter activePlan hint in getKnowledge**: the `activePlan` returned by `getKnowledge` now filters by the caller's `scope` parameter, preventing cross-workspace plan hints
- **Add tasks to createPlan MCP tool schema**: the `tasks` property was missing from the MCP tool's input schema, causing inline tasks passed by agents to be silently dropped
- **Refactor listPlans**: replaced 4-branch if/else with single dynamic parameterized query supporting status, scope, or both filters
- **Fix Ollama embedding context overflow**: `all-minilm` has a 256-token context window but text was sent without truncation, causing `createPlan()` and `addKnowledge()` to fail with large content. Now truncates at 800 chars (word-boundary aware) in `OllamaEmbeddingClient.embed()`, protecting all callers. Limit is configurable via `maxInputChars`
- **Block ExitPlanMode without createPlan()**: Added PreToolUse hook on `ExitPlanMode` that uses a marker file gate (`/tmp/.cognistore-plan-persisted`). `EnterPlanMode` resets the marker, `createPlan()` sets it, and `ExitPlanMode` is **blocked** if it's missing. Previous enforcement was non-blocking (post-hook reminder arrived too late)

### Improvements
- **Prescriptive instruction language**: "Track each task" section in all agent instructions (Claude Code, Copilot, OpenCode) now uses mandatory language with PostToolUse enforcement notes
- **Removed dead hook scripts**: Cleaned up `subagent-stop-reconcile.sh`, `post-compact-reinject.sh`, `task-completed-check.sh` from both Claude Code and Copilot templates — these were registered under unsupported event types and never executed
- **Removed dead MCP tool files**: Deleted `apps/mcp-server/src/tools/` directory (9 files). All tools were rewritten inline in `server.ts` — the old files were never imported

### Features
- **Auto-archive stale draft plans**: `createPlan()` now runs `archiveStaleDrafts(24)` with 1-hour throttle, automatically archiving draft plans older than 24 hours
- **Scope parameter for listPlans**: `listPlans()` now accepts an optional `scope` parameter across repository, service, and SDK layers
- **Knowledge semantic dedup**: `addKnowledge()` checks for similar entries in the same scope+type (threshold 0.85). If a match is found, updates the existing entry instead of creating a duplicate. Response includes `deduplicated: true`
- **Scope regex validation**: scope field now enforced as `"global"` or `"workspace:<project-name>"` (alphanumeric, dots, hyphens, underscores) via Zod schema across all create/update/search schemas
- **Structured plan content requirement**: all plan skill templates (Claude Code, Copilot, OpenCode) now require `content` to include Context, Approach, Files to Modify, and Verification sections. New `pre-create-plan-check.sh` hook enforces this before `createPlan()` calls
- **Global knowledge encouragement**: capture skill templates and base instructions now actively encourage `scope: "global"` for language/framework/tool insights that apply beyond the current project
- **Plan card timestamps**: plan card dates in the dashboard now show full date+time (hours, minutes, seconds) instead of date-only

### Tests
- **KNN saturation test**: creates 15+ completed plans then verifies dedup still finds a draft in the same scope
- **archiveStaleDrafts edge cases**: verifies active/completed plans are not archived, returns 0 on empty database
- **listPlans backward compat**: undefined scope returns all plans
- **Knowledge dedup**: validates dedup merges similar entries in same scope+type, keeps entries separate across different scopes
- **Global scope knowledge**: validates knowledge creation with `scope: "global"`

## v1.0.11

### Fixes
- **Fix npm publish repository.url format**: corrected `repository.url` to use `git+https://...git` format, preventing npm auto-correction that breaks provenance attestation

### CI
- **Fail CI on npm publish warnings**: `npm publish --dry-run` in both CI and publish workflows now captures output and fails if any `npm warn publish` messages are detected, catching manifest issues before merge
- **Package.json validation tests**: new Playwright test validates bin paths start with `./`, repository URL has correct `git+https` format, required fields exist, and package is correctly scoped

## v1.0.10

### Features
- **Automatic plan deduplication**: `createPlan()` now uses semantic search (via sqlite-vec embeddings) to detect existing plans before creating new ones. If an active plan exists in the same scope, new tasks are added to it. If a semantically similar draft exists, it is updated instead of duplicated. Response includes `deduplicated: true` flag when an existing plan was reused
- **Enriched activePlan in getKnowledge**: the `activePlan` object now includes `scope`, `taskCount`, `completedTasks`, and a dedup-aware hint guiding the agent to use updatePlan instead of creating duplicates

### Improvements
- **Centralized plan embedding operations**: refactored inline SQL for plan embeddings into dedicated functions (`insertPlanEmbedding`, `updatePlanEmbedding`, `deletePlanEmbedding`, `searchPlansKnn`) in sqlite-vec.ts, consistent with knowledge embedding pattern
- **Updated agent instructions**: added dedup note to CHECKPOINT 2 in all platform instructions and "Automatic Deduplication" section to plan SKILL.md (Claude Code + Copilot)

## v1.0.9

### Improvements
- **Auto-approve all CogniStore tools**: expanded permission injection from 4 read-only tools to all 13 tools (read + write), so agents can call `createPlan()`, `addKnowledge()`, `updatePlanTask()`, etc. without prompting the user for permission. This removes friction that was breaking the automatic workflow
- **Reinforced agent instructions**: added CRITICAL section at the top of all platform instructions (Claude Code, Copilot, OpenCode) with a concise 1-line summary of the mandatory workflow. Added rule about tools being pre-approved
- **Prescriptive hooks**: rewrote all hook scripts across Claude Code and Copilot to use direct action commands (e.g., "STOP. Call getKnowledge() NOW") instead of passive reminders (e.g., "Have you queried?"). Hooks now include exact function signatures for easy copy-paste by the agent

## v1.0.8

### Fixes
- **Prevent upgrade on downgrade**: upgrade check now uses semver comparison instead of string inequality, so the upgrade flow only triggers when the running app version is strictly greater than the deployed version — never on downgrades

## v1.0.7

### Improvements
- **Auto-download on manual update check**: clicking "Check for updates" in Settings now auto-downloads and installs when an update is found (same as automatic background checks). Added "Update now" button and download progress directly in the Settings page

## v1.0.6

### Fixes
- **MCP server Node.js version mismatch**: setup/upgrade/reinstall now write the absolute path to the nvm Node 20 `npx` binary in MCP configs and prepend its bin dir to `PATH`, preventing `NODE_MODULE_VERSION` errors when the system Node is a different version. Stale npx caches are also cleared to force recompilation of native modules. Uninstall cleans up the npx cache as well

### Improvements
- **Remove edit button from knowledge cards**: clicking the card already opens the edit modal; the amber pencil button was redundant

## v1.0.5

### Improvements
- **Simplified search screen**: removed export button from the Knowledge page; replaced broken ☐ Unicode with SVG checkbox icon for bulk select
- **Icon buttons on knowledge cards**: replaced text Edit/Delete buttons with colored icon buttons (pencil on amber, trash on red)
- **Unified export/import**: replaced 5 separate buttons in Settings with 2 modal-based flows (Export and Import) supporting selective knowledge and plans in a single JSON file
- **Background auto-update**: in Tauri, updates download and install automatically in background with a restart prompt; outside Tauri, checks GitHub Releases API and shows download link
- **Documentation refresh**: expanded README Settings and Knowledge sections, added packages/tests to architecture tree, fixed version references

### Fixes
- **Export version**: export files now include the actual app version instead of hardcoded "0.9.5"
- **CLAUDE.md version**: updated architecture section version from v0.6.0 to v1.0.4

### Removed
- Old separate export endpoints (GET /api/export/knowledge, GET /api/export/plans)
- Old separate import endpoints (POST /api/import/knowledge, POST /api/import/plans)
- CSV export/import support (JSON-only now)
- "Only available in desktop app" update checker message

## v1.0.4

### Fixes
- **Node.js version mismatch crash**: removed unsafe fallback in `find_node()` that picked the latest nvm-installed Node regardless of major version. When Node 20 was missing, the app would use e.g. Node 23, causing a `NODE_MODULE_VERSION` mismatch with the bundled `better-sqlite3` native module. The fallback now skips incompatible versions and auto-installs Node 20 via nvm instead

## v1.0.3

### Improvements
- **Unified `addKnowledge` tool**: merged `addKnowledgeBatch` into `addKnowledge` — now accepts a single entry object or an array of entries. One tool, no ambiguity. `addKnowledgeBatch` is removed.
- **Updated date on cards**: knowledge and plan cards now show "updated" date when it differs from the created date
- **Scrollable plan tasks**: plan detail task list and active plans grid task list are now scrollable, supporting plans with many tasks
- **README cleanup**: removed hardcoded version below logo since npm and release badges already show the version

## v1.0.2

### Fixes
- **Crash on launch (SIGABRT)**: app crashed on machines without Node.js v20 due to setup errors propagating through the macOS FFI boundary (`panic_cannot_unwind` in `did_finish_launching`). Setup errors are now caught and displayed in the webview instead of panicking
- **Auto-install Node.js v20**: when Node.js v20 is not found, the app now automatically installs nvm and Node.js v20 before spawning the sidecar, removing the need for users to pre-install Node
- **Window destroy handler**: use `try_state()` instead of `state()` to avoid panic if sidecar was never managed (e.g., setup failed)

## v1.0.1

### Fixes
- **Plan stats donut charts**: fix visual gap in single-segment donuts (`paddingAngle` now conditional), add center label showing total count

## v1.0.0

### Milestone
First stable release. All features validated across Claude Code, Copilot, and OpenCode via automated test battery (5/5 scores).

### Features
- **Single-source config compiler**: new `_base-instructions.md` as the single source of truth for agent instructions, compiled to 3 platform-specific files (`claude-code-instructions.md`, `copilot-instructions.md`, `opencode-instructions.md`) via `compile-instructions.mjs` using `<!-- IF:platform -->...<!-- ENDIF -->` conditionals. Generated files are now gitignored
- **OpenCode enforcement**: 3 new SKILL.md templates (`cognistore-query`, `cognistore-plan`, `cognistore-capture`) deployed to `~/.config/opencode/skills/cognistore-*/`. New plugin at `~/.config/opencode/plugins/` with 3 event handlers (`tool.execute.after`, `session.end`, `experimental.session.compacting`)
- **Batch MCP tools**: `addKnowledgeBatch` (create multiple knowledge entries at once with optional planId for auto-linking) and `updatePlanTasks` (update multiple plan tasks at once)
- **Plan status guards**: auto-activate plan when any task moves to `in_progress`, auto-complete all tasks when plan is set to `completed`, reactivate plan if a task is updated on a `completed` plan
- **New hooks**: `SubagentStop` (fires when subagent completes, reminds to reconcile plan tasks), `PostCompact` (experimental, fires after context compaction, reminds to reload plan state), `TaskCompleted` (fires after updatePlanTask, reminds to start next task). All hooks now output standardized JSON `{"systemMessage": "..."}` format

### Improvements
- **MCP tool annotations**: `readOnlyHint: true` on read tools, `destructiveHint: true` on delete tools
- **MCP Resources**: `cognistore://context/{scope}` exports recent entries + active plans + tags
- **createPlan response**: includes planId reminder ("Your active plan ID is X. Pass planId to addKnowledge calls.")
- **updatePlan(active) response**: includes same planId reminder
- **getKnowledge response**: includes active plan detection ("You have an active plan: X")
- **addKnowledge with planId**: auto-creates output relation (non-system entries only)
- **listPlanTasks response**: includes planId reminder
- **Instruction compilation in build pipeline**: `bundle-sidecar.mjs` runs compiler before copying templates to sidecar bundle
- **All 3 platforms**: now have CHECKPOINT language, similarity scores, batch tools, Rules section

### Fixes
- **Confidence score step**: changed from 0.1 to 0.01 in AddKnowledgeModal and KnowledgeModal for finer granularity
- **Destructive actions**: all use ConfirmModal (portal-based, Escape key, backdrop blur, loading state)

## v0.9.16

### Features
- **System knowledge type** (`type='system'`): mandatory entries seeded during setup/upgrade, injected into agent context via UserPromptSubmit hook. Contains the CogniStore workflow protocol (query-first, plan lifecycle, capture-after)
- **System knowledge guards**: system entries cannot be deleted (single, bulk, or MCP), type cannot be changed via update, stripped from imports, excluded from dashboard, stats, search, and export
- **Archive button**: completed plans can now be archived from the dashboard via a new "Archive" button with confirmation modal
- **Active plans grid**: active plans section uses responsive CSS grid layout with blue left accent border and scope badge
- **Hook-based protocol injection**: UserPromptSubmit hooks read system knowledge from DB and inject as `[COGNISTORE-PROTOCOL]` system message, with hardcoded fallback if sqlite3 unavailable

### Fixes
- **Plan lifecycle enforcement**: SKILL.md templates now explicitly state `archived` status is dashboard-only — agents must never set it
- **Import sanitization**: CSV and JSON imports with `type='system'` are automatically downgraded to `type='pattern'`

## v0.9.15

### Features
- **Reusable ConfirmModal component**: new portal-based modal (`ConfirmModal.tsx`) with backdrop blur, Escape key, loading state, and i18n support — used as the standard for all destructive confirmations
- **Knowledge delete via modal**: replaced inline confirm/cancel buttons in KnowledgeCard with a proper confirmation modal
- **Bulk delete confirmation**: bulk delete now shows a modal with entry count before executing (previously had no confirmation)
- **Uninstall via modals**: converted the inline multi-step uninstall flow to a 2-step modal confirmation sequence

### Fixes
- **KnowledgeCard simplified**: removed `confirmingDelete` and `onCancelDelete` props — delete button now delegates to parent modal
- **PlansPage refactored**: plan delete now uses the shared ConfirmModal instead of an inline implementation

## v0.9.14

### Features
- **Input-based plan detection**: CHECKPOINT 3 now has dual triggers — INPUT (user message contains 3+ action steps) and OUTPUT (agent produced 2+ ordered steps). Previously only OUTPUT was detected, missing multi-step user requests
- **MCP tool annotations**: Read-only tools marked with `readOnlyHint: true` (getKnowledge, listTags, healthCheck, listPlanTasks). Future-proofing for when clients respect annotations in plan mode
- **MCP Resource `cognistore://context/{scope}`**: Exposes scope-aware KB context as auto-loaded resource with recent entries, active plans, and tags. Prepares for future resource support in plan mode
- **Permission config injection**: Read-only CogniStore tools auto-allowed in Claude Code's dontAsk mode via `~/.claude/settings.json` permission rules
- **Graceful degradation notice**: Agents warn when they cannot save plans to KB (tools blocked in plan mode)

### Fixes
- **Plan mode persistence**: createPlan() is now called BEFORE ExitPlanMode (not after). Fixes race condition where agent's turn ended before persisting the plan
- **OpenCode execution tracking**: Full Execution Tracking Protocol added to AGENTS.md (updatePlanTask lifecycle that Claude/Copilot get from SKILL.md Phase 2)
- **UserPromptSubmit hook**: INPUT detection added to cognistore-query hooks to detect multi-step tasks at the earliest point
- **Subagent plan leak**: Explicit instruction added to prevent subagents from calling createPlan() — "When launching a subagent, include 'Do NOT call createPlan()' in the prompt"

### Known assumptions
- **MCP tools in plan mode**: The plan mode persistence fix relies on MCP tools (createPlan, getKnowledge) being callable during Claude Code's plan mode. This was empirically confirmed (2026-03-20) but is not guaranteed by the spec — Anthropic could restrict MCP calls in plan mode in a future release. The `post-plan-check.sh` hook serves as a fallback if this assumption breaks.

## v0.9.13

### Fixes
- **Output-based plan detection**: CHECKPOINT 3 in all instruction templates (Claude Code, Copilot, OpenCode) now triggers based on OUTPUT — "if you produced 2+ ordered implementation steps, call createPlan()" — instead of intent ("any time you plan work"). This fixes plan mode ignoring createPlan() because the agent didn't identify itself as "planning work"
- **Consistent language across all templates**: all 3 instruction templates + both user-prompt-check.sh hooks use the same output-based detection rule

## v0.9.12

### Features
- **OpenCode AGENTS.md instructions**: new instruction template injected into `~/.config/opencode/AGENTS.md` during setup — OpenCode now gets the same knowledge-first protocol as Claude Code and Copilot (query → plan → track → capture)
- **OpenCode setup/upgrade/uninstall symmetry**: AGENTS.md is injected on setup, re-injected on upgrade/redeploy, and cleaned up on uninstall

### Fixes
- **Skill/hook rewrite — full lifecycle coverage**: skills and hooks now cover the entire plan lifecycle (creation + execution tracking), not just plan mode events. Previously hooks only fired on EnterPlanMode/ExitPlanMode, missing execution-phase tracking entirely
- **Claude Code plan mode compatibility**: `pre-plan-file-check.sh` now detects `.claude/plans/` directory paths (plan mode generates random slugs like `sorted-jumping-whistle.md` that the previous filename-only check missed)
- **Claude Code SKILL.md conflict**: changed approach from "NEVER write local files" to "write local AND ALSO call createPlan()" — works WITH plan mode instead of against it, resolving instruction priority conflict where system-level plan mode instructions overrode skill-level instructions
- **Claude Code `post-plan-check.sh`**: shortened verbose 8-line message to 1 direct instruction — reduces likelihood of model ignoring the hook after "finishing" planning
- **Copilot execution tracking**: restructured SKILL.md with Two-Phase Workflow (Planning + Execution) at the top, added execution tracking callout and task tracking reference table
- **Copilot hook fatigue**: shortened hook messages; `post-plan-check` now includes execution tracking reminder instead of only planning reminder
- **`user-prompt-check.sh` (both agents)**: updated to include execution tracking reminders on every user message, not just plan creation
- **Instruction templates**: claude-code-instructions.md and copilot-instructions.md updated with consistent plan tracking language
- **Renamed "AI Knowledge" to "CogniStore"**: all SKILL.md titles now use "CogniStore Plan" instead of "AI Knowledge Plan"

## v0.9.11

## v0.9.5

### Features
- **Export/Import**: export knowledge entries (JSON/CSV) and plans (JSON) for backup or migration; import with duplicate detection (hash-based) and automatic embedding regeneration
- **Scope Autocomplete**: replaced free-text scope input with dropdown autocomplete showing existing scopes across knowledge and plans; custom values still allowed
- **Bulk Delete**: checkbox selection mode on knowledge entries with bulk action bar (select all, deselect all, delete selected)
- **Plan Templates**: 4 predefined plan structures (Bug Fix, Feature, Refactoring, Investigation) with pre-filled title patterns, markdown content, default tags, and task lists
- **Inline Task Editing**: click-to-edit task descriptions, priority dropdown, editable notes, and status cycling (click status icon) directly in plan detail view

### Improvements
- **Data Management section in Settings**: centralized export/import UI with buttons for JSON/CSV knowledge export, plans JSON export, and file picker for imports with progress indicator
- **Export buttons on pages**: quick-access export buttons on Knowledge and Plans pages
- **New API endpoints**: `GET /api/scopes`, `DELETE /api/knowledge/bulk`, `GET /api/export/knowledge`, `GET /api/export/plans`, `POST /api/import/knowledge`, `POST /api/import/plans`

### Fixes
- **Duplicate plan prevention**: subagents (Agent tool) are now explicitly blocked from calling `createPlan()` — only the main conversation agent creates plans, preventing duplicate entries in the knowledge base

## v0.9.4

### Features
- **Create Plan from Dashboard**: users can now create draft plans directly from the Plans page with title, description, tags, scope, and tasks — then ask an agent to refine and execute the plan
- **POST /api/plans endpoint**: new server endpoint for creating plans from the dashboard UI

### Improvements
- **Markdown rendering**: plan detail view and card previews (both Plans and Knowledge) now render content as formatted markdown (headings, lists, code blocks, tables, blockquotes)
- **Unified UI pattern**: both Knowledge and Plans pages now use floating action button (FAB) + full-page form view instead of modal overlay
- **Unified 5s polling**: all pages now auto-refresh every 5 seconds; removed manual refresh interval selector from Stats page
- **Activity chart**: replaced single-line area chart with 3-line chart (Total, Reads, Writes) with color legend

### Fixes
- **Copilot instructions template**: rewrote `copilot-instructions.md` template to explicitly reference all 3 mandatory skills (`cognistore-query`, `cognistore-capture`, `cognistore-plan`) by name — fixes issue where Copilot treated skills as optional and wrote plans to local files instead of using `createPlan()`
- **Copilot [PLAN] mode**: updated `cognistore-plan` skill to explicitly state it applies in `[PLAN]` mode — plan mode changes HOW you plan, NOT WHERE you store it (always `createPlan()`)

## v0.9.3

### Improvements
- **Plan enforcement**: createPlan() now mandatory for ALL tasks (removed "3+ steps" threshold)
- **Override clause**: plan skill explicitly overrides all other planning rules (EnterPlanMode, TodoWrite, local files)
- **Knowledge linking**: mandatory relatedKnowledgeIds on create + addPlanRelation during execution
- **Plans list auto-refresh**: 10s polling on plans list view (not just detail view)
- **CI version check**: new `version-check` job blocks PRs to main that forget version bumps

## v0.9.2

### Fixes
- **PlansPage**: removed plan status change buttons from dashboard — plan status can only be changed by agents via MCP

### Improvements
- **Copilot skills**: converted from flat `.md` files to directory format (`SKILL.md` + hooks) matching Claude Code structure
- **Copilot hooks**: added `preToolUse`, `sessionEnd`, and `postToolUse` hooks (parity with Claude Code)
- **Instruction templates**: stronger enforcement language with CHECKPOINT-based flow for both Claude Code and Copilot
- **Skill descriptions**: rewritten with MANDATORY/BLOCKING REQUIREMENT language for better auto-triggering
- **UserPromptSubmit hook**: new earliest-possible hook fires when user sends a message, BEFORE any tool use — reminds to query knowledge base and use createPlan() for multi-step tasks
- **Plan enforcement**: added CHECKPOINT 3 to instruction templates — 3+ steps = mandatory createPlan()
- **Plan file guard hook**: new PreToolUse hook on Write/Edit detects plan-like filenames (plan.md, TODO.md, etc.) and warns to use createPlan() instead
- **Plan skill rewrite**: explicit FORBIDDEN section listing banned patterns (local files, task-list-only, chat-only plans)
- **PostToolUse hook strengthened**: ExitPlanMode hook now explicitly forbids local file plans and task-list substitutes
- **Re-deploy button**: new "Re-deploy configurations" in Settings → Maintenance re-deploys skills, hooks, instructions, and MCP configs without losing data
- **Plan detail auto-refresh**: 5s polling on plan detail view + new `GET /api/plans/:id` endpoint
- **Upgrade cleanup**: old flat Copilot skill files (`.md`) are automatically removed during upgrade

## v0.9.1

### Upgrade System (New)
- App detects version changes on startup and shows upgrade screen (`vOLD → vNEW`)
- Re-deploys: database migrations, agent instructions, MCP configs, skills/hooks
- Visual progress with step-by-step status indicators

### Bug Fixes
- **Embedded migrations**: MCP server now works via npx (SQL embedded in code, not external files)
- **UpdateChecker**: distinguish manual vs automatic checks — errors only shown when user clicks "Check for updates"
- **UpdateChecker**: new states `upToDate`, `error`, `unavailable` with proper SettingsPage feedback
- **Plan creation**: rollback plan if task creation fails (no more orphaned plans)
- **HTTP status codes**: 404 returned for missing resources (was 200 with error body)
- **Upgrade race condition**: concurrent upgrade requests blocked with 409 Conflict
- **PlansPage**: shows error message instead of infinite loading on API failure
- **Version tracking**: `.version` file saved on setup completion (not via fragile hook)

### Other
- **CI:** no longer triggers on push to `main` (only PRs + feature branches)
- **PATCH-NOTES.md** added and linked from README
- **CLAUDE.md**: development rules (upgrade scripts, patch notes, testing) for all contributors

## v0.9.0

### Plans (New Feature)
- Plans are now a **separate entity** with their own `plans` table and embedding
- Plan tasks (`plan_tasks`) with status (pending/in_progress/completed), priority (low/medium/high), notes, and position ordering
- Plan relations (`plan_relations`) link plans to knowledge entries as input (consulted) or output (produced)
- 6 new MCP tools: `createPlan`, `updatePlan`, `addPlanRelation`, `addPlanTask`, `updatePlanTask`, `listPlanTasks`
- New `/plans` dashboard page with active plans section, task icons (spinner/check), progress bars, and priority indicators
- Plan analytics on StatsPage: metric cards, status distribution chart, task completion chart, activity chart

### Migration System
- Versioned SQL migrations (`schema_version` table + `.sql` files per version)
- Bootstrap detection for existing databases (automatically marks v0.8.0 as applied)
- Seeds directory for initial data on fresh installs

### Upgrade System (New)
- App detects version changes on startup and shows upgrade screen
- Re-deploys: database migrations, agent instructions, MCP configs, skills/hooks
- Visual progress with `vOLD → vNEW` header and step-by-step status

### Knowledge Improvements
- `title` field added to all knowledge entries (mandatory, shown on cards)
- `addKnowledge` MCP tool now requires `title` parameter
- `PLAN` removed from KnowledgeType (plans are separate)

### Dashboard
- Cleanup orphan embeddings moved from Stats to Settings > Maintenance
- New `cognistore-plan` skill with PostToolUse hook on ExitPlanMode
- Plan completion protocol: agents must verify all tasks completed before closing plan

### Auto-Update
- Removed redundant `generate-updater` CI job (tauri-action handles `latest.json`)

### Testing
- 69 automated tests in `packages/tests` (E2E, load, performance)
- CI workflow runs on PRs and feature branch pushes
- Pre-commit security hook scans for leaked secrets

### Documentation
- README and all 9 documentation files updated for v0.9.0

---

## v0.8.1

- Operations stats: read/write counters (last hour + last day)
- Settings page (renamed from Monitoring): infrastructure, updates, language, maintenance
- Heatmap color scheme (GitHub-style green)
- Browser language auto-detection
- UI improvements: chart tooltips, cleanup button as trash icon

## v0.8.0

- Mandatory skills with hooks (PreToolUse, Stop)
- Monitoring page with health checks
- UI improvements

## v0.7.x

- Bug fixes, CI improvements, search fixes, tag input redesign
