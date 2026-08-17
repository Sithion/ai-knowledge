import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, SIDECAR_TOKEN, type CleanupCandidate, type CleanupReportResponse } from '../api/client.js';
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

      {/* ── Tag Suggestions Section ── */}
      <TagSuggestionsSection />

      {/* ── Cleanup Report Section ── */}
      <CleanupReportSection />

      {/* ── Knowledge Health Section ── */}
      <KnowledgeHealthSection />

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
              await invoke('cleanup_provider_secrets', { token: SIDECAR_TOKEN });
            } catch { /* not running in Tauri, or no secrets — ignore */ }
            await api.uninstallAll();
          } catch {
            // Server shuts down during uninstall — expected
          }
          setTimeout(() => {
            setUninstallStep(4);
            try { window.close(); } catch { /* ignore */ }
          }, 2000);
        }}
        title={t('settings.uninstallBtn')}
        message={t('settings.uninstallConfirm2')}
        confirmLabel={t('settings.yesUninstallAll')}
      />

      {/* Uninstall Step 4 — done (React state, not an innerHTML body swap) */}
      {uninstallStep === 4 && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 2000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 16, backgroundColor: '#0a0a1a',
        }}>
          <h2 style={{ color: '#22c55e', fontSize: 20, fontWeight: 700 }}>{t('settings.uninstallCompleteTitle')}</h2>
          <p style={{ color: '#6b7280', fontSize: 14 }}>{t('settings.uninstallCompleteHint')}</p>
        </div>
      )}
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
      setCleanResult(
        res.sizeAfter
          ? t('settings.orphansRemovedDb', { count: res.orphansRemoved, size: res.sizeAfter })
          : t('settings.orphansRemoved', { count: res.orphansRemoved })
      );
    } catch {
      setCleanResult(t('settings.cleanupFailed'));
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
        setRedeployResult({ type: 'success', text: t('settings.redeploySuccess') });
      } else {
        setRedeployResult({ type: 'error', text: t('settings.redeployStepsFailed', { count: failed.length, steps: failed.map((f) => f.step).join(', ') }) });
      }
    } catch {
      setRedeployResult({ type: 'error', text: t('settings.redeployFailed') });
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
            title={t('settings.redeployTooltip')}
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
            title={t('settings.removeEmbeddings')}
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

const sectionHeaderStyle = { fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 16 };
const ghostButtonStyle = {
  padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
  backgroundColor: 'var(--bg-card)', color: 'var(--text-secondary)',
  border: '1px solid var(--border)', cursor: 'pointer',
};

type TagSuggestion = { a: string; b: string; similarity: number; countA: number; countB: number };
type TagGroup = { key: string; members: { tag: string; count: number }[]; maxSimilarity: number };

// Cluster overlapping suggestion pairs into GROUPS (union-find). With raw pairs,
// "select all" was unusable: one tag appearing in several pairs got contradictory
// default keepers ("'x' cannot be merged in two directions") with no practical way
// to fix 40+ rows by hand. With one keeper per group, every merge is loser→keeper —
// conflicts are impossible by construction (the server CONFLICT guard stays as a
// backstop).
function buildTagGroups(suggestions: TagSuggestion[]): TagGroup[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (cur !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const counts = new Map<string, number>();
  for (const s of suggestions) {
    union(s.a, s.b);
    counts.set(s.a, s.countA);
    counts.set(s.b, s.countB);
  }
  const byRoot = new Map<string, Set<string>>();
  for (const tag of counts.keys()) {
    const root = find(tag);
    const set = byRoot.get(root) ?? new Set<string>();
    set.add(tag);
    byRoot.set(root, set);
  }
  const maxSim = new Map<string, number>();
  for (const s of suggestions) {
    const root = find(s.a);
    maxSim.set(root, Math.max(maxSim.get(root) ?? 0, s.similarity));
  }
  return Array.from(byRoot.entries())
    .map(([root, tags]) => {
      const members = Array.from(tags)
        .map((tag) => ({ tag, count: counts.get(tag) ?? 0 }))
        .sort((x, y) => (y.count - x.count) || x.tag.localeCompare(y.tag));
      return { key: members.map((m) => m.tag).join('|'), members, maxSimilarity: maxSim.get(root) ?? 0 };
    })
    .sort((x, y) => (y.members.length - x.members.length) || (y.maxSimilarity - x.maxSimilarity));
}

function TagSuggestionsSection() {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<TagGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [keeper, setKeeper] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Default keeper = the most-used tag of the group (members are pre-sorted).
  const keeperOf = (g: TagGroup) => keeper[g.key] ?? g.members[0]?.tag;

  const load = useCallback(() => {
    setLoading(true);
    api.getTagSuggestions()
      .then((s) => { setGroups(buildTagGroups(s)); setSelected(new Set()); setKeeper({}); })
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggleGroup = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const allSelected = groups.length > 0 && selected.size === groups.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(groups.map((g) => g.key)));
  };

  // Every merge is member→keeper of its own group: each `from` appears exactly
  // once and all of a group's merges share one target — no chains, no conflicts.
  const selectedMerges = groups
    .filter((g) => selected.has(g.key))
    .flatMap((g) => {
      const keep = keeperOf(g);
      return g.members.filter((m) => m.tag !== keep).map((m) => ({ from: m.tag, to: keep }));
    });

  const applyBatch = async () => {
    setApplying(true);
    try {
      // The endpoint accepts at most 50 merges per call — chunk large batches.
      let entries = 0;
      let mergesApplied = 0;
      for (let i = 0; i < selectedMerges.length; i += 50) {
        const res = await api.mergeTagsBatch(selectedMerges.slice(i, i + 50));
        entries += res.entriesReembedded;
        mergesApplied += res.applied.length;
      }
      setMessage(t('tagSuggestions.batchDone', { entries, merges: mergesApplied }));
      setConfirmOpen(false);
      load();
    } catch {
      setMessage(t('tagSuggestions.mergeFailed'));
      setConfirmOpen(false);
    }
    setApplying(false);
    setTimeout(() => setMessage(null), 5000);
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 32, paddingTop: 24 }}>
      <h2 style={sectionHeaderStyle}>{t('tagSuggestions.title')}</h2>
      {loading ? (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('tagSuggestions.loading')}</p>
      ) : groups.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('tagSuggestions.none')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {message && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{message}</span>}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={applying} />
            {t('tagSuggestions.selectAll')}
          </label>
          {groups.map((g) => {
            const isSelected = selected.has(g.key);
            const keep = keeperOf(g);
            return (
              <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', opacity: applying ? 0.6 : 1 }}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleGroup(g.key)}
                  disabled={applying}
                  style={{ cursor: 'pointer' }}
                />
                <span style={{ fontSize: 13 }}>
                  {g.members.map((m, i) => (
                    <span key={m.tag}>
                      {i > 0 && <span style={{ color: 'var(--text-secondary)' }}> ↔ </span>}
                      <strong style={isSelected && keep === m.tag ? { color: 'var(--accent)' } : undefined}>{m.tag}</strong>
                    </span>
                  ))}
                  <span style={{ color: 'var(--text-secondary)', marginLeft: 8 }}>{Math.round(g.maxSimilarity * 100)}%</span>
                </span>
                {isSelected && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{t('tagSuggestions.keepLabel')}</span>
                    <select
                      value={keep}
                      disabled={applying}
                      onChange={(e) => setKeeper((prev) => ({ ...prev, [g.key]: (e.target as HTMLSelectElement).value }))}
                      style={{
                        padding: '4px 8px', borderRadius: 6, fontSize: 12,
                        backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {g.members.map((m) => (
                        <option key={m.tag} value={m.tag}>
                          {m.tag} · {t('tagSuggestions.uses', { count: m.count })}
                        </option>
                      ))}
                    </select>
                  </span>
                )}
              </div>
            );
          })}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {t('tagSuggestions.selectedCount', { count: selected.size })}
            </span>
            <button
              style={{ ...ghostButtonStyle, ...(selectedMerges.length > 0 ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}
              disabled={selectedMerges.length === 0 || applying}
              onClick={() => setConfirmOpen(true)}
            >
              {applying ? t('tagSuggestions.applying') : t('tagSuggestions.applyN', { count: selectedMerges.length })}
            </button>
          </div>
        </div>
      )}
      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => { if (!applying) setConfirmOpen(false); }}
        onConfirm={applyBatch}
        title={t('tagSuggestions.title')}
        message={t('tagSuggestions.confirmBatch', { count: selectedMerges.length })}
        confirmLabel={t('tagSuggestions.mergeBtn')}
        loading={applying}
      />
    </div>
  );
}


type DuplicateGroup = { groupId: string; maxSimilarity: number; members: { id: string; title: string; scope: string; type: string; version: number; updatedAt: string }[] };

function KnowledgeHealthSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [stale, setStale] = useState<{ id: string; title: string; type: string; scope: string; confidenceScore: number; updatedAt: string; expiresAt: string | null }[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  // Per-group "keep" choice (groupId → member id). Default = first member
  // (server pre-sorts: version DESC, then updatedAt DESC).
  const [keepChoice, setKeepChoice] = useState<Record<string, string>>({});
  const [resolveGroup, setResolveGroup] = useState<DuplicateGroup | null>(null);
  const [resolving, setResolving] = useState(false);
  const [dupMessage, setDupMessage] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getStaleEntries().catch(() => []),
      api.getDuplicateGroups().catch(() => []),
    ]).then(([s, d]) => { setStale(s); setDuplicates(d); }).finally(() => setLoading(false));
  }, []);

  const openEntry = (id: string) => navigate('/?edit=' + encodeURIComponent(id));

  const reloadDuplicates = () =>
    api.getDuplicateGroups().then(setDuplicates).catch(() => {});

  const keeperFor = (g: DuplicateGroup) => keepChoice[g.groupId] ?? g.members[0]?.id;

  const confirmResolve = async () => {
    if (!resolveGroup) return;
    const keeperId = keeperFor(resolveGroup);
    const toDelete = resolveGroup.members.filter((m) => m.id !== keeperId).map((m) => m.id);
    setResolving(true);
    try {
      const res = await api.bulkDeleteKnowledge(toDelete);
      setDupMessage(
        res.errors?.length
          ? t('health.deleteFailed', { error: res.errors[0] })
          : t('health.deleted', { count: res.deleted }),
      );
      setResolveGroup(null);
      await reloadDuplicates();
    } catch {
      setDupMessage(t('health.deleteFailed', { error: '' }));
      setResolveGroup(null);
    }
    setResolving(false);
    setTimeout(() => setDupMessage(null), 5000);
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 32, paddingTop: 24 }}>
      <h2 style={sectionHeaderStyle}>{t('health.title')}</h2>
      {loading ? (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('health.loading')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('health.stale')}</h3>
            {stale.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('health.staleEmpty')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {stale.map((e) => (
                  <div key={e.id} onClick={() => openEntry(e.id)} style={{ cursor: 'pointer', fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span>{e.title || '(untitled)'}</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 11, whiteSpace: 'nowrap' }}>
                      {e.scope} · {e.updatedAt.slice(0, 10)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('health.duplicates')}</h3>
            {dupMessage && <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{dupMessage}</p>}
            {duplicates.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('health.dupEmpty')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {duplicates.map((g) => {
                  const keeperId = keeperFor(g);
                  const deleteCount = g.members.length - 1;
                  return (
                    <div key={g.groupId} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {t('health.groupTitle', { count: g.members.length })} · {Math.round(g.maxSimilarity * 100)}%
                      </div>
                      {g.members.map((m) => (
                        <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                          <input
                            type="radio"
                            name={`dup-${g.groupId}`}
                            checked={keeperId === m.id}
                            onChange={() => setKeepChoice((prev) => ({ ...prev, [g.groupId]: m.id }))}
                            disabled={resolving}
                          />
                          <span style={{ cursor: 'pointer', textDecoration: 'underline', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={(e) => { e.preventDefault(); openEntry(m.id); }}>
                            {m.title || '(untitled)'}
                          </span>
                          <span style={{ color: 'var(--text-secondary)', fontSize: 11, whiteSpace: 'nowrap' }}>
                            {m.scope} · {m.type} · v{m.version} · {m.updatedAt.slice(0, 10)}
                          </span>
                        </label>
                      ))}
                      <div>
                        <button
                          style={ghostButtonStyle}
                          disabled={resolving || deleteCount === 0}
                          onClick={() => setResolveGroup(g)}
                        >
                          {t('health.deleteOthers', { count: deleteCount })}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      <ConfirmModal
        isOpen={resolveGroup !== null}
        onClose={() => { if (!resolving) setResolveGroup(null); }}
        onConfirm={confirmResolve}
        title={t('health.duplicates')}
        message={resolveGroup ? t('health.confirmGroupDelete', { count: resolveGroup.members.length - 1 }) : ''}
        confirmLabel={resolveGroup ? t('health.deleteOthers', { count: resolveGroup.members.length - 1 }) : ''}
        loading={resolving}
      />
    </div>
  );
}

// ─── Cleanup Report ────────────────────────────────────────────

/**
 * The user-facing half of the cleanup cycle: review what the periodic scan
 * proposed and approve it item by item.
 *
 * Deletions here are irreversible, so the flow is deliberately unhurried —
 * removals need a confirmation, and a consolidation cannot be approved at all
 * until its merged text has been previewed. There is no bulk action that spans
 * categories.
 */
function CleanupReportSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<CleanupReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, { draft: { title: string; content: string }; usedLlm: boolean; tags: string[] }>>({});
  const [confirm, setConfirm] = useState<
    | { kind: 'one'; candidate: CleanupCandidate }
    | { kind: 'all'; candidates: CleanupCandidate[]; label: string }
    | { kind: 'merge'; candidate: CleanupCandidate }
    | null
  >(null);

  const reload = useCallback(
    () => api.getCleanupReport().then(setData).catch(() => setData(null)),
    [],
  );

  useEffect(() => { reload().finally(() => setLoading(false)); }, [reload]);

  const flash = (msg: string) => { setMessage(msg); setTimeout(() => setMessage(null), 6000); };

  const pending = (data?.candidates ?? []).filter((c) => c.status === 'pending');
  const byCategory = (cat: string) => pending.filter((c) => c.category === cat);

  const runNow = async () => {
    setRunning(true);
    try { await api.runCleanupReport(); await reload(); }
    catch (e: any) { flash(t('cleanup.failed', { error: e?.message ?? '' })); }
    setRunning(false);
  };

  const approveOne = async (candidate: CleanupCandidate) => {
    setBusyId(candidate.id);
    try {
      const res = await api.approveCleanupCandidate(candidate.id);
      flash(
        (res.skipped ?? 0) > 0
          ? `${t('cleanup.applied', { count: res.deleted ?? 0 })} · ${t('cleanup.skipped', { count: res.skipped })}`
          : t('cleanup.applied', { count: res.deleted ?? 0 }),
      );
      await reload();
    } catch (e: any) {
      flash(t('cleanup.failed', { error: e?.message ?? '' }));
    }
    setBusyId(null);
  };

  const approveMany = async (candidates: CleanupCandidate[]) => {
    let deleted = 0; let skipped = 0; let failed = 0;
    setBusyId('bulk');
    for (const c of candidates) {
      try {
        const res = await api.approveCleanupCandidate(c.id);
        deleted += res.deleted ?? 0;
        skipped += res.skipped ?? 0;
      } catch { failed++; }
    }
    setBusyId(null);
    const parts = [t('cleanup.applied', { count: deleted })];
    if (skipped > 0) parts.push(t('cleanup.skipped', { count: skipped }));
    if (failed > 0) parts.push(t('cleanup.failed', { error: String(failed) }));
    flash(parts.join(' · '));
    await reload();
  };

  const preview = async (candidate: CleanupCandidate) => {
    setBusyId(candidate.id);
    try {
      const result = await api.previewCleanupCandidate(candidate.id);
      setPreviews((prev) => ({ ...prev, [candidate.id]: result }));
    } catch (e: any) {
      flash(t('cleanup.failed', { error: e?.message ?? '' }));
    }
    setBusyId(null);
  };

  const applyMerge = async (candidate: CleanupCandidate) => {
    const p = previews[candidate.id];
    if (!p) return; // guarded by the UI: apply only appears after a preview
    setBusyId(candidate.id);
    try {
      // Report what the server actually deleted, not the group size: members can
      // disappear between generation and approval.
      const res = await api.approveCleanupCandidate(candidate.id, { draft: p.draft, usedLlm: p.usedLlm });
      flash(t('cleanup.applied', { count: res.deleted ?? 0 }));
      setPreviews((prev) => { const next = { ...prev }; delete next[candidate.id]; return next; });
      await reload();
    } catch (e: any) {
      flash(t('cleanup.failed', { error: e?.message ?? '' }));
    }
    setBusyId(null);
  };

  const dismiss = async (candidate: CleanupCandidate) => {
    setBusyId(candidate.id);
    try { await api.dismissCleanupCandidate(candidate.id); await reload(); }
    catch (e: any) { flash(t('cleanup.failed', { error: e?.message ?? '' })); }
    setBusyId(null);
  };

  const closeReport = async () => {
    if (!data?.report) return;
    setBusyId('close');
    try {
      const res = await api.closeCleanupReport(data.report.id);
      flash(t('cleanup.closed', { count: res.removed }));
      await reload();
    } catch (e: any) { flash(t('cleanup.failed', { error: e?.message ?? '' })); }
    setBusyId(null);
  };

  const openEntry = (id: string) => navigate('/?edit=' + encodeURIComponent(id));
  const busy = busyId !== null || running;

  const removalRow = (c: CleanupCandidate) => (
    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
      <span
        onClick={() => openEntry(c.entryIds[0])}
        style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', textDecoration: 'underline' }}
      >
        {c.payload.title || '(untitled)'}
      </span>
      <span style={{ color: 'var(--text-secondary)', fontSize: 11, whiteSpace: 'nowrap' }}>
        {c.payload.scope}
        {c.category === 'unread' && ` · ${t('cleanup.lastRead', { date: c.payload.lastReadAt?.slice(0, 10) ?? t('cleanup.never') })}`}
      </span>
      <button onClick={() => setConfirm({ kind: 'one', candidate: c })} disabled={busy} style={smallDangerButton}>
        {t('cleanup.approve')}
      </button>
      <button onClick={() => dismiss(c)} disabled={busy} style={smallButton}>
        {t('cleanup.dismiss')}
      </button>
    </div>
  );

  const removalGroup = (cat: 'deprecated' | 'unread', label: string) => {
    const items = byCategory(cat);
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600 }}>{label}</h3>
          {items.length > 1 && (
            <button
              onClick={() => setConfirm({ kind: 'all', candidates: items, label })}
              disabled={busy}
              style={smallButton}
            >
              {t('cleanup.approveAll', { count: items.length })}
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('cleanup.emptyCategory')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{items.map(removalRow)}</div>
        )}
      </div>
    );
  };

  const groups = byCategory('duplicate_group');

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 32, paddingTop: 24 }}>
      <h2 style={sectionHeaderStyle}>{t('cleanup.title')}</h2>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>{t('cleanup.subtitle')}</p>

      {loading ? (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('cleanup.loading')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button onClick={runNow} disabled={busy} style={smallButton}>
              {running ? t('cleanup.running') : t('cleanup.runNow')}
            </button>
            {data?.report && (
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {t('cleanup.generatedAt', { date: data.report.createdAt.slice(0, 10) })}
                {data.report.stats.counts && ` · ${t('cleanup.counts', {
                  deprecated: data.report.stats.counts.deprecated,
                  unread: data.report.stats.counts.unread,
                  groups: data.report.stats.counts.duplicateGroups,
                  total: data.report.stats.counts.removableEntries,
                })}`}
              </span>
            )}
            {/* Offered for ANY open report, including one whose candidates have
                all been resolved: only one report may be open at a time, so an
                un-closable empty report would stall the cycle until the
                auto-close at twice the interval. */}
            {data?.report?.status === 'open' && (
              <button onClick={closeReport} disabled={busy} style={smallButton}>{t('cleanup.closeReport')}</button>
            )}
          </div>

          {message && <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{message}</p>}

          {!data?.report && <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('cleanup.none')}</p>}

          {/* Unread detection suppresses itself until its signal is trustworthy;
              say so rather than showing a silently empty bucket. */}
          {data?.report?.stats.unreadGate && (
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
              {t('cleanup.gate', { reason: data.report.stats.unreadGate })}
            </p>
          )}

          {data?.report?.status === 'closed' && typeof data.report.stats.removed === 'number' && (
            <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {t('cleanup.closed', { count: data.report.stats.removed })}
            </p>
          )}

          {data?.report && (
            <>
              {removalGroup('deprecated', t('cleanup.deprecated'))}
              {removalGroup('unread', t('cleanup.unread', { days: data.settings.cleanupUnreadDays }))}

              <div>
                <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('cleanup.duplicates')}</h3>
                {groups.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('cleanup.emptyCategory')}</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {groups.map((c) => {
                      const p = previews[c.id];
                      const members = c.payload.members ?? [];
                      return (
                        <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            {members.length} · {Math.round((c.payload.maxSimilarity ?? 0) * 100)}%
                          </div>
                          {members.map((m, i) => (
                            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                              <span style={{ fontSize: 11, color: i === 0 ? 'var(--success, #2a2)' : 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                                {i === 0 ? `★ ${t('cleanup.canonical')}` : t('cleanup.willDelete')}
                              </span>
                              <span
                                onClick={() => openEntry(m.id)}
                                style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', textDecoration: 'underline' }}
                              >
                                {m.title || '(untitled)'}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{m.updatedAt.slice(0, 10)}</span>
                            </div>
                          ))}

                          {p && (
                            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                {p.usedLlm ? t('cleanup.byModel') : t('cleanup.byFallback')}
                              </div>
                              <div style={{ fontSize: 13, fontWeight: 600 }}>{p.draft.title}</div>
                              <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', background: 'var(--bg-secondary, transparent)', padding: 8, borderRadius: 6, margin: 0 }}>
                                {p.draft.content}
                              </pre>
                              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                {t('cleanup.mergedTags')}: {p.tags.join(', ') || '—'}
                              </div>
                            </div>
                          )}

                          <div style={{ display: 'flex', gap: 8 }}>
                            {/* Apply only exists once the merged text has been shown:
                                approving unseen text would delete the other members. */}
                            {p ? (
                              <button onClick={() => setConfirm({ kind: 'merge', candidate: c })} disabled={busy} style={smallDangerButton}>
                                {t('cleanup.applyMerge')}
                              </button>
                            ) : (
                              <button onClick={() => preview(c)} disabled={busy} style={smallButton}>
                                {busyId === c.id ? t('cleanup.previewing') : t('cleanup.preview')}
                              </button>
                            )}
                            <button onClick={() => dismiss(c)} disabled={busy} style={smallButton}>{t('cleanup.dismiss')}</button>
                          </div>
                          {busyId === c.id && !p && (
                            <p style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('cleanup.downloadingModel')}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={confirm !== null}
        onClose={() => { if (!busy) setConfirm(null); }}
        onConfirm={async () => {
          const c = confirm;
          setConfirm(null);
          if (!c) return;
          if (c.kind === 'one') await approveOne(c.candidate);
          else if (c.kind === 'all') await approveMany(c.candidates);
          else await applyMerge(c.candidate);
        }}
        title={t('cleanup.title')}
        message={
          confirm?.kind === 'all'
            ? t('cleanup.confirmApproveAll', { count: confirm.candidates.length })
            : confirm?.kind === 'merge'
              ? t('cleanup.confirmMerge', { count: confirm.candidate.entryIds.length })
              : t('cleanup.confirmApprove')
        }
        confirmLabel={confirm?.kind === 'merge' ? t('cleanup.applyMerge') : t('cleanup.approve')}
        loading={busy}
      />
    </div>
  );
}

const smallButton: React.CSSProperties = {
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text)',
  cursor: 'pointer',
};

const smallDangerButton: React.CSSProperties = {
  ...smallButton,
  borderColor: 'var(--error)',
  color: 'var(--error)',
};
