# Tauri Sidecar Architecture

## Overview

The desktop application uses a **sidecar model**: Tauri v2 (Rust) manages the window and lifecycle, while a Fastify (Node.js) server handles all business logic. The WebView loads the React frontend from `localhost`, which communicates with the Fastify server via HTTP.

```
┌─────────────────────────────────────────────────┐
│  Tauri v2 (Rust)                                │
│                                                 │
│  ┌──────────┐    spawn     ┌─────────────────┐  │
│  │ main.rs  │ ──────────→  │ Fastify sidecar │  │
│  │          │  port 3210+  │ (Node.js child)  │  │
│  └──────────┘              └────────┬────────┘  │
│                                     │           │
│  ┌──────────────────────┐   HTTP    │           │
│  │ WebView (React)      │ ←────────┘           │
│  │ http://localhost:PORT │                      │
│  └──────────────────────┘                       │
└─────────────────────────────────────────────────┘
```

## Startup Sequence

**File:** `apps/dashboard/src-tauri/src/main.rs`

```
1. Register Tauri plugins (updater, process)
2. setup() callback:
   a. find_node()          → resolve Node.js v24 binary path
   b. Resolve resource paths (dist-server, dist, node_modules, templates)
   c. Compute SQLite path  → ~/.cognistore/knowledge.db
   d. find_available_port(3210) → scan for free port
   e. spawn_node()         → launch Fastify as child process
   f. wait_for_ready()     → wait up to 120s for the READY marker on the child's stdout
                             (allows a cold nvm Node install) — see Readiness Handshake
   g. window.navigate()    → point WebView to http://localhost:PORT
3. on_window_event(Destroyed) → kill sidecar process
```

## Node.js Discovery

**File:** `apps/dashboard/src-tauri/src/sidecar.rs`

The app requires Node.js v24 (exact major — the bundled `better-sqlite3` is ABI-pinned). It **reuses** an existing v24 if present and only installs when none is found. Discovery follows a priority chain (works on macOS + Linux):

| Priority | Source | Path Pattern |
|----------|--------|-------------|
| 1 | nvm v24 (exact) | `~/.nvm/versions/node/v24.*/bin/node` |
| 2 | System node v24 | `which node` (verified via `--version`) |
| 3 | Fallback paths v24 | `/opt/homebrew/bin/node` (mac), `/usr/local/bin/node`, `/usr/bin/node` (linux) |
| 4 | Any nvm version | Latest available in `~/.nvm/versions/node/` |
| 5 | Any system node | `which node` (any version) |

Each candidate is verified with `check_node_major(path, 20)` which runs `node --version` and parses the major version.

## Environment Variables

The Rust shell passes configuration to the Fastify sidecar via environment:

| Variable | Value | Purpose |
|----------|-------|---------|
| `SQLITE_PATH` | `~/.cognistore/knowledge.db` | Database file location |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `nomic-embed-text` | Embedding model name |
| `EMBEDDING_DIMENSIONS` | `768` | Vector dimensions |
| `DASHBOARD_PORT` | `3210+` (dynamic) | Fastify server port |
| `DASHBOARD_DIST_PATH` | Resource path | React build output |
| `TEMPLATES_PATH` | Resource path | Skills + config templates |
| `NODE_ENV` | `production` | Runtime mode |
| `NODE_PATH` | Resource path | Node modules resolution |
| `COGNISTORE_MANAGED` | `1` | Marks an app-launched sidecar; required for the startup artifact self-heal |

`COGNISTORE_MANAGED` is set only by the Tauri shell. A sidecar started any other way (tests, `pnpm dev`)
never re-deploys the developer's agent configs on launch.

## Port Allocation

**Function:** `find_available_port(start: u16) -> u16`

Scans ports starting from 3210, testing each with a TCP bind. Returns the first available port. This avoids conflicts if multiple instances run or another service uses 3210.

## Readiness Handshake

**Functions:** `spawn_node()` / `wait_for_ready()` in `sidecar.rs`

Readiness is signalled **over the child's own stdout pipe**, not over HTTP. After `listen()` the sidecar
prints a single line containing `COGNISTORE_SIDECAR_READY`; the shell reads that line and navigates the
WebView. Only the process the shell spawned can write to that pipe, so nothing on the network can forge
readiness, and no secret has to be published to establish it — this replaced the earlier scheme where the
shell polled `GET /api/health` and matched an identity token in the body (removed in v2.5.0, see
[API reference — Authentication](./api-reference.md#authentication)). It is edge-triggered rather than polled, so the window opens
as soon as the server binds. The marker string is a cross-process contract: the Rust `READY_MARKER` const
and the TS const each name the other.

Two pipe rules the shell must keep (both are load-bearing, v2.5.2):

- **stdout is drained for the life of the process**, never only until the marker. The reader task keeps
  looping and discarding lines instead of returning; dropping the `ChildStdout` closes the pipe's read
  end and the sidecar's next `console.log` — its access logger fires on nearly every request — dies with
  an uncaught `write EPIPE`. Node does not install a SIGPIPE handler for piped, non-TTY stdio, so that
  write failure surfaces as a fatal `'error'` event. Between v2.5.0 and v2.5.2 this killed the sidecar on
  every launch, a few dozen milliseconds after it reported ready; the symptom was a blank window.
- **stderr is drained too**, on a dedicated thread, and echoed with a `[sidecar stderr]` prefix. Left
  attached-but-unread, the sidecar blocks once the 64KB OS pipe buffer fills.

## Sidecar Lifecycle

- **Spawn:** `std::process::Command::new(node_path).arg(server_js).envs(...)` — piped stdout/stderr
- **Readiness:** stdout marker line, 120s budget (see [Readiness Handshake](#readiness-handshake))
- **Cleanup:** On window `Destroyed` event, `SidecarState.kill()` terminates the child process
- **Degraded mode:** If SDK initialization fails on startup, server enters degraded mode — endpoints return 503, retry every 10 seconds
- **Artifact self-heal:** Right after `listen()`, the sidecar re-deploys agent instructions, MCP configs, skills and global hooks when the on-disk artifacts lag the running version — so an app that is never opened does not keep stale hooks/skills. It publishes nothing to `GET /api/upgrade/progress` — that endpoint describes the user-visible upgrade only, and a self-heal has no screen waiting on it. See [API reference — Upgrade](./api-reference.md#upgrade).

## Auto-Update

**File:** `apps/dashboard/src/components/UpdateChecker.tsx`

| Setting | Value |
|---------|-------|
| Check interval | 30 minutes (after 5s initial delay) |
| Endpoint | `https://github.com/Sithion/cognistore/releases/latest/download/latest.json` |
| Signature verification | Ed25519 public key in `tauri.conf.json` |
| User flow | Banner → "Update now" → download progress → auto-relaunch (1.5s) |

## Security (CSP)

**File:** `apps/dashboard/src-tauri/tauri.conf.json`

```
default-src 'self'
connect-src 'self' http://localhost:* http://127.0.0.1:* https://github.com https://api.github.com
style-src 'self' 'unsafe-inline'
script-src 'self'
img-src 'self' data:
```

`unsafe-inline` is kept for **styles** only — React's `style={{…}}` attributes and Tailwind's injected styles require it. Scripts do not: the bundle is external files.

Note this CSP covers the `tauri://` asset protocol. The UI is navigated to `http://localhost:PORT`, so the CSP that actually applies in normal operation is the **response header the sidecar sends** on that origin; the two are kept equivalent.

## Bundled Resources

The Tauri build includes these resources (defined in `tauri.conf.json`):

| Source | Bundle Path | Content |
|--------|------------|---------|
| `../sidecar-bundle/dist` | `dist` | React frontend build |
| `../sidecar-bundle/dist-server` | `dist-server` | Compiled Fastify server |
| `../sidecar-bundle/node_modules` | `node_modules` | Production dependencies |
| `../templates` | `templates` | Skills, configs, instructions |
| `../package.json` | `package.json` | Version fallback for the sidecar |

The `bundle-sidecar.mjs` script (`apps/dashboard/scripts/`) prepares the sidecar bundle before `tauri build` by copying server output and pruning dev dependencies.

## App version resolution

The sidecar needs its own version to decide whether deployed artifacts are stale. It is **inlined at build
time** by `tsup.sidecar.ts` (`define: { __APP_VERSION__ }`, read behind a `typeof` guard so the plain `tsc`
build still works), with the bundled `Resources/package.json` as a runtime fallback. If neither resolves, the
version is `0.0.0` and the sidecar logs an error, skips the startup self-heal, and refuses to write the
version markers — a marker holding `0.0.0` would make every later upgrade check answer "already up to date".
