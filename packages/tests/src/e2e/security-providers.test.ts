import { test, expect } from '@playwright/test';
import {
  resolveProviderPolicy,
  providerPolicyViolation,
  assertProviderPolicy,
  isLoopbackOrPrivate,
  guardRemoteMcpUrl,
  assertResolvesToPublicHost,
  type ProviderEntry,
} from '@cognistore/providers';

/**
 * External-provider security policy and the SSRF guard.
 *
 * Two capabilities in a provider entry are code-execution and egress primitives:
 * `transport: 'stdio'` (arbitrary local command, reachable by anything that can
 * write providers.json — including a prompt-injected agent holding only Write),
 * and `auth.allowInsecure`, which switches the SSRF guard off entirely.
 */

const httpEntry = (over: Partial<ProviderEntry> = {}): ProviderEntry =>
  ({
    id: 'p', name: 'P', enabled: true, transport: 'http',
    url: 'https://example.com/mcp', mode: 'tool', ...over,
  }) as ProviderEntry;

const stdioEntry = (over: Partial<ProviderEntry> = {}): ProviderEntry =>
  ({
    id: 'p', name: 'P', enabled: true, transport: 'stdio',
    command: 'node', mode: 'tool', ...over,
  }) as ProviderEntry;

// ─── Policy resolution ─────────────────────────────────────────────

test('both capabilities are denied by default', () => {
  const policy = resolveProviderPolicy(null, {});
  expect(policy.allowStdio).toBe(false);
  expect(policy.allowInsecureUrls).toBe(false);
});

test('settings.json is the durable source, env only overrides it', () => {
  const settings = { allowStdioProviders: true, allowInsecureProviderUrls: false };
  expect(resolveProviderPolicy(settings, {}).allowStdio).toBe(true);

  // Env wins in both directions, so a developer can opt in — or back out —
  // for a single run without editing the file.
  expect(resolveProviderPolicy(settings, { COGNISTORE_ALLOW_STDIO_PROVIDERS: '0' }).allowStdio).toBe(false);
  expect(
    resolveProviderPolicy(null, { COGNISTORE_ALLOW_INSECURE_PROVIDER_URLS: '1' }).allowInsecureUrls,
  ).toBe(true);

  // Anything other than an explicit 0/1 is not an opt-in.
  expect(resolveProviderPolicy(null, { COGNISTORE_ALLOW_STDIO_PROVIDERS: 'yes' }).allowStdio).toBe(false);
});

// ─── What the policy refuses ───────────────────────────────────────

test('a stdio provider is refused unless allowed', () => {
  const denied = resolveProviderPolicy(null, {});
  expect(providerPolicyViolation(stdioEntry(), denied)).toMatch(/arbitrary local command/);
  expect(providerPolicyViolation(stdioEntry(), { allowStdio: true, allowInsecureUrls: false })).toBeNull();
});

test('env keys that alter code loading are refused even when stdio is allowed', () => {
  const allowed = { allowStdio: true, allowInsecureUrls: false };
  for (const key of ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'BASH_ENV', 'ld_preload']) {
    const v = providerPolicyViolation(stdioEntry({ env: { [key]: 'x' } }), allowed);
    expect(v, `${key} must be refused`).toMatch(/alter process code loading/);
  }
  // An ordinary env var is fine.
  expect(providerPolicyViolation(stdioEntry({ env: { API_BASE: 'https://x' } }), allowed)).toBeNull();
});

test('allowInsecure is gated too — otherwise hardening the IP matcher is pointless', () => {
  const denied = resolveProviderPolicy(null, {});
  const entry = httpEntry({ auth: { type: 'none', allowInsecure: true } } as Partial<ProviderEntry>);
  expect(providerPolicyViolation(entry, denied)).toMatch(/allowInsecure/);
  expect(() => assertProviderPolicy(entry, denied)).toThrow(/allowInsecure/);
});

// ─── SSRF classification (pure, no I/O) ────────────────────────────

test('private and loopback addresses are refused in every spelling', () => {
  const priv = [
    '127.0.0.1', '127.0.0.2', '127.1.2.3',      // the whole /8, not just .0.1
    '169.254.169.254',                            // cloud metadata
    '0.0.0.0', '[::]', '[::1]',                   // unspecified + v6 loopback
    '2130706433',                                 // decimal 127.0.0.1
    '0x7f000001',                                 // hex
    '0177.0.0.1',                                 // octal
    '10.0.0.5', '192.168.1.1', '172.16.0.1',
    '100.64.0.1',                                 // carrier-grade NAT
    'localhost', 'foo.localhost',
    '[fd00::1]', '[fe80::1]', '[::ffff:127.0.0.1]',
  ];
  for (const h of priv) expect(isLoopbackOrPrivate(h), `${h} must be private`).toBe(true);
});

test('public addresses still pass', () => {
  for (const h of ['example.com', '8.8.8.8', '1.1.1.1', '172.32.0.1', '169.255.0.1', '[2606:4700::1111]']) {
    expect(isLoopbackOrPrivate(h), `${h} must be public`).toBe(false);
  }
});

test('guardRemoteMcpUrl requires https and a public host', () => {
  expect(() => guardRemoteMcpUrl('http://example.com/mcp')).toThrow(/non-https/);
  expect(() => guardRemoteMcpUrl('https://169.254.169.254/latest/meta-data')).toThrow(/loopback\/private/);
  expect(guardRemoteMcpUrl('https://example.com/mcp').hostname).toBe('example.com');
});

// ─── Post-resolution check (DNS rebinding) ─────────────────────────

test('a public name that RESOLVES into private space is refused', async () => {
  // The name-level check cannot see this: evil.example.com is a perfectly public
  // name. Resolver injected so the case is deterministic and needs no live DNS.
  const lookup = async () => [{ address: '169.254.169.254' }];
  await expect(assertResolvesToPublicHost('evil.example.com', false, lookup)).rejects.toThrow(
    /resolves to the private address 169\.254\.169\.254/,
  );

  const publicLookup = async () => [{ address: '93.184.216.34' }];
  await expect(assertResolvesToPublicHost('example.com', false, publicLookup)).resolves.toBeUndefined();
});

test('resolution failure is not treated as a policy decision', async () => {
  const failing = async () => { throw new Error('ENOTFOUND'); };
  await expect(assertResolvesToPublicHost('nope.invalid', false, failing)).resolves.toBeUndefined();
});
