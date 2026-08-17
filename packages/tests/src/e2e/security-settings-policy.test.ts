import { test, expect } from '@playwright/test';
import { sanitizeSettings, SETTINGS_DEFAULTS } from '../../../../apps/dashboard/server/settings.js';

/**
 * The security-relevant settings flags.
 *
 * `settings.json` is a plain file the user — or anything running as them — can
 * edit, and three of its fields now decide whether an arbitrary local command
 * may run (`allowStdioProviders`), whether the SSRF guard applies at all
 * (`allowInsecureProviderUrls`), and whether uninstall may delete a shared
 * dependency (`installedOllama`). Truthiness is not good enough for any of them.
 */

const SECURITY_FLAGS = ['allowStdioProviders', 'allowInsecureProviderUrls', 'installedOllama'] as const;

test('every security flag defaults to false', () => {
  for (const key of SECURITY_FLAGS) {
    expect(SETTINGS_DEFAULTS[key], `${key} must default to off`).toBe(false);
  }
});

test('only a real boolean true opts in — truthy values do not', () => {
  // A hand-edited `"allowStdioProviders": "no"` is a truthy STRING. Under a
  // Boolean() coercion that would enable arbitrary local command execution while
  // reading, to a human, as a refusal. Same for 1, "false", {} and [].
  for (const key of SECURITY_FLAGS) {
    for (const truthy of ['no', 'false', 1, {}, [], 'true']) {
      expect(
        sanitizeSettings({ [key]: truthy } as any)[key],
        `${key}: ${JSON.stringify(truthy)} must not opt in`,
      ).toBe(false);
    }
  }
});

test('a genuine opt-in is honoured', () => {
  for (const key of SECURITY_FLAGS) {
    expect(sanitizeSettings({ [key]: true } as any)[key]).toBe(true);
    expect(sanitizeSettings({ [key]: false } as any)[key]).toBe(false);
  }
});

test('an absent flag is left absent rather than defaulted into the patch', () => {
  // writeSettings merges a patch over the current file; materialising a `false`
  // here would silently clear a flag the caller never mentioned.
  const patch = sanitizeSettings({ cleanupEnabled: true });
  for (const key of SECURITY_FLAGS) {
    expect(key in patch, `${key} must not appear in an unrelated patch`).toBe(false);
  }
});
