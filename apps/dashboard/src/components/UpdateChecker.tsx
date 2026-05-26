import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';

declare const __APP_VERSION__: string;

/** How often to check for updates (30 minutes) */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Sithion/cognistore/releases/latest';

type UpdateState = 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'ready' | 'error';

/** Global event target for cross-component communication */
const updateEvents = new EventTarget();

/** Whether the check was triggered manually (shows error/upToDate feedback) */
let isManualCheck = false;

/** Cached latest release URL for fallback download */
let latestReleaseUrl = '';

/** Detect Tauri environment — check both v2 internals and legacy global */
const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;

/** Legacy localStorage key — kept only for one-shot migration to settings.json. */
const LEGACY_AUTO_UPDATE_KEY = 'cognistore-auto-update';

/**
 * Pre-warmed cache so the 30-min interval can fire synchronously.
 * Hydrated by useAutoUpdateSetting() on mount.
 */
let autoUpdateCache: boolean = false;

/** Returns the cached auto-update value. Hydration happens via useAutoUpdateSetting(). */
function getAutoUpdateEnabledCached(): boolean {
  return autoUpdateCache;
}

/**
 * One-shot migration: copy legacy localStorage value to settings.json on first read,
 * then forget the localStorage key.
 */
async function migrateLegacyAutoUpdate(): Promise<void> {
  let legacy: string | null = null;
  try { legacy = localStorage.getItem(LEGACY_AUTO_UPDATE_KEY); } catch { /* ignore */ }
  if (legacy === null) return;
  try {
    await api.updateSettings({ autoUpdate: legacy === 'true' });
    try { localStorage.removeItem(LEGACY_AUTO_UPDATE_KEY); } catch { /* ignore */ }
  } catch { /* server might not be ready — try again next mount */ }
}

/**
 * Hook for reading/writing the auto-update preference, backed by ~/.cognistore/settings.json.
 * Also hydrates the module-level cache used by the 30-min interval.
 */
export function useAutoUpdateSetting(): [boolean, (value: boolean) => Promise<void>] {
  const [value, setValue] = useState<boolean>(autoUpdateCache);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await migrateLegacyAutoUpdate();
      try {
        const settings = await api.getSettings();
        if (cancelled) return;
        autoUpdateCache = !!settings.autoUpdate;
        setValue(autoUpdateCache);
      } catch { /* keep current cache */ }
    })();
    // Keep every hook instance (e.g. SettingsPage + UpdateChecker) in sync when
    // the preference is toggled, so the periodic checker reacts immediately.
    const onChange = () => setValue(autoUpdateCache);
    updateEvents.addEventListener('autoUpdateChanged', onChange);
    return () => { cancelled = true; updateEvents.removeEventListener('autoUpdateChanged', onChange); };
  }, []);

  const update = useCallback(async (next: boolean) => {
    autoUpdateCache = next;
    setValue(next);
    updateEvents.dispatchEvent(new Event('autoUpdateChanged'));
    try { await api.updateSettings({ autoUpdate: next }); } catch { /* swallow */ }
  }, []);

  return [value, update];
}

/** Trigger an update check from anywhere (manual = shows feedback) */
export function triggerUpdateCheck() {
  isManualCheck = true;
  updateEvents.dispatchEvent(new Event('check'));
}

/** Trigger download of a pending update from anywhere */
export function triggerUpdateDownload() {
  updateEvents.dispatchEvent(new Event('download'));
}

/** Subscribe to update state changes */
export function onUpdateState(cb: (state: UpdateState) => void) {
  const handler = (e: Event) => cb((e as CustomEvent).detail);
  updateEvents.addEventListener('state', handler);
  return () => updateEvents.removeEventListener('state', handler);
}

/** Get whether we're running inside Tauri */
export function getIsTauri() {
  return isTauri;
}

/** Get the latest release URL (for fallback) */
export function getLatestReleaseUrl() {
  return latestReleaseUrl;
}

/** Simple semver comparison: returns true if a > b */
function isNewerVersion(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

export function UpdateChecker() {
  const { t } = useTranslation();
  const [state, setState] = useState<UpdateState>('idle');
  const [version, setVersion] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState('');
  const manualRef = useRef(false);
  // Drive the periodic checker off the *hydrated* preference value. The setting
  // loads asynchronously from settings.json, so we must react when it resolves
  // (and when it's toggled) — reading a synchronous cache at mount would always
  // see the default `false` and the interval would never start.
  const [autoUpdateEnabled] = useAutoUpdateSetting();

  const broadcastState = useCallback((s: UpdateState) => {
    setState(s);
    updateEvents.dispatchEvent(new CustomEvent('state', { detail: s }));
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = (window as any).__pendingUpdate;
    if (!update) {
      // Fallback: no native update object — open release page in browser
      const url = latestReleaseUrl || 'https://github.com/Sithion/cognistore/releases/latest';
      window.open(url, '_blank');
      return;
    }

    try {
      broadcastState('downloading');
      setProgress(0);

      let downloaded = 0;
      const contentLength = update.rawInfo?.contentLength ?? 0;

      await update.downloadAndInstall((event: any) => {
        if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            setProgress(Math.round((downloaded / contentLength) * 100));
          }
        } else if (event.event === 'Finished') {
          setProgress(100);
        }
      });

      broadcastState('ready');

      setTimeout(async () => {
        try {
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        } catch {
          // Fallback: just tell the user to restart
        }
      }, 1500);
    } catch (err: any) {
      console.error('[UpdateChecker] downloadAndInstall failed:', err);
      setError(err?.message || 'Download failed');
      broadcastState('error');
    }
  }, [broadcastState]);

  const checkForUpdate = useCallback(async () => {
    const manual = isManualCheck;
    isManualCheck = false;
    manualRef.current = manual;

    if (isTauri) {
      // Tauri path: use plugin-updater for native binary updates
      try {
        broadcastState('checking');
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();

        if (update) {
          setVersion(update.version);
          broadcastState('available');
          setDismissed(false);
          (window as any).__pendingUpdate = update;

          // Auto-download in background (only if auto-update is enabled)
          if (getAutoUpdateEnabledCached()) {
            setTimeout(() => downloadAndInstall(), 500);
          }
        } else {
          if (manual) {
            broadcastState('upToDate');
            setTimeout(() => broadcastState('idle'), 3000);
          } else {
            broadcastState('idle');
          }
        }
      } catch (err: any) {
        console.error('[UpdateChecker] Tauri check() failed:', err);
        // Fallback: try GitHub API when native updater fails
        await checkGitHub(manual);
      }
    } else {
      // Non-Tauri path: check GitHub Releases API
      await checkGitHub(manual);
    }
  }, [broadcastState, downloadAndInstall]);

  const checkGitHub = useCallback(async (manual: boolean) => {
    try {
      if (!manual && state !== 'idle') return; // Don't interrupt active states
      broadcastState('checking');
      const res = await fetch(GITHUB_RELEASES_URL);
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const release = await res.json();
      const latestTag = (release.tag_name || '').replace(/^v/, '');
      const currentVersion = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0').replace(/^v/, '');

      if (latestTag && isNewerVersion(latestTag, currentVersion)) {
        setVersion(latestTag);
        const url = release.html_url || 'https://github.com/Sithion/cognistore/releases/latest';
        setDownloadUrl(url);
        latestReleaseUrl = url;
        broadcastState('available');
        setDismissed(false);
      } else {
        if (manual) {
          broadcastState('upToDate');
          setTimeout(() => broadcastState('idle'), 3000);
        } else {
          broadcastState('idle');
        }
      }
    } catch (err: any) {
      console.error('[UpdateChecker] GitHub check failed:', err);
      if (manual) {
        setError(err?.message || 'Check failed');
        broadcastState('error');
      } else {
        broadcastState('idle');
      }
    }
  }, [broadcastState, state]);

  // Check shortly after launch + every 30 minutes, but only while auto-update is
  // enabled. Re-runs when the hydrated preference flips (load or toggle), which is
  // what makes the periodic check actually start.
  useEffect(() => {
    if (!autoUpdateEnabled) return;
    const initial = setTimeout(checkForUpdate, 2000);
    const interval = setInterval(checkForUpdate, CHECK_INTERVAL_MS);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [autoUpdateEnabled, checkForUpdate]);

  // Listen for external check triggers (manual)
  useEffect(() => {
    const handler = () => checkForUpdate();
    updateEvents.addEventListener('check', handler);
    return () => updateEvents.removeEventListener('check', handler);
  }, [checkForUpdate]);

  // Listen for external download triggers
  useEffect(() => {
    const handler = () => downloadAndInstall();
    updateEvents.addEventListener('download', handler);
    return () => updateEvents.removeEventListener('download', handler);
  }, [downloadAndInstall]);

  // Don't render banner for idle/checking/upToDate or if dismissed
  if (state === 'idle' || state === 'checking' || state === 'upToDate' || dismissed) return null;

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
        backgroundColor: state === 'error' ? '#7f1d1d' : '#1e1b4b',
        borderBottom: '1px solid var(--border)',
        padding: '8px 16px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
        fontSize: 13, fontFamily: 'system-ui, sans-serif',
        animation: 'slideDown 0.3s ease-out',
      }}
    >
      <style>{`@keyframes slideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }`}</style>

      {state === 'available' && (
        <>
          <span style={{ color: '#c4b5fd' }}>
            Version <strong style={{ color: '#e9d5ff' }}>v{version}</strong> {t('update.available').toLowerCase()}
          </span>
          {isTauri && (window as any).__pendingUpdate ? (
            <button onClick={downloadAndInstall} style={{ backgroundColor: '#8b5cf6', color: 'white', border: 'none', borderRadius: 6, padding: '4px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              Update now
            </button>
          ) : (
            <a href={downloadUrl || 'https://github.com/Sithion/cognistore/releases/latest'} target="_blank" rel="noopener noreferrer" style={{ backgroundColor: '#8b5cf6', color: 'white', border: 'none', borderRadius: 6, padding: '4px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'none' }}>
              {t('update.viewRelease')}
            </a>
          )}
          <button onClick={() => setDismissed(true)} style={{ background: 'none', border: 'none', color: '#a78bfa', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }} title="Dismiss">×</button>
        </>
      )}

      {state === 'downloading' && (
        <>
          <span style={{ color: '#c4b5fd' }}>Downloading update...</span>
          <div style={{ width: 120, height: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', backgroundColor: '#8b5cf6', borderRadius: 3, transition: 'width 0.3s' }} />
          </div>
          <span style={{ color: '#a78bfa', fontSize: 11 }}>{progress}%</span>
        </>
      )}

      {state === 'ready' && (
        <span style={{ color: '#a3e635' }}>{t('update.restartToApply')}</span>
      )}

      {state === 'error' && (
        <>
          <span style={{ color: '#fca5a5' }}>Update failed: {error}</span>
          <button onClick={() => { broadcastState('idle'); setDismissed(true); }} style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>×</button>
        </>
      )}
    </div>
  );
}
