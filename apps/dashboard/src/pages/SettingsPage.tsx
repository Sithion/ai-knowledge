import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { triggerUpdateCheck, triggerUpdateDownload, onUpdateState, getIsTauri, getLatestReleaseUrl, useAutoUpdateSetting } from '../components/UpdateChecker.js';
import { ConfirmModal } from '../components/ConfirmModal.js';

interface Health {
  database: { connected: boolean; path?: string; error?: string };
  ollama: { connected: boolean; model?: string; host?: string; error?: string };
}

const POLL_INTERVAL = 5000;

const languages = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português (BR)' },
];

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const [health, setHealth] = useState<Health | null>(null);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [uninstallStep, setUninstallStep] = useState(0);
  const [updateState, setUpdateState] = useState<string>('idle');
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [autoUpdate, setAutoUpdate] = useAutoUpdateSetting();
  const [dbSize, setDbSize] = useState<{ sizeFormatted: string; path: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getMetrics()
      .then((m) => { if (!cancelled) setDbSize(m.database); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return onUpdateState((state) => {
      setUpdateState(state);
      if (state === 'upToDate') {
        setCheckResult('upToDate');
        setTimeout(() => setCheckResult(null), 5000);
      } else if (state === 'available') {
        setCheckResult('available');
      } else if (state === 'error') {
        setCheckResult('error');
        setTimeout(() => setCheckResult(null), 5000);
      }
    });
  }, []);

  const fetchHealth = useCallback(() => {
    api.getHealth().then(data => setHealth(data as Health)).catch(console.error);
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  const allHealthy = health?.database.connected && health?.ollama.connected;

  const StatusCard = ({ title, ok, detail }: { title: string; ok: boolean; detail?: string }) => (
    <div style={{
      backgroundColor: 'var(--bg-card)', borderRadius: 10,
      border: `1px solid ${ok ? 'var(--success)' : 'var(--error)'}`,
      padding: 20, flex: 1, minWidth: 200,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 20 }}>{ok ? '🟢' : '🔴'}</span>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{title}</span>
      </div>
      <span style={{ color: ok ? 'var(--success)' : 'var(--error)', fontSize: 13 }}>
        {ok ? t('monitoring.connected') : t('monitoring.disconnected')}
      </span>
      {detail && <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 4 }}>{detail}</p>}
    </div>
  );

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>{t('monitoring.title')}</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 24 }}>{t('monitoring.subtitle')}</p>

      {/* ── Infrastructure Monitoring Section ── */}
      <h2 style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 16 }}>
        {t('monitoring.infraSection')}
      </h2>

      {/* Service Status Cards */}
      {health ? (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
          <StatusCard
            title={t('monitoring.database')}
            ok={health.database.connected}
            detail={health.database.connected ? health.database.path : health.database.error}
          />
          <StatusCard
            title={t('monitoring.ollama')}
            ok={health.ollama.connected}
            detail={health.ollama.connected ? `${health.ollama.model} @ ${health.ollama.host}` : health.ollama.error}
          />
          <div style={{
            backgroundColor: 'var(--bg-card)', borderRadius: 10,
            border: '1px solid var(--border)',
            padding: 20, flex: 1, minWidth: 200,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 20 }}>💾</span>
              <span style={{ fontSize: 16, fontWeight: 600 }}>{t('stats.dbSize')}</span>
            </div>
            <span style={{ color: 'var(--accent)', fontSize: 20, fontWeight: 700 }}>
              {dbSize?.sizeFormatted ?? '—'}
            </span>
            {dbSize?.path && (
              <p style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 4, wordBreak: 'break-all' }}>
                {dbSize.path}
              </p>
            )}
          </div>
        </div>
      ) : (
        <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>{t('stats.loading')}</p>
      )}

      {/* Overall Status */}
      <div style={{
        backgroundColor: 'var(--bg-card)', borderRadius: 10,
        border: `1px solid ${allHealthy ? 'var(--success)' : 'var(--border)'}`,
        padding: 16, marginBottom: 24, textAlign: 'center',
      }}>
        <span style={{ fontSize: 32 }}>{allHealthy ? '✅' : health ? '⚠️' : '⏳'}</span>
        <p style={{ fontSize: 14, fontWeight: 600, marginTop: 8, color: allHealthy ? 'var(--success)' : 'var(--warning)' }}>
          {allHealthy ? t('monitoring.allReady') : health ? t('monitoring.degraded') : t('monitoring.checking')}
        </p>
      </div>

      {/* Action Message */}
      {actionMessage && (
        <div style={{
          backgroundColor: actionMessage.type === 'success' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          border: `1px solid ${actionMessage.type === 'success' ? 'var(--success)' : 'var(--error)'}`,
          borderRadius: 8, padding: 12, marginBottom: 24,
          color: actionMessage.type === 'success' ? 'var(--success)' : 'var(--error)',
          fontSize: 13,
        }}>
          {actionMessage.text}
        </div>
      )}

      {/* ── Updates Section ── */}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 32, paddingTop: 24 }}>
        <h2 style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 16 }}>
          {t('update.section')}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => { setCheckResult(null); triggerUpdateCheck(); }}
            disabled={updateState === 'checking'}
            style={{
              padding: '8px 16px', borderRadius: 6,
              border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)',
              color: 'var(--text-primary)', fontSize: 13, fontWeight: 600,
              cursor: updateState === 'checking' ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            {updateState === 'checking' ? (
              <>
                <span style={{ width: 12, height: 12, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                {t('update.checking')}
              </>
            ) : (
              t('update.check')
            )}
          </button>
          {checkResult === 'upToDate' && <span style={{ fontSize: 13, color: 'var(--success)' }}>{t('update.upToDate')}</span>}
          {checkResult === 'available' && updateState !== 'downloading' && updateState !== 'ready' && (
            getIsTauri() && (window as any).__pendingUpdate ? (
              <button
                onClick={triggerUpdateDownload}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: 'none',
                  backgroundColor: '#8b5cf6', color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {t('update.updateNow')}
              </button>
            ) : (
              <a
                href={getLatestReleaseUrl() || 'https://github.com/Sithion/cognistore/releases/latest'}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: '8px 16px', borderRadius: 6, border: 'none',
                  backgroundColor: '#8b5cf6', color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
                }}
              >
                {t('update.viewRelease')}
              </a>
            )
          )}
          {updateState === 'downloading' && <span style={{ fontSize: 13, color: 'var(--accent)' }}>{t('update.downloading')}</span>}
          {updateState === 'ready' && <span style={{ fontSize: 13, color: 'var(--success)' }}>{t('update.restartToApply')}</span>}
          {checkResult === 'error' && <span style={{ fontSize: 13, color: 'var(--error)' }}>{t('update.checkFailed')}</span>}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: 13, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoUpdate}
            onChange={(e) => { void setAutoUpdate(e.target.checked); }}
            style={{ accentColor: 'var(--accent)' }}
          />
          <span>
            <span style={{ fontWeight: 500 }}>{t('update.autoUpdate')}</span>
            <br />
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('update.autoUpdateHint')}</span>
          </span>
        </label>
      </div>

      {/* ── Language Section ── */}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 32, paddingTop: 24 }}>
        <h2 style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 16 }}>
          {t('settings.language')}
        </h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {languages.map((lang) => (
            <button
              key={lang.code}
              onClick={() => i18n.changeLanguage(lang.code)}
              style={{
                padding: '8px 16px', borderRadius: 6,
                border: i18n.language === lang.code ? '1px solid var(--accent)' : '1px solid var(--border)',
                backgroundColor: i18n.language === lang.code ? 'var(--accent)' : 'var(--bg-card)',
                color: i18n.language === lang.code ? '#fff' : 'var(--text-primary)',
                cursor: 'pointer', fontSize: 13, fontWeight: 500,
              }}
            >
              {lang.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Maintenance Section ── */}
      <MaintenanceSection />

      {/* ── Data Management Section ── */}
      <DataManagementSection />

      {/* ── Log Viewer ── */}
      <LogSection />

      {/* ── Uninstall Section ── */}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 32, paddingTop: 24 }}>
      <h2 style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--error)', marginBottom: 16 }}>
        {t('settings.dangerZone')}
      </h2>

      <div style={{
        backgroundColor: 'var(--bg-card)', borderRadius: 10,
        border: '1px solid var(--error)', padding: 20,
        opacity: 0.8,
      }}>
        {uninstallStep === 3 ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.uninstallingMsg')}</p>
        ) : (
          <>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
              {t('settings.uninstallDesc')}
            </p>
            <button
              onClick={() => setUninstallStep(1)}
              style={{
                padding: '10px 20px', borderRadius: 8,
                border: '1px solid var(--error)', backgroundColor: 'transparent',
                color: 'var(--error)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              {t('settings.uninstallBtn')}
            </button>
          </>
        )}
      </div>

      {/* Uninstall Step 1 — first confirmation modal */}
      <ConfirmModal
        isOpen={uninstallStep === 1}
        onClose={() => setUninstallStep(0)}
        onConfirm={() => setUninstallStep(2)}
        title={t('settings.uninstallBtn')}
        message={t('settings.uninstallConfirm1')}
        confirmLabel={t('settings.yesContinue')}
      />

      {/* Uninstall Step 2 — final confirmation modal */}
      <ConfirmModal
        isOpen={uninstallStep === 2}
        onClose={() => setUninstallStep(0)}
        onConfirm={async () => {
          setUninstallStep(3);
          setActionMessage({ type: 'success', text: t('settings.uninstallingMsg') });
          try {
            // Delete provider secrets from the OS keychain first — they live outside
            // ~/.cognistore, so the directory removal in /api/uninstall won't cover them.
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('cleanup_provider_secrets');
            } catch { /* not running in Tauri, or no secrets — ignore */ }
            await api.uninstallAll();
          } catch {
            // Server shuts down during uninstall — expected
          }
          setTimeout(() => {
            document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;background:#0a0a1a;color:#22c55e;font-family:sans-serif"><h2>Uninstall complete</h2><p style="color:#6b7280">You can close this window.</p></div>';
            try { window.close(); } catch { /* ignore */ }
          }, 2000);
        }}
        title={t('settings.uninstallBtn')}
        message={t('settings.uninstallConfirm2')}
        confirmLabel={t('settings.yesUninstallAll')}
      />
      </div>
    </div>
  );
}

function LogSection() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [total, setTotal] = useState(0);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await api.getLogs(200);
      setLines(res.lines);
      setTotal(res.total);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!expanded) return;
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [expanded, fetchLogs]);

  const handleClear = async () => {
    try {
      await api.clearLogs();
      setLines([]);
      setTotal(0);
    } catch { /* ignore */ }
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 32, paddingTop: 24 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: expanded ? 16 : 0 }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          ▶
        </span>
        <h2 style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', margin: 0 }}>
          {t('settings.logs.title')}
        </h2>
        {total > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', opacity: 0.6 }}>({total} lines)</span>
        )}
      </div>
      {expanded && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button
              onClick={fetchLogs}
              style={{
                padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11,
              }}
            >{t('settings.logs.refresh')}</button>
            <button
              onClick={handleClear}
              style={{
                padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--error)', cursor: 'pointer', fontSize: 11,
              }}
            >{t('settings.logs.clear')}</button>
          </div>
          <div style={{
            backgroundColor: '#0a0a1a',
            borderRadius: 8,
            border: '1px solid var(--border)',
            padding: 12,
            maxHeight: 300,
            overflowY: 'auto',
            fontFamily: 'monospace',
            fontSize: 11,
            lineHeight: 1.6,
            color: '#a5b4fc',
          }}>
            {lines.length === 0 ? (
              <span style={{ color: 'var(--text-secondary)' }}>{t('settings.logs.empty')}</span>
            ) : (
              lines.map((line, i) => (
                <div key={i} style={{
                  color: line.includes('[ERROR]') ? '#ef4444' : line.includes('[WARN]') ? '#f59e0b' : '#a5b4fc',
                }}>{line}</div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MaintenanceSection() {
  const { t } = useTranslation();
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<string | null>(null);
  const [redeploying, setRedeploying] = useState(false);
  const [redeployResult, setRedeployResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleCleanup = async () => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const res = await api.cleanupDatabase();
      setCleanResult(`${res.orphansRemoved} orphan${res.orphansRemoved !== 1 ? 's' : ''} removed${res.sizeAfter ? ` — DB: ${res.sizeAfter}` : ''}`);
    } catch {
      setCleanResult('Cleanup failed');
    }
    setCleaning(false);
  };

  const handleRedeploy = async () => {
    setRedeploying(true);
    setRedeployResult(null);
    try {
      const res = await api.redeploy();
      const failed = res.results.filter((r) => r.status === 'error');
      if (failed.length === 0) {
        setRedeployResult({ type: 'success', text: 'All configurations re-deployed successfully' });
      } else {
        setRedeployResult({ type: 'error', text: `${failed.length} step(s) failed: ${failed.map((f) => f.step).join(', ')}` });
      }
    } catch {
      setRedeployResult({ type: 'error', text: 'Re-deploy failed' });
    }
    setRedeploying(false);
    setTimeout(() => setRedeployResult(null), 5000);
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 32, paddingTop: 24 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <h2 style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 16 }}>
        {t('settings.maintenance')}
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleRedeploy}
            disabled={redeploying}
            title="Re-deploy skills, hooks, instructions, and MCP configs without losing data"
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              backgroundColor: 'var(--bg-card)', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', cursor: redeploying ? 'not-allowed' : 'pointer',
              opacity: redeploying ? 0.6 : 1,
            }}
          >
            {redeploying ? (
              <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid var(--text-secondary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
            ) : (
              <span style={{ fontSize: 14 }}>🔄</span>
            )}
            {t('settings.redeploy')}
          </button>
          {redeployResult && (
            <span style={{ fontSize: 12, color: redeployResult.type === 'success' ? 'var(--success)' : 'var(--error)' }}>
              {redeployResult.text}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleCleanup}
            disabled={cleaning}
            title="Remove unused embeddings"
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              backgroundColor: 'var(--bg-card)', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', cursor: cleaning ? 'not-allowed' : 'pointer',
              opacity: cleaning ? 0.6 : 1,
            }}
          >
            {cleaning ? (
              <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid var(--text-secondary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
            ) : (
              <span style={{ fontSize: 14 }}>🗑</span>
            )}
            {t('settings.removeEmbeddings')}
          </button>
          {cleanResult && (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{cleanResult}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function DataManagementSection() {
  const { t } = useTranslation();
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportKnowledge, setExportKnowledge] = useState(true);
  const [exportPlans, setExportPlans] = useState(true);
  const [exporting, setExporting] = useState(false);

  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<{
    knowledgeCount: number; plansCount: number;
    knowledge?: any[]; plans?: any[];
  } | null>(null);
  const [importKnowledge, setImportKnowledge] = useState(true);
  const [importPlansFlag, setImportPlansFlag] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleExport = async () => {
    setExporting(true);
    try {
      const include: ('knowledge' | 'plans')[] = [];
      if (exportKnowledge) include.push('knowledge');
      if (exportPlans) include.push('plans');
      await api.exportUnified(include);
    } catch (err) {
      console.error('Export failed:', err);
    }
    setExporting(false);
    setShowExportModal(false);
  };

  const handleImportClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const parsed = await api.parseExportFile(file);
        setImportFile(parsed);
        setImportKnowledge(parsed.knowledgeCount > 0);
        setImportPlansFlag(parsed.plansCount > 0);
        setShowImportModal(true);
      } catch {
        setImportResult({ type: 'error', text: t('settings.importParseError') });
        setTimeout(() => setImportResult(null), 5000);
      }
    };
    input.click();
  };

  const handleImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setImportResult(null);
    try {
      const include: string[] = [];
      const body: Record<string, any> = { include };
      if (importKnowledge && importFile.knowledge) {
        include.push('knowledge');
        body.knowledge = importFile.knowledge;
      }
      if (importPlansFlag && importFile.plans) {
        include.push('plans');
        body.plans = importFile.plans;
      }
      const result = await api.importUnified(body as any);
      const parts: string[] = [];
      if (result.knowledge) parts.push(`Knowledge: ${result.knowledge.imported} imported, ${result.knowledge.skipped} skipped`);
      if (result.plans) parts.push(`Plans: ${result.plans.imported} imported, ${result.plans.skipped} skipped`);
      setImportResult({ type: 'success', text: parts.join(' · ') });
    } catch (err) {
      setImportResult({ type: 'error', text: `Import failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    setImporting(false);
    setShowImportModal(false);
    setImportFile(null);
    setTimeout(() => setImportResult(null), 8000);
  };

  const btnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600,
    backgroundColor: 'var(--bg-card)', color: 'var(--text-secondary)',
    border: '1px solid var(--border)', cursor: 'pointer',
  };

  const modalBackdrop: React.CSSProperties = {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  };

  const modalCard: React.CSSProperties = {
    backgroundColor: 'var(--bg-card)', borderRadius: 12, border: '1px solid var(--border)',
    padding: 24, maxWidth: 400, width: '90%',
  };

  const checkboxRow: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', fontSize: 13,
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 32, paddingTop: 24 }}>
      <h2 style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 16 }}>
        {t('settings.dataManagement')}
      </h2>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => { setExportKnowledge(true); setExportPlans(true); setShowExportModal(true); }} style={btnStyle}>
          {t('settings.exportBtn')}
        </button>
        <button onClick={handleImportClick} style={btnStyle}>
          {t('settings.importBtn')}
        </button>
        {importResult && (
          <span style={{ fontSize: 12, color: importResult.type === 'success' ? 'var(--success)' : 'var(--error)' }}>
            {importResult.text}
          </span>
        )}
      </div>

      {/* Export Modal */}
      {showExportModal && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setShowExportModal(false); }} style={modalBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={modalCard}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{t('settings.exportModalTitle')}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>{t('settings.exportModalDesc')}</p>
            <div style={{ marginBottom: 20 }}>
              <label style={checkboxRow}>
                <input type="checkbox" checked={exportKnowledge} onChange={(e) => setExportKnowledge(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                {t('settings.knowledgeEntries')}
              </label>
              <label style={checkboxRow}>
                <input type="checkbox" checked={exportPlans} onChange={(e) => setExportPlans(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                {t('settings.planEntries')}
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowExportModal(false)} style={{ padding: '8px 16px', borderRadius: 6, fontSize: 13, border: '1px solid var(--border)', backgroundColor: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                {t('actions.cancel')}
              </button>
              <button
                onClick={handleExport}
                disabled={exporting || (!exportKnowledge && !exportPlans)}
                style={{
                  padding: '8px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                  border: 'none', backgroundColor: 'var(--accent)', color: '#fff',
                  cursor: (!exportKnowledge && !exportPlans) ? 'not-allowed' : 'pointer',
                  opacity: (!exportKnowledge && !exportPlans) ? 0.5 : 1,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {exporting && <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />}
                {t('settings.exportBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImportModal && importFile && (
        <div onClick={(e) => { if (e.target === e.currentTarget) { setShowImportModal(false); setImportFile(null); } }} style={modalBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={modalCard}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{t('settings.importModalTitle')}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>{t('settings.importModalDesc')}</p>
            <div style={{ marginBottom: 20 }}>
              <label style={{ ...checkboxRow, opacity: importFile.knowledgeCount === 0 ? 0.4 : 1 }}>
                <input type="checkbox" checked={importKnowledge} disabled={importFile.knowledgeCount === 0} onChange={(e) => setImportKnowledge(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                {t('settings.knowledgeEntries')} ({importFile.knowledgeCount})
              </label>
              <label style={{ ...checkboxRow, opacity: importFile.plansCount === 0 ? 0.4 : 1 }}>
                <input type="checkbox" checked={importPlansFlag} disabled={importFile.plansCount === 0} onChange={(e) => setImportPlansFlag(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                {t('settings.planEntries')} ({importFile.plansCount})
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowImportModal(false); setImportFile(null); }} style={{ padding: '8px 16px', borderRadius: 6, fontSize: 13, border: '1px solid var(--border)', backgroundColor: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                {t('actions.cancel')}
              </button>
              <button
                onClick={handleImport}
                disabled={importing || (!importKnowledge && !importPlansFlag)}
                style={{
                  padding: '8px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                  border: 'none', backgroundColor: 'var(--accent)', color: '#fff',
                  cursor: (!importKnowledge && !importPlansFlag) ? 'not-allowed' : 'pointer',
                  opacity: (!importKnowledge && !importPlansFlag) ? 0.5 : 1,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {importing && <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />}
                {t('settings.importBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
