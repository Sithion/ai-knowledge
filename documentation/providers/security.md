> **v2.5.0 changes at a glance**
>
> - `transport: 'stdio'` and `auth.allowInsecure` are **capabilities, not configuration**, and are now gated by an installation policy (`allowStdioProviders` / `allowInsecureProviderUrls` in `~/.cognistore/settings.json`, both default `false`; `COGNISTORE_ALLOW_STDIO_PROVIDERS` / `COGNISTORE_ALLOW_INSECURE_PROVIDER_URLS` override for a single run). The policy lives in a file rather than env because the sidecar and the MCP server load the same `providers.json` and must agree. A gated entry is dropped **individually** with a warning — never a whole-file rejection, which would take the user's other providers down with it.
> - `env` keys that alter process code loading (`LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS`, `BASH_ENV`, …) are refused outright.
> - The SSRF guard covers all of `127/8`, `169.254/16` (cloud metadata), `0.0.0.0`, `::`, CGNAT, `*.localhost` and the decimal/hex/octal IPv4 spellings, and re-checks the host **after DNS resolution** — a public name can still answer with an internal address.
> - `providers.json` is written `0600`.
> - **Provider secrets are no longer copied into the generated MCP config.** They used to be written in plaintext into `~/.claude/mcp-config.json`, `~/.claude.json`, `~/.copilot/mcp-config.json` and `~/.config/opencode/opencode.json` — three of them world-readable. Until the MCP process reads them from the keychain-backed store itself, **header-auth external providers are dashboard-only**.

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
- **stdio** servers receive their credential as an `env` var the subprocess reads (e.g. `NOTION_TOKEN`);
  the value is keychain-backed, not written to `providers.json`.
- **OAuth tokens** are NOT in the keychain-env path (they refresh at runtime) — see §1b.

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

## 1b. OAuth 2.1 for remote MCP servers

Remote MCP servers can authenticate with **OAuth 2.1 + PKCE** instead of a static header. CogniStore
reuses the MCP SDK's OAuth client (RFC 9728 / RFC 8414 discovery, PKCE S256, RFC 7591 Dynamic Client
Registration, token exchange/refresh) and only supplies persistence + the desktop redirect.

### Loopback redirect flow (RFC 8252)

Desktop apps can't use a web redirect, so CogniStore uses a **loopback** redirect:

1. The Tauri shell reserves an ephemeral port (`oauth_reserve` → `http://127.0.0.1:<port>/callback`).
2. The sidecar builds the authorization URL (the SDK saves the PKCE verifier + any DCR client info).
3. The shell opens the **system browser** at that URL and waits for the redirect on the reserved port
   (`oauth_await`, 120 s timeout), capturing `?code=…&state=…`.
4. The sidecar exchanges the code for tokens (`finishAuth`) and persists them.

The authorization code and tokens never transit a third party; the loopback listener accepts exactly
one request and returns a "you can close this tab" page.

### Token storage

OAuth tokens (access + refresh), the DCR client info, and the PKCE verifier are persisted by the
**always-running sidecar** in `~/.cognistore/oauth-tokens.json` (mode `0600`, atomic writes) — the
source of truth, so refresh works even when the dashboard window is closed. An optional OS-keychain
mirror (service `cognistore-oauth`) is available. Tokens are read/refreshed at request time; a search
never opens a browser (if a token is missing/unrefreshable the provider's section reports a re-auth
prompt instead of crashing the fan-out).

### Uninstall symmetry

The dashboard's uninstall flow calls `cleanup_provider_secrets`, which removes each provider's
`cognistore` secret **and** its `cognistore-oauth` token entry, and deletes
`~/.cognistore/oauth-tokens.json` — **before** the `~/.cognistore` directory (including `providers.json`)
is deleted. Deleting a single provider in the UI likewise clears its static-secret and OAuth keychain
entries plus its session in the token file. Nothing is left behind. This mirrors the setup/uninstall
rule in `CLAUDE.md`.

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

- **HTTPS only by default.** Remote MCP `url`s must use `https://` and a public host; loopback/private
  hosts (IPv4 + IPv6 incl. unique-local, link-local, IPv4-mapped) are rejected by an SSRF guard unless
  the entry sets `auth.allowInsecure: true` (local development only). stdio servers are local
  subprocesses and aren't subject to this.
- **Per-provider timeout.** Default 5 s, with per-provider abort. A slow, hanging, or failing provider
  affects only its own section — local search and other providers are isolated from it.
- **Opt-in, small blast radius.** Providers are disabled until enabled, and external search runs only
  when explicitly requested per query or via the global `alwaysSearchExternalProviders` setting.

## Checklist for provider authors

- Treat your `content` as data; do not embed instructions for the agent.
- Serve over HTTPS with a valid certificate.
- Respond within the timeout and honor `k`.
- Never expect or echo secrets in URLs or logs.
