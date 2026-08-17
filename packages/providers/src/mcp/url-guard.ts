/**
 * SSRF / egress guard for remote MCP (Streamable HTTP) provider URLs.
 *
 * A remote MCP `url` must be https and point at a public host unless the
 * provider opts into `allowInsecure` — which is itself gated by the installation
 * policy (see policy.ts), because that flag switches this entire module off.
 *
 * The classification below is deliberately split from the DNS-touching check:
 * `isLoopbackOrPrivate` is pure string/IP logic, exhaustively testable with no
 * I/O, and is where every future CIDR lands.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Normalise the many spellings of an IPv4 address that a URL parser accepts:
 * decimal (2130706433), octal (0177.0.0.1) and hex (0x7f000001) all reach
 * 127.0.0.1 but match none of the dotted-quad patterns below.
 */
function canonicalizeIpv4(host: string): string | null {
  const fromInt = (n: number): string | null =>
    Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
      ? [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
      : null;

  // Single-token forms, with no dots at all: decimal (2130706433),
  // hex (0x7f000001) and octal (017700000001) all reach 127.0.0.1.
  if (/^\d+$/.test(host)) return fromInt(Number(host));
  if (/^0[xX][0-9a-fA-F]+$/.test(host)) return fromInt(parseInt(host, 16));
  if (/^0[0-7]+$/.test(host)) return fromInt(parseInt(host, 8));
  // Dotted, with octal or hex parts.
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => {
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) return parseInt(p, 16);
    if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
    if (/^\d+$/.test(p)) return Number(p);
    return NaN;
  });
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums.join('.');
}

export function isLoopbackOrPrivate(hostname: string): boolean {
  // URL.hostname wraps IPv6 in brackets — strip them before matching.
  let h = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();

  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  // Unspecified addresses route to the local host.
  if (h === '0.0.0.0' || h === '::' || h === '0:0:0:0:0:0:0:0') return true;

  // Fold alternative IPv4 spellings into dotted-quad before matching.
  const canonical = canonicalizeIpv4(h);
  if (canonical) h = canonical;

  // IPv4 loopback is the whole /8, not just 127.0.0.1.
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  // Link-local — this is where the cloud metadata endpoint lives (169.254.169.254).
  if (/^169\.254\./.test(h)) return true;
  // Carrier-grade NAT (100.64.0.0/10).
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;

  // IPv6 loopback (full and compressed forms)
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;

  // IPv4-mapped IPv6: ::ffff:<ipv4>, in both dotted and hex normalisations.
  if (h.startsWith('::ffff:')) {
    const mapped = h.slice(7);
    const dotted = canonicalizeIpv4(mapped);
    if (dotted) return isLoopbackOrPrivate(dotted);
    if (
      /^7f/.test(mapped) ||                  // 127.x.x.x
      /^a[0-9a-f]{2}:/.test(mapped) ||       // 10.x.x.x  (0x0a00–0x0aff)
      /^c0a8:/.test(mapped) ||               // 192.168.x.x
      /^ac1[0-9a-f]:/.test(mapped) ||        // 172.16–31.x.x (0xac10–0xac1f)
      /^a9fe:/.test(mapped)                  // 169.254.x.x
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
 *
 * NOTE: this is the NAME-level check only. A public hostname can still resolve
 * to an internal address, so a caller about to make a request should also use
 * `assertResolvesToPublicHost`.
 */
export function guardRemoteMcpUrl(rawUrl: string, allowInsecure = false): URL {
  const u = new URL(rawUrl);
  if (!allowInsecure) {
    if (u.protocol !== 'https:') throw new Error(`refusing non-https MCP provider URL (${u.protocol})`);
    if (isLoopbackOrPrivate(u.hostname)) throw new Error(`refusing loopback/private MCP provider host (${u.hostname})`);
  }
  return u;
}

export type LookupFn = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true });

/**
 * Post-resolution check: refuse a hostname that RESOLVES into private space.
 *
 * The name-level check cannot catch this — `evil.example.com` is a public name
 * that may answer 169.254.169.254. The resolver is injectable so the rebinding
 * case is testable without live DNS (CI already treats real DNS as flaky).
 *
 * This narrows the window rather than closing it: between the check and the
 * connection a TTL-0 record can change. Pinning the resolved address into the
 * connection itself is the complete fix and needs a custom agent.
 */
export async function assertResolvesToPublicHost(
  hostname: string,
  allowInsecure = false,
  lookup: LookupFn = defaultLookup,
): Promise<void> {
  if (allowInsecure) return;
  // A literal IP was already judged in full by the name-level check.
  if (isIP(hostname) || (hostname.startsWith('[') && hostname.endsWith(']'))) return;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    // A resolution failure is the request's problem, not a policy decision.
    return;
  }
  const offending = addresses.find((a) => isLoopbackOrPrivate(a.address));
  if (offending) {
    throw new Error(
      `refusing MCP provider host ${hostname}: it resolves to the private address ${offending.address}`,
    );
  }
}
