# CI/CD Pipeline

## Overview

The project uses **GitHub Actions** with two workflows:

1. **CI** (`ci.yml`) — Validates pull requests
2. **Publish** (`publish.yml`) — Releases to npm and GitHub Releases on merge to main

## CI Workflow

**File:** `.github/workflows/ci.yml`
**Trigger:** Pull requests to `main`

```
Steps:
1. Setup pnpm (version from packageManager field)
2. Setup Node.js 24
3. pnpm install --frozen-lockfile
4. pnpm build (all workspace packages via Turborepo)
5. pnpm test
6. npm publish --dry-run (validate MCP server package)
```

## Publish Workflow

**File:** `.github/workflows/publish.yml`
**Trigger:** Push to `main` affecting `apps/**`, `packages/**`, `.github/workflows/**`, or `pnpm-lock.yaml`. Also supports `workflow_dispatch` for manual runs.

Three jobs run in sequence:

### Job 1: publish-mcp

Publishes `@cognistore/mcp-server` to npm.

```
Steps:
1. Build all packages
2. Run tests
3. Check if version exists on npm (npm view)
4. If new version → npm publish --provenance --access public
```

The `--provenance` flag enables npm provenance attestation, linking the published package to this GitHub repository.

### Job 2: create-release

Creates a GitHub Release with release notes.

```
Steps:
1. Read version from apps/dashboard/package.json
2. Check if release v{version} already exists
3. If not → create release with:
   - Download table (macOS arm64, macOS x64, Linux)
   - macOS gatekeeper workaround instructions
   - Feature highlights
```

### Job 3: publish-tauri

Builds desktop binaries for 3 platform targets:

| Platform | Runner | Target | Output |
|----------|--------|--------|--------|
| macOS (Apple Silicon) | `macos-14` | `aarch64-apple-darwin` | `.dmg` |
| macOS (Intel) | `macos-14` | `x86_64-apple-darwin` | `.dmg` |
| Linux | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | `.AppImage`, `.deb` |

```
Steps per platform:
1. Install system deps (Linux: webkit2gtk, appindicator, etc.)
2. Install Rust stable toolchain
3. Setup pnpm + Node.js 24
4. pnpm install --frozen-lockfile
5. pnpm turbo build --filter=@cognistore/dashboard
6. Bundle sidecar (node scripts/bundle-sidecar.mjs) — includes instruction compilation and plugin bundling
7. tauri-action → build + upload to GitHub Release
```

Binaries are signed with `TAURI_SIGNING_PRIVATE_KEY` for auto-update verification. The `tauri-action` generates `latest.json` automatically with `updaterJsonKeepUniversal: true` — there is no separate `generate-updater` job.

## Secrets

| Secret | Used By | Purpose |
|--------|---------|---------|
| `NPM_TOKEN` | publish-mcp | npm publish authentication |
| `GITHUB_TOKEN` | create-release, publish-tauri | Auto-provided, creates releases |
| `TAURI_SIGNING_PRIVATE_KEY` | publish-tauri | Sign binaries for auto-update |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | publish-tauri | Key password (empty if unset) |

## Version Management

### Bumping Versions

Use the version bump script:

```bash
pnpm bump 1.0.0
```

This updates:
- All 8 `package.json` files (root + apps + packages)
- `apps/dashboard/src-tauri/Cargo.toml`

### Release Flow

```
1. pnpm bump <version>
2. Commit + push to feature branch
3. Open PR → CI validates
4. Merge to main → Publish workflow:
   a. npm publish (if version is new)
   b. Create GitHub Release
   c. Build + upload binaries (macOS dmg, Linux AppImage/deb)
```

### Idempotent Publishing

Both npm publish and GitHub Release creation check if the version already exists before attempting to create. Re-running the workflow on the same version is safe — it will skip already-published artifacts.

## Agent Test Battery

**File:** `scripts/test-agents.sh`

An end-to-end test script that validates MCP tool behavior across all supported AI clients. This is a local test — not part of CI — used to verify that tool changes work correctly before release.

### What It Does

```
1. Build all packages locally (pnpm build)
2. Spin up a Docker-based Ollama instance for isolated embedding generation
3. Create a temporary local SQLite database
4. Swap MCP configs for Claude Code, Copilot, and OpenCode to point at the local build
5. Run tool-level tests (addKnowledge, getKnowledge, updateKnowledge, deleteKnowledge, plans, etc.)
6. Validate similarity scores and response correctness
7. Restore all original MCP configurations on completion (cleanup runs even on failure)
```

### Usage

```bash
./scripts/test-agents.sh
```

### Requirements

- Docker (for Ollama container)
- pnpm and Node.js 24
- Claude Code, Copilot, or OpenCode CLI installed (tests only the clients found on the system)

### Cleanup

The script traps EXIT and restores original MCP configs from backups, ensuring that even if tests fail, the user's environment is not left in a broken state.

## Related Files

| File | Purpose |
|------|---------|
| `.github/workflows/ci.yml` | PR validation |
| `.github/workflows/publish.yml` | Release pipeline |
| `apps/mcp-server/tsup.config.ts` | MCP server bundler config |
| `apps/dashboard/scripts/bundle-sidecar.mjs` | Sidecar preparation for Tauri build (runs instruction compiler, copies templates + plugins) |
| `apps/dashboard/templates/configs/compile-instructions.mjs` | Compiles `_base-instructions.md` to platform-specific instruction files |
| `scripts/bump-version.sh` | Cross-package version bump |
| `scripts/test-agents.sh` | Agent test battery (local, Docker-based) |
