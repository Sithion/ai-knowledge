# Plug in an MCP Knowledge Provider

CogniStore can act as an **MCP client** and query an external **MCP server** as a knowledge provider.
This reuses the Model Context Protocol so any compliant MCP server can be a source. Two transports are
supported: **stdio** (spawn a local process) and **Streamable HTTP** (a remote endpoint). SSE is only a
fallback if a Streamable HTTP connection cannot be established.

## Choose a transport

### stdio (local process)

CogniStore spawns the server as a child process and speaks MCP over its stdin/stdout.

- **command** — the executable (e.g. `npx`).
- **args** — arguments (e.g. `-y @acme/docs-mcp`).
- **env** — optional extra environment for the child.

### Streamable HTTP (remote)

CogniStore connects to a hosted MCP server.

- **url** — the Streamable HTTP endpoint (e.g. `https://mcp.example/mcp`).
- **auth** — optional; sent as a header (Bearer or custom), resolved from the OS keychain.

## Choose a result mode

### `mode: "tool"` (default)

CogniStore calls one tool on the server and maps its output to results.

- **toolName** — the tool to call (e.g. `search`).
- **argMapping** — maps CogniStore's `query` and `k` to the tool's argument names. Default
  `{ "query": "query", "k": "limit" }`. Example for a tool expecting `q`/`topK`:
  `{ "query": "q", "k": "topK" }`.
- **resultPath** — optional dot-path to the results array inside the tool's structured output, when
  it isn't the default shape.

How the tool's output becomes results (in order):
1. If the first text content block parses as JSON `{ "results": [...] }`, those are used
   (each item mapped like the [HTTP contract](./http-contract.md) result shape).
2. Otherwise, if `resultPath` is set, the array at that dot-path is used.
3. Otherwise, each text content block becomes one result (`content` = the text).

### `mode: "resources"`

CogniStore lists the server's resources and reads the top matches, mapping each to a result:
`uri → url`, `name → title`, resource text → `content`.

## Add it in the dashboard

1. Open **Settings → External Knowledge Providers**.
2. Click **+ MCP**.
3. Set **id** (lowercase slug) and **Name**.
4. Pick the **transport**:
   - **stdio** → enter the **command** (and edit `args`/`env` in `providers.json` if needed).
   - **http (streamable)** → enter the **url**.
5. Set the **tool name** (for the default `tool` mode).
6. **Save**, then **Test**, then **Enable**.

> For `args`, `env`, `argMapping`, `resultPath`, and `mode: "resources"`, edit the entry directly in
> `~/.cognistore/providers.json` — see [providers-config.md](./providers-config.md). The dashboard form
> covers the common case.

## Behavior & lifecycle

- **Lazy connect.** The client connects on the first search and reuses the connection; concurrent
  searches share one connection.
- **Disposal.** When providers are reloaded or the app shuts down, CogniStore closes the transport —
  for stdio this terminates the child process.
- **Isolation & timeout.** Each provider runs under the per-provider timeout (default 5 s); a failure
  or hang only affects that provider's section, never local results or other providers.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| stdio server never connects | Wrong `command`/`args`, or the binary isn't on `PATH`. Run the command manually first. |
| `tool not found` | `toolName` doesn't match a tool the server advertises. Check the server's tool list. |
| Empty/garbled results | The tool's output shape doesn't match the defaults — set `resultPath`, fix `argMapping`, or switch `mode`. |
| HTTP transport 401 | Missing/wrong `auth`; re-enter the secret and confirm the scheme. |
| Connection drops under load | The server can't keep up within the timeout; increase server capacity. |
