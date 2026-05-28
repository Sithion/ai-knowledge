# Building a Local MCP Knowledge Server

This guide walks through writing a minimal **stdio MCP server** in Node.js, registering it as a
CogniStore external provider, and running a federated search that returns results from both your
local CogniStore knowledge base and the custom server — all in under ten minutes.

**What you'll build:** a standalone MCP server that holds 10 in-memory knowledge records and exposes
a keyword `search` tool. Once registered, any `getKnowledge()` call with `includeExternal: true`
will fan-out to it automatically.

---

## Prerequisites

- Node.js ≥ 20
- CogniStore v2.0.0 or later (running)

---

## Step 1 — Create the project

```bash
mkdir ~/my-knowledge-mcp && cd ~/my-knowledge-mcp
npm init -y
npm install @modelcontextprotocol/sdk zod
```

> **Why zod?** The MCP SDK uses zod schemas to declare and validate tool inputs. You'll need it for
> any server that exposes tools.

---

## Step 2 — Write the server

Create `server.js`:

```js
'use strict';

// MCP stdio server — NEVER use console.log(): stdout is the JSON-RPC channel.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

// ── Your knowledge records ────────────────────────────────────────────────────

const RECORDS = [
  {
    id: 'rec-001',
    title: 'TypeScript generics: reusable type-safe functions',
    content:
      'Generics allow you to write functions and classes that work with any type while preserving ' +
      'type safety. Use <T> to parameterize a function: `function identity<T>(x: T): T { return x; }`. ' +
      'Constraints with `extends` narrow allowed types: `<T extends { id: number }>`. Useful for ' +
      'repository patterns, utility types, and API clients.',
    tags: ['typescript', 'generics', 'types'],
  },
  {
    id: 'rec-002',
    title: 'React hooks: useState and useEffect patterns',
    content:
      'useState returns a [value, setter] tuple. useEffect runs after render; return a cleanup ' +
      'function to unsubscribe. Dependency array controls when the effect re-runs: empty array = ' +
      'mount only, [dep] = on dep change, absent = every render. Common mistake: stale closures when ' +
      'deps are missing. Use useCallback to memoize handlers.',
    tags: ['react', 'hooks', 'frontend'],
  },
  {
    id: 'rec-003',
    title: 'SQLite WAL mode: better concurrency for reads',
    content:
      'WAL (Write-Ahead Logging) allows concurrent reads while a write is in progress. Enable with: ' +
      '`PRAGMA journal_mode=WAL`. The WAL file (.db-wal) accumulates writes until a checkpoint ' +
      'merges them back.',
    tags: ['sqlite', 'wal', 'concurrency'],
  },
  // add as many records as you need...
];

// ── Keyword search ────────────────────────────────────────────────────────────

function search(query, limit) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return RECORDS.slice(0, limit).map(toResult);

  const scored = RECORDS
    .map((r) => {
      const haystack = `${r.title} ${r.content} ${r.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (r.title.toLowerCase().includes(term)) score += 2;
        else if (haystack.includes(term)) score += 1;
      }
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ r }) => toResult(r));
}

function toResult(r) {
  return {
    title: r.title,
    content: r.content,
    url: `my-kb://records/${r.id}`,   // any URI scheme you want
    metadata: { tags: r.tags },
  };
}

// ── MCP server ────────────────────────────────────────────────────────────────

async function main() {
  const server = new McpServer({ name: 'my-knowledge-server', version: '1.0.0' });

  server.tool(
    'search',
    'Search the knowledge base.',
    {
      query: z.string().describe('Search query'),
      limit: z.number().int().min(1).max(20).default(5).describe('Max results'),
    },
    async ({ query, limit }) => {
      const results = search(query, limit ?? 5);
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[my-knowledge-server] Ready.');
}

main().catch((e) => {
  console.error('[my-knowledge-server] Fatal:', e);
  process.exit(1);
});
```

### Key rules for stdio MCP servers

| Rule | Why |
|------|-----|
| **Never `console.log()`** | `stdout` is the JSON-RPC channel. Any non-JSON byte corrupts the stream. |
| **Use `console.error()`** for diagnostics | `stderr` is safe — the MCP client ignores it. |
| **Return results as JSON text** | The tool handler returns `{ content: [{ type: 'text', text: JSON.stringify(results) }] }`. CogniStore's default result-mapping reads the first text block and parses it. |
| **Result shape** | Each item in the JSON array should have at minimum `title` and `content`. Optional: `url`, `score`, `metadata`. |

---

## Step 3 — Smoke-test the server

Verify the server starts without errors before registering it:

```bash
node -e "require('./server.js')"
# stderr: [my-knowledge-server] Ready.
# (press Ctrl+C)
```

---

## Step 4 — Register it as a CogniStore provider

### Option A — Dashboard

1. Open **Settings → External Knowledge Providers**.
2. Click **+ stdio**.
3. Fill in:
   - **ID**: `my-kb`
   - **Name**: `My Knowledge Server`
   - **Command**: `node`
   - **Tool name**: `search`
4. For **args**, edit `~/.cognistore/providers.json` directly and add
   `"args": ["/absolute/path/to/server.js"]`.
5. Click **Test**, then **Enable**.

### Option B — Edit `providers.json` directly

```jsonc
// ~/.cognistore/providers.json
{
  "version": 2,
  "providers": [
    {
      "id": "my-kb",
      "name": "My Knowledge Server",
      "enabled": true,
      "transport": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/my-knowledge-mcp/server.js"],
      "mode": "tool",
      "toolName": "search",
      "argMapping": { "query": "query", "k": "limit" }
    }
  ]
}
```

> **Always use absolute paths** in `args` — CogniStore spawns the server from its own working
> directory, not yours.

After saving the file, click **Reload** in the dashboard (or restart the app) for the change to
take effect.

---

## Step 5 — Test the connection

```bash
curl -s -X POST http://localhost:3210/api/providers/my-kb/test
# {"ok":true}
```

---

## Step 6 — Run a federated search

```bash
curl -s -X POST http://localhost:3210/api/knowledge/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "typescript generics", "includeExternal": true}' \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
for ext in data.get('external', []):
    print(ext['providerName'], '—', len(ext['results']), 'results')
    for r in ext['results']:
        print('  •', r['title'])
"
```

Expected output:

```
My Knowledge Server — 1 results
  • TypeScript generics: reusable type-safe functions
```

The `local` section contains your regular CogniStore results; the `external` array has one entry per
enabled provider. They are never merged or cross-ranked.

---

## Using the provider from the MCP tool

In your AI agent session, pass `includeExternal: true`:

```
mcp__cognistore__getKnowledge(
  query: "typescript generics",
  includeExternal: true
)
```

Results arrive as a single JSON response with `results` (local, with similarity scores) and
`external` (per-provider, without cosine scores). The MCP response also includes an `externalNote`
warning reminding the agent that external content is untrusted.

To query only specific providers, use the `providers` array:

```
mcp__cognistore__getKnowledge(
  query: "typescript generics",
  providers: ["my-kb"]
)
```

---

## `argMapping` — adapting non-standard tool signatures

CogniStore passes two arguments to every provider tool: the search query (`query`) and a result
count (`k`). If your tool uses different argument names, declare the mapping:

```jsonc
"argMapping": { "query": "q", "k": "topK" }
```

This maps CogniStore's `query` → `q` and `k` → `topK` before calling the tool.

---

## Tips for production use

### TypeScript

The `@modelcontextprotocol/sdk` ships full TypeScript types. Convert to a TypeScript project by
adding `tsx` or compiling with `tsc`:

```bash
npm install -D typescript tsx @types/node
```

Run with:
```bash
npx tsx server.ts
```

Update `providers.json` to use `npx tsx` as the command:
```jsonc
"command": "npx",
"args": ["tsx", "/absolute/path/to/server.ts"]
```

### Connecting to a real data source

Replace the in-memory `RECORDS` array with any data source — a local SQLite file, a REST API call,
a file system walk. The only contract CogniStore cares about is the tool's JSON output shape:

```ts
interface Result {
  title: string;
  content: string;
  url?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}
```

### Secrets and API keys

If your server needs an API key, store it in the OS keychain via the CogniStore dashboard
(Settings → External Knowledge Providers → edit → secret field), then read it from the environment
in your server:

```js
const apiKey = process.env.COGNISTORE_PROVIDER_SECRET__MY_KB;
```

CogniStore injects `COGNISTORE_PROVIDER_SECRET__<ID_UPPERCASED>` at spawn time. The key never
touches `providers.json` or logs.

### Publishing as an npm package

Once your server is ready to share, publish it to npm. Other users can then add it with just:

```jsonc
{
  "command": "npx",
  "args": ["-y", "your-package-name"]
}
```

---

## Next steps

- [Plug in MCP](./plug-mcp.md) — full transport/auth reference
- [Config Reference](./providers-config.md) — all `providers.json` fields
- [Security Model](./security.md) — keychain storage, OAuth flow, SSRF guard, untrusted content
