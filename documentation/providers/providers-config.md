# `providers.json` — Configuration Reference

External knowledge providers are configured in **`~/.cognistore/providers.json`**. The dashboard
(**Settings → External Knowledge Providers**) reads and writes this file for you, but the format is
documented here for inspection, version control, or scripted setup.

Secret **values** are never stored in this file — only a `secretRef` pointing at an entry in the OS
keychain (see [security.md](./security.md)).

## Top level

```jsonc
{
  "version": 1,                 // literal 1 (only supported version)
  "providers": [ /* entries */ ]
}
```

A missing or malformed file is treated as **no providers** — local search keeps working
(offline-first). The file is re-read on each search, so edits take effect without a restart.

## Provider entry

Every entry has these common fields, plus exactly one of `http` or `mcp` matching its `kind`:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Lowercase slug `^[a-z0-9][a-z0-9-]*$`. Also the keychain account and the env-var stem for secret injection — keep it stable. |
| `name` | string | yes | Human-readable label shown in the UI and in result sections. |
| `kind` | `"http"` \| `"mcp"` | yes | Which provider kind. Must match the present config block. |
| `enabled` | boolean | no (default `true`) | Disabled providers are never queried. |
| `http` | object | when `kind:"http"` | HTTP-contract config (below). |
| `mcp` | object | when `kind:"mcp"` | MCP-client config (below). |

### `http` block

| Field | Type | Required | Meaning |
|---|---|---|---|
| `url` | string (URL) | yes | Base URL; CogniStore POSTs to `{url}/search`. See [http-contract.md](./http-contract.md). |
| `auth.type` | `"none"` \| `"bearer"` \| `"header"` | no (default `none`) | Auth scheme. |
| `auth.headerName` | string | when `type:"header"` | Header to send the secret in. |
| `auth.secretRef` | string | for `bearer`/`header` | Keychain reference (typically the provider `id`). |
| `timeoutMs` | integer 1–30000 | no | Per-request timeout. Also bounded by the global per-provider timeout (default 5 s). |
| `allowInsecure` | boolean | no (default `false`) | Permit `http://`/loopback/private hosts. Off by default (SSRF guard). Use only for local dev. |

### `mcp` block

| Field | Type | Required | Meaning |
|---|---|---|---|
| `transport` | `"stdio"` \| `"http"` | yes | `stdio` spawns a child process; `http` uses Streamable HTTP. |
| `command` | string | for `stdio` | Executable to spawn (e.g. `npx`). |
| `args` | string[] | no | Arguments for the command. |
| `env` | object | no | Extra environment for the child process. |
| `url` | string (URL) | for `http` | Streamable HTTP endpoint of the MCP server. |
| `auth` | object | no | Same shape as `http.auth`; sent as a header to the MCP HTTP endpoint. |
| `mode` | `"tool"` \| `"resources"` | no (default `tool`) | How CogniStore extracts results (below). |
| `toolName` | string | for `mode:"tool"` | The MCP tool to call (e.g. `search`). |
| `argMapping` | object | no | Maps CogniStore's `query`/`k` to the tool's argument names. Default `{ "query": "query", "k": "limit" }`. |
| `resultPath` | string | no | Dot-path to the results array inside the tool output (when not the default shape). |

See [plug-mcp.md](./plug-mcp.md) for how `mode`/`argMapping`/`resultPath` map a server's output to
result sections.

## Enabling external search

External providers are **opt-in**. Local search is unchanged unless one of these is true:

- **Per query** — the caller passes `includeExternal: true` (or a `providers: [...]` allow-list). For
  the MCP `getKnowledge` tool these are optional inputs; the dashboard search passes
  `includeExternal: true`.
- **Globally** — the `alwaysSearchExternalProviders` setting in `~/.cognistore/settings.json`
  (default `false`, toggle in **Settings → External Knowledge Providers**). When `true`, every search
  also queries enabled providers by default.

In all cases results are returned **sectioned by source** — a local section plus one section per
provider — never merged or cross-ranked.

## Annotated example

```jsonc
{
  "version": 1,
  "providers": [
    {
      "id": "company-wiki",          // keychain account + env stem
      "name": "Company Wiki",
      "kind": "http",
      "enabled": true,
      "http": {
        "url": "https://wiki.internal/cogni",
        "auth": { "type": "bearer", "secretRef": "company-wiki" },
        "timeoutMs": 5000
      }
    },
    {
      "id": "docs-mcp",
      "name": "Docs MCP",
      "kind": "mcp",
      "enabled": false,             // present but not queried
      "mcp": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@acme/docs-mcp"],
        "mode": "tool",
        "toolName": "search",
        "argMapping": { "query": "query", "k": "limit" }
      }
    }
  ]
}
```
