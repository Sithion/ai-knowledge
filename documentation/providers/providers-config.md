# `providers.json` — Configuration Reference

External knowledge providers are **MCP servers** configured in **`~/.cognistore/providers.json`**.
The dashboard (**Settings → External Knowledge Providers**) reads and writes this file for you, but
the format is documented here for inspection, version control, or scripted setup.

Secret **values** are never stored in this file — only a `secretRef` pointing at an OS-keychain
entry, and OAuth tokens live in a separate store (see [security.md](./security.md)).

## Top level

```jsonc
{
  "version": 2,                 // literal 2 (current schema)
  "providers": [ /* entries */ ]
}
```

A missing or malformed file is treated as **no providers** — local search keeps working
(offline-first). The file is re-read on each reload, so edits take effect without a restart.

**Migration:** a `version: 1` file (the pre-release dual `http`/`mcp` shape) is migrated to v2 on
first load and rewritten in place — `mcp` entries are flattened, `auth.type: "bearer"` becomes
`"header"`, and legacy `kind: "http"` entries become **disabled stubs** (re-add them as MCP
connectors).

## Provider entry

All connectors are MCP. Fields are flat (no nested `http`/`mcp` block):

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Lowercase slug `^[a-z0-9][a-z0-9-]*$`. Also the keychain account and env-var stem for secret injection — keep it stable. |
| `name` | string | yes | Human-readable label shown in the UI and in result sections. |
| `enabled` | boolean | no (default `true`) | Disabled providers are never queried. |
| `transport` | `"stdio"` \| `"http"` | yes | `stdio` spawns a local subprocess; `http` connects to a remote Streamable HTTP MCP server. |
| `command` | string | for `stdio` | Executable to spawn (e.g. `npx`). |
| `args` | string[] | no | Arguments for the command. |
| `env` | object | no | Extra environment for the subprocess (where stdio servers read their API keys). |
| `url` | string (URL) | for `http` | Streamable HTTP endpoint of the remote MCP server. |
| `auth` | object | no | Remote auth (below). Ignored for stdio. |
| `mode` | `"tool"` \| `"resources"` | no (default `tool`) | How CogniStore extracts results. |
| `toolName` | string | for `mode:"tool"` | The MCP tool to call (e.g. `search`). |
| `argMapping` | object | no | Maps CogniStore's `query`/`k` to the tool's arg names. Default `{ "query": "query", "k": "limit" }`. |
| `resultPath` | string | no | Dot-path to the results array inside the tool output (when not the default shape). |

### `auth` (remote only)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` | `"none"` \| `"header"` \| `"oauth"` | no (default `none`) | Auth scheme for a remote MCP server. |
| `headerName` | string | no (default `authorization`) | For `header`: which header carries the secret. |
| `secretRef` | string | for `header` | Keychain reference (typically the provider `id`). |
| `scopes` | string[] | no | For `oauth`: requested scopes. |
| `clientId` | string | no | For `oauth`: static client id when the server doesn't support Dynamic Client Registration. |
| `allowInsecure` | boolean | no (default `false`) | Permit `http://`/loopback/private remote URLs (SSRF guard off). Local dev only. |

- **stdio** servers don't use `auth` — pass their credential via `env` (e.g. `{ "NOTION_TOKEN": "…" }`),
  stored in the keychain and injected at spawn.
- **`header`** sends a static `Authorization` (or custom) header; the value comes from the keychain.
- **`oauth`** runs the OAuth 2.1 + PKCE browser flow on **Connect**; tokens are persisted and refreshed
  automatically. See [security.md](./security.md).

See [plug-mcp.md](./plug-mcp.md) for how `mode`/`argMapping`/`resultPath` map a server's output to
result sections.

## Enabling external search

External providers are **opt-in**. Local search is unchanged unless:

- **Per query** — the caller passes `includeExternal: true` (or a `providers: [...]` allow-list). On the
  MCP `getKnowledge` tool these are optional inputs; the dashboard search passes `includeExternal: true`.
- **Globally** — the `alwaysSearchExternalProviders` setting in `~/.cognistore/settings.json`
  (default `false`, toggle in **Settings → External Knowledge Providers**).

Results are always returned **sectioned by source** — a local section plus one per provider — never
merged or cross-ranked.

## Annotated example

```jsonc
{
  "version": 2,
  "providers": [
    {
      "id": "docs-mcp",                 // local stdio server
      "name": "Docs MCP",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@acme/docs-mcp"],
      "env": { "DOCS_API_KEY": "…" },   // value actually comes from the keychain
      "mode": "tool",
      "toolName": "search",
      "argMapping": { "query": "query", "k": "limit" }
    },
    {
      "id": "company-kb",               // remote, OAuth 2.1
      "name": "Company KB",
      "enabled": true,
      "transport": "http",
      "url": "https://kb.internal/mcp",
      "auth": { "type": "oauth", "scopes": ["read"] },
      "mode": "tool",
      "toolName": "search"
    }
  ]
}
```
