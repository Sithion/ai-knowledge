# Plug in an HTTP Knowledge Provider

An **HTTP provider** is any service that implements the [HTTP contract](./http-contract.md)
(`POST {url}/search`). No third-party code runs inside CogniStore, so the provider can be written in
any language. This guide adds one through the dashboard.

## 1. Have an endpoint that speaks the contract

The service must accept `POST {baseUrl}/search` with `{ "query": string, "k": integer }` and return
`{ "results": [ { "title", "content", "url?", "score?", "metadata?" } ] }`. See
[http-contract.md](./http-contract.md) for the full spec and a ~25-line reference mock.

## 2. Add the provider in the dashboard

1. Open **Settings → External Knowledge Providers**.
2. Click **+ HTTP**.
3. Fill in:
   - **id** — a lowercase slug (e.g. `company-wiki`). This is also the keychain account; keep it stable.
   - **Name** — a label (e.g. `Company Wiki`).
   - **URL** — the base URL (e.g. `https://wiki.internal/cogni`). CogniStore appends `/search`.
   - **Auth** — `No auth`, `Bearer`, or `Custom header`.
4. If you chose Bearer or a custom header, enter the **API token / secret**. It is stored in the OS
   keychain (never in `providers.json` or logs). See [security.md](./security.md).
5. **Save**.

## 3. Test the connection

Click **Test** on the provider row. CogniStore sends a `{ "query": "ping", "k": 1 }` request and
reports `✓ Connected` or the error. Testing does not enable the provider.

## 4. Enable it

Use **Enable** on the provider row. From then on, searches that opt into external results
(`includeExternal`, a `providers` allow-list, or the global **Always search external providers**
toggle) will include a section for this provider. Results appear under a provider-named, "external ·
untrusted"-badged section, separate from local results.

## Security defaults

- **HTTPS only.** CogniStore refuses `http://`, loopback, and private/internal hosts by default
  (SSRF guard). For local development you can set `allowInsecure: true` in the provider's `http`
  block in `providers.json`.
- **Per-provider timeout** (default 5 s). A slow or failing provider only affects its own section —
  local results and other providers are unaffected.
- The token is sent as `Authorization: Bearer <token>` or your custom header, resolved from the
  keychain at request time; it never appears in the URL.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `✕ refusing non-https provider URL` | The URL is `http://` or a private/loopback host. Use `https://`, or set `allowInsecure: true` for dev. |
| `✕ HTTP 401` / `403` | Missing/wrong token. Re-enter the secret; confirm the auth type and (for custom header) the header name. |
| `✕ timeout after 5000ms` | The endpoint is too slow. Speed it up or raise `timeoutMs` (max 30000) — but the global per-provider timeout still applies. |
| TLS / certificate error | The endpoint's certificate isn't trusted by the system. Use a valid certificate. |
| Empty section, no error | The endpoint returned `{ "results": [] }`. Verify it actually searches the `query`. |
