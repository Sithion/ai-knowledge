import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, setProviderSecret, type ProviderEntry } from '../api/client.js';

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

const emptyHttp = (): ProviderEntry => ({ id: '', name: '', kind: 'http', enabled: true, http: { url: '', auth: { type: 'none' } } });
const emptyMcp = (): ProviderEntry => ({ id: '', name: '', kind: 'mcp', enabled: true, mcp: { transport: 'stdio', mode: 'tool', command: '', toolName: 'search' } });

export function ProvidersSection() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [alwaysOn, setAlwaysOn] = useState(false);
  const [draft, setDraft] = useState<ProviderEntry | null>(null);
  const [secret, setSecret] = useState('');
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.listProviders().then((c) => setProviders(c.providers)).catch(() => setProviders([]));
    api.getSettings().then((s) => setAlwaysOn(!!s.alwaysSearchExternalProviders)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggleAlways = async (v: boolean) => { setAlwaysOn(v); await api.updateSettings({ alwaysSearchExternalProviders: v }).catch(() => {}); };

  const toggleEnabled = async (p: ProviderEntry) => {
    try { await api.updateProvider(p.id, { ...p, enabled: !p.enabled }); load(); } catch (e: any) { setError(e?.message ?? 'update failed'); }
  };
  const remove = async (id: string) => {
    try {
      await api.deleteProvider(id);
      try { const { invoke } = await import('@tauri-apps/api/core'); await invoke('delete_provider_secret', { id }); } catch { /* not Tauri */ }
      load();
    } catch (e: any) { setError(e?.message ?? 'delete failed'); }
  };
  const test = async (id: string) => {
    setTestResult((r) => ({ ...r, [id]: t('providers.testing') }));
    try { const res = await api.testProvider(id); setTestResult((r) => ({ ...r, [id]: res.ok ? t('providers.testOk') : `✕ ${res.message ?? ''}` })); }
    catch (e: any) { setTestResult((r) => ({ ...r, [id]: `✕ ${e?.message ?? ''}` })); }
  };

  const save = async () => {
    if (!draft) return;
    setError('');
    try {
      const existing = providers.some((p) => p.id === draft.id);
      if (secret && draft[draft.kind]?.auth?.secretRef) await setProviderSecret(draft[draft.kind]!.auth!.secretRef!, secret);
      if (existing) await api.updateProvider(draft.id, draft); else await api.addProvider(draft);
      setDraft(null); setSecret(''); load();
    } catch (e: any) { setError(e?.message ?? 'save failed'); }
  };

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
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{p.kind}</span>
              {!p.enabled && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}> · {t('providers.disabled')}</span>}
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button style={btn} onClick={() => test(p.id)}>{t('providers.test')}</button>
              <button style={btn} onClick={() => toggleEnabled(p)}>{p.enabled ? t('providers.disable') : t('providers.enable')}</button>
              <button style={btn} onClick={() => { setDraft(JSON.parse(JSON.stringify(p))); setSecret(''); }}>{t('actions.edit')}</button>
              <button style={{ ...btn, color: 'var(--error)' }} onClick={() => remove(p.id)}>{t('actions.delete')}</button>
            </span>
          </div>
          {testResult[p.id] && <div style={{ fontSize: 11, marginTop: 6, color: 'var(--text-secondary)' }}>{testResult[p.id]}</div>}
        </div>
      ))}

      {!draft && (
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button style={btn} onClick={() => setDraft(emptyHttp())}>+ HTTP</button>
          <button style={btn} onClick={() => setDraft(emptyMcp())}>+ MCP</button>
        </div>
      )}

      {draft && (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={input} placeholder={t('providers.id')} value={draft.id} onChange={(e) => setDraft({ ...draft, id: (e.target as HTMLInputElement).value })} />
            <input style={input} placeholder={t('providers.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })} />
          </div>
          {draft.kind === 'http' && (
            <>
              <input style={input} placeholder="https://provider.example/api" value={draft.http?.url ?? ''} onChange={(e) => setDraft({ ...draft, http: { ...draft.http!, url: (e.target as HTMLInputElement).value } })} />
              <div style={{ display: 'flex', gap: 8 }}>
                <select style={input} value={draft.http?.auth?.type ?? 'none'} onChange={(e) => setDraft({ ...draft, http: { ...draft.http!, auth: { ...(draft.http?.auth ?? { type: 'none' }), type: (e.target as HTMLSelectElement).value as any, secretRef: draft.id } } })}>
                  <option value="none">{t('providers.authNone')}</option>
                  <option value="bearer">Bearer</option>
                  <option value="header">{t('providers.authHeader')}</option>
                </select>
                {draft.http?.auth?.type !== 'none' && (
                  <input style={input} type="password" placeholder={t('providers.secret')} value={secret} onChange={(e) => setSecret((e.target as HTMLInputElement).value)} />
                )}
              </div>
            </>
          )}
          {draft.kind === 'mcp' && (
            <>
              <select style={input} value={draft.mcp?.transport ?? 'stdio'} onChange={(e) => setDraft({ ...draft, mcp: { ...draft.mcp!, transport: (e.target as HTMLSelectElement).value as any } })}>
                <option value="stdio">stdio</option>
                <option value="http">http (streamable)</option>
              </select>
              {draft.mcp?.transport === 'stdio'
                ? <input style={input} placeholder="command (e.g. npx)" value={draft.mcp?.command ?? ''} onChange={(e) => setDraft({ ...draft, mcp: { ...draft.mcp!, command: (e.target as HTMLInputElement).value } })} />
                : <input style={input} placeholder="https://mcp.example/mcp" value={draft.mcp?.url ?? ''} onChange={(e) => setDraft({ ...draft, mcp: { ...draft.mcp!, url: (e.target as HTMLInputElement).value } })} />}
              <input style={input} placeholder="tool name (e.g. search)" value={draft.mcp?.toolName ?? ''} onChange={(e) => setDraft({ ...draft, mcp: { ...draft.mcp!, toolName: (e.target as HTMLInputElement).value } })} />
            </>
          )}
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
