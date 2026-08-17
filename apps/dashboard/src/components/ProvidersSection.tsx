import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, setProviderSecret, SIDECAR_TOKEN, type ProviderEntry } from '../api/client.js';

const card: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 10,
};
const input: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', backgroundColor: 'var(--bg-input)',
  color: 'var(--text-primary)', fontSize: 12, width: '100%',
};
const btn: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)',
  color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
};

// All providers are MCP connectors now. stdio = local subprocess; remote = Streamable HTTP.
const emptyStdio = (): ProviderEntry => ({ id: '', name: '', enabled: true, transport: 'stdio', mode: 'tool', command: '', toolName: 'search' });
const emptyRemote = (): ProviderEntry => ({ id: '', name: '', enabled: true, transport: 'http', mode: 'tool', url: '', toolName: 'search', auth: { type: 'none' } });

export function ProvidersSection() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [alwaysOn, setAlwaysOn] = useState(false);
  const [draft, setDraft] = useState<ProviderEntry | null>(null);
  const [secret, setSecret] = useState('');
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  // Per-provider in-flight guard (disables that provider's buttons; no double-submit).
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const snapshotRef = useRef<string | null>(null);

  const load = useCallback(() => {
    api.listProviders().then((c) => setProviders(c.providers)).catch(() => setProviders([]));
    api.getSettings().then((s) => setAlwaysOn(!!s.alwaysSearchExternalProviders)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // 5s snapshot-poll for out-of-band provider changes (another window, config
  // edits, MCP). Only updates the LIST + alwaysOn — never touches `draft`,
  // `secret`, or `testResult`, so an open edit form is never clobbered.
  // SECURITY: the /api/providers response may contain stdio `env` secret
  // literals — never log or persist it; only the in-memory ref string is kept.
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const [cfg, settings] = await Promise.all([api.listProviders(), api.getSettings()]);
        const snapshot = cfg.providers.map((p) => `${p.id}:${p.enabled}:${p.name}:${p.transport}`).join('|')
          + `|always:${!!settings.alwaysSearchExternalProviders}`;
        if (snapshotRef.current !== null && snapshot !== snapshotRef.current) {
          setProviders(cfg.providers);
          setAlwaysOn(!!settings.alwaysSearchExternalProviders);
        }
        snapshotRef.current = snapshot;
      } catch { /* ignore polling errors */ }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(id));
    try { await fn(); } finally {
      setBusy((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const toggleAlways = async (v: boolean) => { setAlwaysOn(v); await api.updateSettings({ alwaysSearchExternalProviders: v }).catch(() => {}); };

  const toggleEnabled = (p: ProviderEntry) => withBusy(p.id, async () => {
    try { await api.updateProvider(p.id, { ...p, enabled: !p.enabled }); load(); } catch (e: any) { setError(e?.message ?? 'update failed'); }
  });
  const remove = (id: string) => withBusy(id, async () => {
    try {
      // Keychain first: if providers.json still lists the id, cleanup_provider_secrets
      // will catch it on uninstall even if the keychain delete failed here.
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('delete_provider_secret', { token: SIDECAR_TOKEN, id });
        await invoke('delete_oauth_tokens', { token: SIDECAR_TOKEN, id }); // clear the oauth keychain mirror too
      } catch { /* not Tauri or no secret */ }
      await api.deleteProvider(id);
      load();
    } catch (e: any) { setError(e?.message ?? 'delete failed'); }
  });
  const test = async (id: string) => {
    setTestResult((r) => ({ ...r, [id]: t('providers.testing') }));
    try {
      const res = await api.testProvider(id);
      const label = res.ok ? t('providers.testOk') : (res.needsAuth ? `🔑 ${res.message ?? 'needs auth'}` : `✕ ${res.message ?? ''}`);
      setTestResult((r) => ({ ...r, [id]: label }));
    } catch (e: any) { setTestResult((r) => ({ ...r, [id]: `✕ ${e?.message ?? ''}` })); }
  };
  // Interactive OAuth 2.1: Tauri reserves a loopback port → server builds the
  // authorization URL → Tauri opens the browser and captures the redirect → server
  // exchanges the code for tokens. Requires the desktop app (Tauri invoke).
  const connect = async (id: string) => {
    setTestResult((r) => ({ ...r, [id]: t('providers.connecting') }));
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { port, redirect_uri } = await invoke<{ port: number; redirect_uri: string }>('oauth_reserve');
      const started = await api.oauthStart(id, redirect_uri);
      if (started.alreadyConnected) { setTestResult((r) => ({ ...r, [id]: t('providers.connected') })); return; }
      if (!started.ok || !started.authorizeUrl) throw new Error(started.message ?? 'could not start OAuth');
      const cb = await invoke<{ code?: string; state?: string; error?: string }>('oauth_await', { port, authorizeUrl: started.authorizeUrl });
      if (cb.error || !cb.code) throw new Error(cb.error ?? 'no authorization code returned');
      const fin = await api.oauthFinish(id, cb.code);
      setTestResult((r) => ({ ...r, [id]: fin.ok ? t('providers.connected') : `✕ ${fin.message ?? ''}` }));
    } catch (e: any) {
      setTestResult((r) => ({ ...r, [id]: `✕ ${e?.message ?? String(e)}` }));
    }
  };

  const save = async () => {
    if (!draft) return;
    setError('');
    try {
      // Default secretRef to the provider id for static-header auth.
      const entry: ProviderEntry = draft.transport === 'http' && draft.auth?.type === 'header'
        ? { ...draft, auth: { ...draft.auth, secretRef: draft.auth.secretRef ?? draft.id } }
        : draft;
      const existing = providers.some((p) => p.id === entry.id);
      // Server write first — it's the source of truth. Keychain is best-effort after.
      if (existing) await api.updateProvider(entry.id, entry); else await api.addProvider(entry);
      if (secret && entry.transport === 'http' && entry.auth?.type === 'header') {
        const ref = entry.auth.secretRef ?? entry.id;
        await api.injectProviderSecret(entry.id, secret).catch(() => {});
        try { await setProviderSecret(ref, secret); } catch { /* not Tauri */ }
      }
      setDraft(null); setSecret(''); load();
    } catch (e: any) { setError(e?.message ?? 'save failed'); }
  };

  const isRemote = draft?.transport === 'http';

  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 16 }}>
        {t('providers.section')}
      </h2>

      <label style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
        <span>
          <span style={{ fontWeight: 500 }}>{t('providers.alwaysOn')}</span>
          <br /><span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('providers.alwaysOnHint')}</span>
        </span>
        <input type="checkbox" checked={alwaysOn} onChange={(e) => toggleAlways((e.target as HTMLInputElement).checked)} />
      </label>

      {providers.length === 0 && <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('providers.none')}</p>}
      {providers.map((p) => (
        <div key={p.id} style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>
              <strong>{p.name}</strong>{' '}
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                mcp · {p.transport}{p.transport === 'http' && p.auth?.type === 'oauth' ? ' · oauth' : ''}
              </span>
              {!p.enabled && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}> · {t('providers.disabled')}</span>}
            </span>
            <span style={{ display: 'flex', gap: 6, opacity: busy.has(p.id) ? 0.5 : 1 }}>
              {p.transport === 'http' && p.auth?.type === 'oauth' && (
                <button style={btn} disabled={busy.has(p.id)} onClick={() => connect(p.id)}>{t('providers.connect')}</button>
              )}
              <button style={btn} disabled={busy.has(p.id)} onClick={() => test(p.id)}>{t('providers.test')}</button>
              <button style={btn} disabled={busy.has(p.id)} onClick={() => toggleEnabled(p)}>{p.enabled ? t('providers.disable') : t('providers.enable')}</button>
              <button style={btn} disabled={busy.has(p.id)} onClick={() => { setDraft(JSON.parse(JSON.stringify(p))); setSecret(''); }}>{t('actions.edit')}</button>
              <button style={{ ...btn, color: 'var(--error)' }} disabled={busy.has(p.id)} onClick={() => remove(p.id)}>{t('actions.delete')}</button>
            </span>
          </div>
          {testResult[p.id] && <div style={{ fontSize: 11, marginTop: 6, color: 'var(--text-secondary)' }}>{testResult[p.id]}</div>}
        </div>
      ))}

      {!draft && (
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button style={btn} onClick={() => setDraft(emptyStdio())}>+ {t('providers.addStdio')}</button>
          <button style={btn} onClick={() => setDraft(emptyRemote())}>+ {t('providers.addRemote')}</button>
        </div>
      )}

      {draft && (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={input} placeholder={t('providers.id')} value={draft.id} onChange={(e) => setDraft({ ...draft, id: (e.target as HTMLInputElement).value })} />
            <input style={input} placeholder={t('providers.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })} />
          </div>

          {!isRemote ? (
            <input style={input} placeholder={t('providers.commandPlaceholder')} value={draft.command ?? ''} onChange={(e) => setDraft({ ...draft, command: (e.target as HTMLInputElement).value })} />
          ) : (
            <>
              <input style={input} placeholder={t('providers.urlPlaceholder')} value={draft.url ?? ''} onChange={(e) => setDraft({ ...draft, url: (e.target as HTMLInputElement).value })} />
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  style={input}
                  value={draft.auth?.type ?? 'none'}
                  onChange={(e) => setDraft({ ...draft, auth: { ...(draft.auth ?? { type: 'none' }), type: (e.target as HTMLSelectElement).value as any } })}
                >
                  <option value="none">{t('providers.authNone')}</option>
                  <option value="header">{t('providers.authHeader')}</option>
                  <option value="oauth">OAuth 2.1</option>
                </select>
                {draft.auth?.type === 'header' && (
                  <input style={input} type="password" placeholder={t('providers.secret')} value={secret} onChange={(e) => setSecret((e.target as HTMLInputElement).value)} />
                )}
              </div>
              {draft.auth?.type === 'oauth' && (
                <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0 }}>{t('providers.oauthHint')}</p>
              )}
            </>
          )}

          <input style={input} placeholder={t('providers.toolNamePlaceholder')} value={draft.toolName ?? ''} onChange={(e) => setDraft({ ...draft, toolName: (e.target as HTMLInputElement).value })} />

          {error && <div style={{ fontSize: 11, color: 'var(--error)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={{ ...btn, backgroundColor: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }} onClick={save}>{t('actions.save')}</button>
            <button style={btn} onClick={() => { setDraft(null); setSecret(''); setError(''); }}>{t('actions.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
