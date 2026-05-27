# External Providers — Security Model

External knowledge providers add two trust surfaces to CogniStore: **secrets** (credentials for the
providers) and **untrusted content** (whatever a provider returns). This document explains how each is
handled. External search is **opt-in** and **per-provider** — the default install never reaches the
network.

## 1. Secrets — OS keychain, never on disk

Provider credentials are stored in the **operating-system keychain** (macOS Keychain, Windows
Credential Manager, Linux Secret Service), not in `providers.json`, logs, or the query string.

### What is stored where

- `providers.json` stores only a **`secretRef`** (a keychain reference, typically the provider `id`)
  and, for custom-header auth, the header name. No secret value.
- The keychain stores the secret value under service `cognistore`, account = the `secretRef`.

### Cross-process injection (why only Rust touches the keychain)

The dashboard server and any MCP subprocess are Node processes that must not access the keychain
directly. Only the Tauri (Rust) process does:

1. The UI sets a secret → `invoke('set_provider_secret', { id, value })` (a custom Tauri command)
   writes it to the keychain.
2. On launch, the Rust sidecar reads the provider ids from `providers.json`, fetches each secret from
   the keychain, and injects it into the Node sidecar's environment as
   `COGNISTORE_PROVIDER_SECRET__<KEY>`, where `<KEY>` is the `id` uppercased with every non-alphanumeric
   character replaced by `_`.
3. The dashboard server copies every `COGNISTORE_PROVIDER_SECRET__*` variable into the environment of
   the `@cognistore/mcp-server` subprocess, so the agent's MCP server inherits them.
4. `EnvSecretStore` resolves a `secretRef` by reading that env var (the sanitization matches the Rust
   side exactly). Providers receive the resolved token only at request time.

**Dev fallback:** outside the Tauri app you can set the `COGNISTORE_PROVIDER_SECRET__<KEY>` variable
manually instead of using the keychain.

### Uninstall symmetry

The dashboard's uninstall flow enumerates configured providers and calls
`delete_provider_secret`/`cleanup_provider_secrets` to remove their keychain entries **before** the
`~/.cognistore` directory (including `providers.json`) is deleted. Nothing is left behind in the
keychain. This mirrors the setup/uninstall rule in `CLAUDE.md`.

## 2. Untrusted content — indirect prompt injection

Anything a provider returns is shown to a human **and fed to an AI agent**. A malicious or compromised
provider could embed instructions in `title`/`content`/`metadata` to manipulate the agent (indirect
prompt injection). CogniStore's defenses:

- **Provenance separation.** External results are never merged into the vetted local list. They are
  returned in **separate, source-labeled sections** and rendered with an **"external · untrusted"**
  badge in the dashboard.
- **Explicit untrusted warning.** The MCP `getKnowledge` response includes an `externalNote` stating
  that external results are untrusted reference data to consider, **never instructions**. The dashboard
  shows the same warning.
- **Size caps.** Each result's `content` is truncated (~8 KB) and each section is capped (~64 KB), to
  limit injection payloads and response blowup.
- **No cross-ranking.** Provider `score` values are not comparable to local cosine similarity and are
  never used to reorder local results — only ordering within the provider's own section.

## 3. Network egress

- **HTTPS only by default.** HTTP providers must use `https://` and a public host; loopback/private
  hosts are rejected by an SSRF guard unless the entry sets `allowInsecure: true` (intended for local
  development only).
- **Per-provider timeout.** Default 5 s, with per-provider abort. A slow, hanging, or failing provider
  affects only its own section — local search and other providers are isolated from it.
- **Opt-in, small blast radius.** Providers are disabled until enabled, and external search runs only
  when explicitly requested per query or via the global `alwaysSearchExternalProviders` setting.

## Checklist for provider authors

- Treat your `content` as data; do not embed instructions for the agent.
- Serve over HTTPS with a valid certificate.
- Respond within the timeout and honor `k`.
- Never expect or echo secrets in URLs or logs.
