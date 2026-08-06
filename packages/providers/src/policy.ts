import type { ProviderEntry } from './config.js';

/**
 * Provider security policy.
 *
 * Two things in a provider entry are, by design, code execution and network
 * egress primitives:
 *
 *  - `transport: 'stdio'` carries `command`, `args` and `env`, handed straight to
 *    StdioClientTransport. Anything that can write `providers.json` — including a
 *    prompt-injected agent holding only Write, no Bash — gets arbitrary process
 *    execution as the user on the next federated search.
 *  - `auth.allowInsecure` disables the SSRF guard ENTIRELY, both the https
 *    requirement and the private-host check. Without gating it, hardening the
 *    IP matcher is pointless: an attacker just sets the flag.
 *
 * Both are legitimate for local development, so they are gated rather than
 * removed.
 *
 * WHY THIS IS NOT IN THE ZOD SCHEMA, which is where it looks like it belongs:
 *
 *  1. `providersConfigSchema` is a pure, directly-asserted schema. Making its
 *     parse result depend on ambient state means the same file parses
 *     differently in two processes.
 *  2. `migrateProvidersConfig` parses the WHOLE file and `loadProviders` catches
 *     into an empty manager ("offline-first: never let bad config break local
 *     search"). A schema-level rejection would therefore let ONE gated entry
 *     silently disable every other provider — the offline-first invariant turned
 *     against the user.
 *  3. Policy resolved from env alone differs per process by construction: the
 *     sidecar's env comes from the Tauri shell, the MCP server's from whatever
 *     spawned it. The two would disagree about which providers exist. A security
 *     posture is a property of the INSTALLATION, not of a process — so the
 *     durable source is `settings.json`, with env as an override.
 *
 * So the schema stays structural, and this is applied per entry at exactly two
 * call sites: `loadProviders` (drop + warn) and the HTTP write routes (403).
 */
export interface ProviderPolicy {
  /** Allow `transport: 'stdio'` — arbitrary local command execution. */
  allowStdio: boolean;
  /** Allow `auth.allowInsecure` — disables the SSRF/https guard. */
  allowInsecureUrls: boolean;
}

export const DEFAULT_PROVIDER_POLICY: ProviderPolicy = {
  allowStdio: false,
  allowInsecureUrls: false,
};

/**
 * Env keys that change how a process loads code. A provider `env` map is passed
 * verbatim to a spawned process, so these turn "run this command" into "run this
 * command with my code injected into it".
 */
const DANGEROUS_ENV_KEYS = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'NODE_OPTIONS',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'RUBYOPT',
  'BASH_ENV',
  'ENV',
];

/** DYLD_* is the whole macOS family; match by prefix. */
function isDangerousEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  return k.startsWith('DYLD_') || DANGEROUS_ENV_KEYS.includes(k);
}

/**
 * Resolve the policy for this installation.
 *
 * `settings` is the parsed `~/.cognistore/settings.json` (or undefined). Env
 * overrides it so a developer can opt in for one run without editing the file,
 * but the file is what makes the sidecar and the MCP server agree.
 */
export function resolveProviderPolicy(
  settings?: { allowStdioProviders?: boolean; allowInsecureProviderUrls?: boolean } | null,
  env: NodeJS.ProcessEnv = process.env,
): ProviderPolicy {
  const envFlag = (name: string): boolean | undefined =>
    env[name] === '1' ? true : env[name] === '0' ? false : undefined;

  return {
    allowStdio:
      envFlag('COGNISTORE_ALLOW_STDIO_PROVIDERS') ?? settings?.allowStdioProviders ?? DEFAULT_PROVIDER_POLICY.allowStdio,
    allowInsecureUrls:
      envFlag('COGNISTORE_ALLOW_INSECURE_PROVIDER_URLS') ??
      settings?.allowInsecureProviderUrls ??
      DEFAULT_PROVIDER_POLICY.allowInsecureUrls,
  };
}

/**
 * Why this entry is not allowed, or null when it is. A string rather than a
 * throw: `loadProviders` needs to skip one entry and keep the rest.
 */
export function providerPolicyViolation(entry: ProviderEntry, policy: ProviderPolicy): string | null {
  if (entry.transport === 'stdio' && !policy.allowStdio) {
    return 'stdio providers run an arbitrary local command; enable allowStdioProviders in settings.json (or COGNISTORE_ALLOW_STDIO_PROVIDERS=1) to permit it';
  }

  if (entry.env) {
    const bad = Object.keys(entry.env).filter(isDangerousEnvKey);
    if (bad.length) {
      return `env keys that alter process code loading are not allowed: ${bad.join(', ')}`;
    }
  }

  if (entry.auth?.allowInsecure && !policy.allowInsecureUrls) {
    return 'auth.allowInsecure disables the https and private-network guards; enable allowInsecureProviderUrls in settings.json (or COGNISTORE_ALLOW_INSECURE_PROVIDER_URLS=1) to permit it';
  }

  return null;
}

/** Throwing form, for the write path where the caller wants a 403. */
export function assertProviderPolicy(entry: ProviderEntry, policy: ProviderPolicy): void {
  const violation = providerPolicyViolation(entry, policy);
  if (violation) throw new Error(violation);
}
