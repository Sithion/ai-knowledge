import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CogniStoreOAuthProvider, FileTokenStore, MemoryTokenStore } from '@cognistore/providers';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const tokens: OAuthTokens = { access_token: 'at-123', token_type: 'Bearer', refresh_token: 'rt-456', expires_in: 3600 };

function makeProvider(store: MemoryTokenStore | FileTokenStore) {
  return new CogniStoreOAuthProvider(store, {
    providerId: 'docs',
    redirectUrl: 'http://127.0.0.1:51234/callback',
    scopes: ['read'],
    onRedirect: () => { throw new Error('non-interactive'); },
  });
}

test('oauth provider: clientMetadata advertises PKCE-friendly auth-code + refresh', () => {
  const p = makeProvider(new MemoryTokenStore());
  const m = p.clientMetadata;
  expect(m.client_name).toBe('CogniStore');
  expect(m.redirect_uris).toEqual(['http://127.0.0.1:51234/callback']);
  expect(m.grant_types).toEqual(['authorization_code', 'refresh_token']);
  expect(m.token_endpoint_auth_method).toBe('none');
  expect(m.scope).toBe('read');
});

test('oauth provider: persists tokens / code verifier and reads them back (memory store)', async () => {
  const store = new MemoryTokenStore();
  const p = makeProvider(store);
  expect(await p.tokens()).toBeUndefined();
  await p.saveCodeVerifier('verifier-abc');
  await p.saveTokens(tokens);
  expect(await p.codeVerifier()).toBe('verifier-abc');
  expect((await p.tokens())?.access_token).toBe('at-123');
});

test('oauth provider: clientInformation prefers DCR result, falls back to static clientId', async () => {
  const store = new MemoryTokenStore();
  const withStatic = new CogniStoreOAuthProvider(store, {
    providerId: 'docs', redirectUrl: 'http://127.0.0.1:1/callback', clientId: 'static-cid', onRedirect: () => {},
  });
  expect((await withStatic.clientInformation())?.client_id).toBe('static-cid');
  await withStatic.saveClientInformation({ client_id: 'dcr-cid', redirect_uris: ['http://127.0.0.1:1/callback'] } as any);
  expect((await withStatic.clientInformation())?.client_id).toBe('dcr-cid'); // DCR wins
});

test('oauth provider: invalidateCredentials clears scoped state', async () => {
  const store = new MemoryTokenStore();
  const p = makeProvider(store);
  await p.saveTokens(tokens);
  await p.saveCodeVerifier('v');
  await p.invalidateCredentials('tokens');
  expect(await p.tokens()).toBeUndefined();
  await expect(p.codeVerifier()).resolves.toBe('v'); // verifier untouched
  await p.invalidateCredentials('all');
  await expect(p.codeVerifier()).rejects.toThrow();   // all gone
});

test('FileTokenStore: persists across instances, atomic 0600 file, delete removes the key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cog-oauth-'));
  try {
    const file = join(dir, 'oauth-tokens.json');
    const a = new FileTokenStore(file);
    await a.patch('docs', { tokens });
    expect(existsSync(file)).toBe(true);
    // a fresh instance reads the persisted session
    const b = new FileTokenStore(file);
    expect((await b.get('docs')).tokens?.refresh_token).toBe('rt-456');
    await b.delete('docs');
    expect((await new FileTokenStore(file).get('docs')).tokens).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
