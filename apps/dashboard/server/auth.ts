/**
 * Sidecar authorization.
 *
 * The sidecar binds to 127.0.0.1, which used to be treated as sufficient: 76
 * routes, of which only 7 carried an Origin check, and a `SIDECAR_TOKEN` that
 * was generated, handed out by `GET /api/health`, and never actually required.
 * Loopback is not a trust boundary — any other local process, and any page
 * served by any other local HTTP server, sits inside it. `POST /api/uninstall`
 * took no body, so a body-less `fetch(..., {mode:'no-cors'})` from an ordinary
 * web page was a CORS-simple request that ran the whole teardown.
 *
 * So: deny by default, with an explicit allow-list of the few routes that must
 * answer unauthenticated.
 *
 * Three independent checks, cheapest first:
 *   1. Origin  — when present, must be exactly this server's origin (or tauri:).
 *   2. Host    — must be this server's host:port, which defeats DNS rebinding.
 *   3. Token   — `x-cognistore-token` must equal SIDECAR_TOKEN.
 *
 * A missing `Origin` (non-browser callers: curl, the Tauri shell, tests) is only
 * accepted when the token is present, which is what closes the drive-by hole:
 * a browser cannot set this header cross-origin without a preflight, and the
 * preflight fails the Origin check.
 *
 * Everything here is exported as a pure predicate so it can be tested directly
 * rather than inferred through the route table.
 */

/** Routes reachable without a token. Deliberately tiny, and matched exactly. */
export const PUBLIC_PATHS = new Set<string>([
  // The Tauri shell polls this before it knows anything else about the process
  // it just spawned. It answers 200 only WITH a valid token (see isPublicPath's
  // caller in index.ts) — unauthenticated callers get a bare liveness 200 that
  // carries no data, and never the token itself.
  '/api/health',
]);

export interface AuthConfig {
  /** Shared secret; empty disables enforcement (dev only — see `dev`). */
  token: string;
  /** Port this server listens on, used to pin Origin and Host. */
  port: number;
  /**
   * Explicit development opt-in (COGNISTORE_DEV=1). Gated on a POSITIVE signal
   * on purpose: `NODE_ENV !== 'production'` would fail OPEN for any sidecar
   * started without that variable set.
   */
  dev: boolean;
}

/**
 * Static assets and the SPA fallback. These are same-origin document/asset
 * loads: the webview fetches them before any script has run, so it cannot
 * attach a header to them.
 *
 * Note this grants no data access — the SPA shell is inert HTML/JS, and the
 * token is NOT injected into it (the Tauri shell delivers it out of band via
 * `initialization_script`). A localhost page that fetches `/` therefore learns
 * nothing it can use.
 */
export function isStaticPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/index.html') return true;
  if (pathname.startsWith('/assets/')) return true;
  if (pathname.startsWith('/widgets/')) return true;
  return /\.(js|css|map|png|jpg|jpeg|svg|ico|webp|woff2?|ttf)$/i.test(pathname);
}

/** Exact-match, allow-listed API paths. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/**
 * The origins allowed to talk to this server. NOT "any localhost": the previous
 * check accepted any port, so a dev server, a notebook, or another Electron app
 * on the same machine qualified.
 */
export function allowedOrigins(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  if (origin === 'tauri://localhost' || origin.startsWith('tauri:')) return true;
  return allowedOrigins(port).includes(origin);
}

/**
 * Host pinning. Without it, an attacker-controlled DNS name resolving to
 * 127.0.0.1 reaches this server with an Origin the browser considers same-site.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return (
    host === `localhost:${port}` ||
    host === `127.0.0.1:${port}` ||
    host === `[::1]:${port}`
  );
}

/** Constant-time-ish comparison. Tokens are same-length hex, so length differing is itself a mismatch. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!expected) return false;
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export type AuthVerdict =
  | { ok: true }
  | { ok: false; code: 403; reason: string };

/**
 * The whole decision, as a pure function of the request's three headers and the
 * path. `index.ts` only translates the verdict into a reply.
 */
export function authorize(
  input: { method: string; pathname: string; origin?: string; host?: string; token?: string },
  cfg: AuthConfig,
): AuthVerdict {
  const { pathname, origin, host, token } = input;

  // Static assets and the SPA shell: no data, no token.
  if (isStaticPath(pathname)) return { ok: true };

  // Host is checked even for allow-listed API paths — rebinding must not reach
  // anything, including liveness.
  if (!isAllowedHost(host, cfg.port)) {
    return { ok: false, code: 403, reason: 'Forbidden' };
  }

  // A present Origin must be ours, whatever the path.
  if (origin !== undefined && !isAllowedOrigin(origin, cfg.port)) {
    return { ok: false, code: 403, reason: 'Forbidden' };
  }

  if (isPublicPath(pathname)) return { ok: true };

  // Dev mode: Vite serves the SPA from another port, so the browser's Origin can
  // never match. Requires the explicit opt-in AND no token configured.
  if (cfg.dev && !cfg.token) return { ok: true };

  if (!tokenMatches(token, cfg.token)) {
    return { ok: false, code: 403, reason: 'Forbidden' };
  }

  return { ok: true };
}

export const TOKEN_HEADER = 'x-cognistore-token';

/**
 * Register the deny-by-default hook. Note this runs on EVERY request, including
 * ones that match no route — a path-prefix test like `startsWith('/api/')` would
 * be allow-by-default and is defeated by `//api/x`, case and trailing-dot forms.
 */
export function registerAuth(app: any, cfg: AuthConfig): void {
  app.addHook('onRequest', async (request: any, reply: any) => {
    // request.url carries the query string; only the path participates.
    const pathname = (request.url || '/').split('?')[0];
    const verdict = authorize(
      {
        method: request.method,
        pathname,
        origin: request.headers?.origin,
        host: request.headers?.host,
        token: request.headers?.[TOKEN_HEADER],
      },
      cfg,
    );
    if (!verdict.ok) {
      reply.code(verdict.code);
      return reply.send({ error: verdict.reason });
    }
  });
}
