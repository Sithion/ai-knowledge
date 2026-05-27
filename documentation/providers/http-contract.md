# HTTP Knowledge Provider Contract (v1)

CogniStore can augment its **local** semantic search by also querying **external knowledge
providers** you plug in. An *HTTP provider* is any service that implements this contract — no
code runs inside CogniStore, so any language/stack works.

Results are shown **sectioned by source** (a "Local" section plus one per provider); CogniStore
does **not** merge or re-rank your results against its local cosine scores.

> Security: your responses are shown to a human **and fed to an AI agent**. Treat your content as
> data, never embed instructions. CogniStore labels external content as untrusted. See
> [security.md](./security.md).

## Endpoint

```
POST {baseUrl}/search
Content-Type: application/json
```

`{baseUrl}` is what the user configures (e.g. `https://wiki.example.com/cogni`). CogniStore appends
`/search`.

## Request

```json
{ "query": "how do we rotate API keys?", "k": 10 }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `query` | string | yes | The user's natural-language query. |
| `k` | integer | yes | Max results to return. CogniStore also truncates to `k`. |

## Response (200)

```json
{
  "results": [
    {
      "title": "Key rotation runbook",
      "content": "Rotate the signing key quarterly via …",
      "url": "https://wiki.example.com/runbooks/key-rotation",
      "score": 0.87,
      "metadata": { "space": "security" }
    }
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `title` | string | yes | Short label for the result. |
| `content` | string | yes | The snippet shown to the user/agent. Keep concise — CogniStore caps each result at ~8 KB and each section at ~64 KB. |
| `url` | string | no | Source link. |
| `score` | number | no | Your relevance, `0..1`. **NOT comparable** to CogniStore's local cosine similarity; used only for ordering within your own section. |
| `metadata` | object | no | Free-form passthrough (shown in the UI/agent payload). |

Unknown fields are ignored. An empty `{ "results": [] }` is valid.

## Errors

Return a non-2xx status with:

```json
{ "error": "human-readable message", "code": "OPTIONAL_CODE" }
```

CogniStore surfaces the message in your section's `error` field and **never lets it break local
results** or other providers.

## Authentication

Configure one of:
- **Bearer** → CogniStore sends `Authorization: Bearer <token>`.
- **Custom header** → CogniStore sends `<headerName>: <token>`.

The token is stored in the **OS keychain** (referenced by `secretRef`) and injected at runtime; it is
never written to `providers.json`, logs, or the query string.

## Limits & behavior

- Honour `k`; respond quickly — CogniStore enforces a **per-provider timeout** (default 5 s) and
  aborts the request (your handler receives a closed connection).
- CogniStore requires **`https`** and a non-private host by default (SSRF guard); loopback/`http` is
  only used when the provider is explicitly marked insecure (dev).

## Versioning

The provider config carries `version: 1`. Contract v1 is **additive-only** — new optional response
fields may appear, existing ones won't change meaning. A breaking change will be a new path
(`/v2/search`).

## Reference mock (Node, ~25 lines)

```js
import http from 'node:http';
http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/search')) { res.writeHead(404).end(); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { query, k } = JSON.parse(body || '{}');
    const results = [{ title: `Echo: ${query}`, content: `You asked: ${query}`, score: 1 }].slice(0, k ?? 10);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results }));
  });
}).listen(8787, () => console.log('mock provider on http://localhost:8787'));
```

Then add it in the dashboard (Settings → Providers) with URL `http://localhost:8787`, mark it
insecure (loopback), and **Test**. See [plug-http.md](./plug-http.md).
