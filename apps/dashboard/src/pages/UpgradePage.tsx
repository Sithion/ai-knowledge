import { useState, useEffect, useCallback, useRef } from 'react';
import { api, ApiError, type UpgradeStepStatus } from '../api/client.js';

declare const __APP_VERSION__: string;

interface UpgradeStep {
  step: string;
  status: UpgradeStepStatus | 'pending' | 'running';
  message?: string;
}

const POLL_MS = 750;
/** Steps a healthy upgrade emits (`reembed` and `integrity` are conditional, so
 *  the real total can be higher — the bar widens instead of overflowing). */
const BASE_STEP_COUNT = 9;

const STEP_LABELS: Record<string, string> = {
  database: 'Database Schema',
  reembed: 'Re-embedding knowledge',
  integrity: 'Embedding integrity check',
  'instructions-claude': 'Claude Code Instructions',
  'instructions-copilot': 'Copilot Instructions',
  'instructions-opencode': 'OpenCode Instructions',
  'mcp-configs': 'MCP Configurations',
  'mcp-shadow-check': 'MCP Install Check',
  skills: 'Skills',
  hooks: 'Hooks',
  version: 'Save Version',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function StepIcon({ status }: { status: string }) {
  if (status === 'success') return <span style={{ color: '#22c55e', fontSize: 18 }}>✓</span>;
  if (status === 'error') return <span style={{ color: '#ef4444', fontSize: 18 }}>✗</span>;
  if (status === 'warning') return <span style={{ color: '#f59e0b', fontSize: 16 }}>!</span>;
  if (status === 'skipped') return <span style={{ color: 'var(--text-secondary)', fontSize: 16 }}>–</span>;
  if (status === 'running') {
    return (
      <span style={{ display: 'inline-block', width: 16, height: 16 }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <svg width="16" height="16" viewBox="0 0 16 16" style={{ animation: 'spin 0.8s linear infinite' }}>
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="22 16" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return <span style={{ color: 'var(--text-secondary)', fontSize: 16 }}>○</span>;
}

export function UpgradePage({ fromVersion, onComplete }: { fromVersion: string; onComplete: () => void }) {
  const [steps, setSteps] = useState<UpgradeStep[]>([]);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The POST is fired exactly once per attempt. Without this, StrictMode's
   *  double-mount in dev would start two upgrades. */
  const startedRef = useRef(false);
  /** `startedAt` of the run we are showing. The progress object outlives a run
   *  by design, so this is what tells a fresh snapshot from a stale one. */
  const latchedRef = useRef<string | null>(null);

  // Polling lives in its own effect so it survives a StrictMode remount: the
  // cleanup cancels the in-flight timer and the effect immediately restarts it.
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const p = await api.getUpgradeProgress();
        if (!cancelled) {
          if (p.running && p.startedAt && latchedRef.current === null) latchedRef.current = p.startedAt;
          if (latchedRef.current !== null && p.startedAt === latchedRef.current) {
            setSteps(p.steps.map((s) => ({ step: s.step, status: s.status })));
            setCurrentStep(p.running ? p.currentStep : null);
          }
        }
      } catch {
        // Transient: the sidecar tears the SDK down mid-upgrade. Keep polling.
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };

    void tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [polling]);

  const runUpgrade = useCallback(async () => {
    setSteps([]);
    setCurrentStep(null);
    setDone(false);
    setError(null);
    latchedRef.current = null;
    setPolling(true);

    const succeed = () => {
      setDone(true);
      setCurrentStep(null);
      setTimeout(onComplete, 1500);
    };

    try {
      let result;
      try {
        result = await api.runUpgrade();
      } catch (e) {
        // 409 only happens when something else holds the deploy lock (the
        // Settings redeploy button). That is progress, not failure: wait for it
        // to finish, then see whether an upgrade is still needed.
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        for (let i = 0; i < 240; i++) {
          await sleep(POLL_MS);
          const p = await api.getUpgradeProgress().catch(() => null);
          if (p && !p.running) break;
        }
        const recheck = await api.checkUpgrade();
        if (!recheck.needsUpgrade) { succeed(); return; }
        result = await api.runUpgrade();
      }

      // Already up to date and nothing ran — never paint an empty step list.
      if (result.noop) { onComplete(); return; }

      // The POST result is authoritative: it carries the messages the polled
      // snapshots omit, and the last poll may be a tick behind (or, on a fast
      // upgrade, may never have seen the run at all).
      setSteps(result.results.map((r) => ({ step: r.step, status: r.status, message: r.message })));
      setCurrentStep(null);

      if (result.success) succeed();
      else setError('Some steps did not complete. You can retry the update.');
    } catch {
      setError('The update could not be completed. You can retry it.');
    } finally {
      setPolling(false);
    }
  }, [onComplete]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runUpgrade();
  }, [runUpgrade]);

  const retry = useCallback(() => { void runUpgrade(); }, [runUpgrade]);

  // A run we have not seen start yet: the POST may still be waiting on a deploy
  // that was already in flight when the window opened.
  const preparing = !done && !error && latchedRef.current === null && steps.length === 0;
  const runningRow = currentStep && !steps.some((s) => s.step === currentStep) ? currentStep : null;
  const total = Math.max(BASE_STEP_COUNT, steps.length + (runningRow ? 1 : 0));
  const pct = done ? 100 : Math.min(95, Math.round((steps.length / total) * 100));

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: 'var(--bg-main)',
      flexDirection: 'column', gap: 0,
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{ width: 440, padding: 32 }}>
        {/* Version Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🧠</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
            Updating CogniStore
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, fontSize: 14 }}>
            <span style={{
              padding: '4px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600,
              backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
            }}>
              v{fromVersion}
            </span>
            <span style={{ color: 'var(--accent)', fontSize: 18 }}>→</span>
            <span style={{
              padding: '4px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600,
              backgroundColor: 'var(--accent)', color: '#fff',
            }}>
              v{__APP_VERSION__}
            </span>
          </div>
        </div>

        {/* Progress Bar */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ height: 4, backgroundColor: 'var(--bg-input)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              width: `${pct}%`, height: '100%',
              backgroundColor: done ? '#22c55e' : 'var(--accent)',
              borderRadius: 2, transition: 'width 0.5s ease',
            }} />
          </div>
        </div>

        {/* Steps */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {preparing && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px', borderRadius: 8,
              backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)',
            }}>
              <StepIcon status="running" />
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                Finishing previous update…
              </span>
            </div>
          )}
          {steps.map((s) => (
            <div key={s.step} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px', borderRadius: 8,
              backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)',
            }}>
              <StepIcon status={s.status} />
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {STEP_LABELS[s.step] || s.step}
                </span>
                {s.message && s.status === 'error' && (
                  <p style={{ fontSize: 11, color: 'var(--error)', marginTop: 2 }}>{s.message}</p>
                )}
              </div>
              {s.status === 'success' && (
                <span style={{ fontSize: 10, color: '#22c55e', fontWeight: 600 }}>Done</span>
              )}
            </div>
          ))}
          {runningRow && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px', borderRadius: 8,
              backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)',
            }}>
              <StepIcon status="running" />
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                {STEP_LABELS[runningRow] || runningRow}
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          {done && (
            <p style={{ color: '#22c55e', fontSize: 14, fontWeight: 600 }}>
              Update complete! Opening dashboard...
            </p>
          )}
          {error && (
            <>
              <p style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{error}</p>
              <button
                onClick={retry}
                style={{
                  padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  backgroundColor: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer',
                }}
              >
                Retry
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
