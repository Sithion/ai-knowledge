/**
 * SSRF / egress guard for remote MCP (Streamable HTTP) provider URLs.
 * Relocated from the (now removed) HTTP provider. A remote MCP `url` must be
 * https and point at a public host unless the provider opts into `allowInsecure`
 * (dev/test — e.g. a local MCP server on 127.0.0.1).
 */

function isLoopbackOrPrivate(hostname: string): boolean {
  // URL.hostname wraps IPv6 in brackets — strip them before matching.
  const h = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();

  // IPv4 loopback / private
  if (h === 'localhost' || h === '127.0.0.1') return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;

  // IPv6 loopback (full and compressed forms)
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;

  // IPv4-mapped IPv6: ::ffff:<ipv4> — Node normalises to hex (e.g. ::ffff:7f00:1)
  if (h.startsWith('::ffff:')) {
    const mapped = h.slice(7);
    if (
      /^7f/.test(mapped) ||                  // 127.x.x.x
      /^a[0-9a-f]{2}:/.test(mapped) ||       // 10.x.x.x  (0x0a00–0x0aff)
      /^c0a8:/.test(mapped) ||               // 192.168.x.x
      /^ac1[0-9a-f]:/.test(mapped)           // 172.16–31.x.x (0xac10–0xac1f)
    ) return true;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd]/i.test(h)) return true;
  if (/^fe[89ab]/i.test(h)) return true;

  return false;
}

/**
 * Validate a remote MCP URL. Throws when it's non-https or targets a
 * loopback/private host and `allowInsecure` is not set. Returns the parsed URL.
 */
export function guardRemoteMcpUrl(rawUrl: string, allowInsecure = false): URL {
  const u = new URL(rawUrl);
  if (!allowInsecure) {
    if (u.protocol !== 'https:') throw new Error(`refusing non-https MCP provider URL (${u.protocol})`);
    if (isLoopbackOrPrivate(u.hostname)) throw new Error(`refusing loopback/private MCP provider host (${u.hostname})`);
  }
  return u;
}

export { isLoopbackOrPrivate };
