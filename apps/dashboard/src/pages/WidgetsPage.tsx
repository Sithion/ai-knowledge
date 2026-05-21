import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;

interface WidgetDef {
  id: string;
  titleKey: string;
  descKey: string;
  icon: string;
}

const WIDGET_DEFS: WidgetDef[] = [
  { id: 'stats', titleKey: 'widgets.knowledgeStats', descKey: 'widgets.descKnowledge', icon: '📊' },
  { id: 'plans', titleKey: 'widgets.planStats', descKey: 'widgets.descPlans', icon: '📋' },
  { id: 'active-plans', titleKey: 'widgets.activePlans', descKey: 'widgets.descActive', icon: '🎯' },
  { id: 'tokens', titleKey: 'widgets.tokens', descKey: 'widgets.descTokens', icon: '🔋' },
];

function getMaxVisiblePlans(): number {
  const val = Number(localStorage.getItem('widget-active-plans-max'));
  return val > 0 ? val : 5;
}

export function WidgetsPage() {
  const { t } = useTranslation();
  const [openWidgets, setOpenWidgets] = useState<string[]>([]);
  const [maxVisible, setMaxVisible] = useState(getMaxVisiblePlans);

  const syncState = useCallback(async () => {
    if (!isTauri) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const open = await invoke<string[]>('get_open_widgets');
      setOpenWidgets(open);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    syncState();
    const interval = setInterval(syncState, 2000);
    return () => clearInterval(interval);
  }, [syncState]);

  const openWidget = async (widgetId: string) => {
    if (!isTauri) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const params = widgetId === 'active-plans' ? `max=${maxVisible}` : undefined;
      await invoke('open_widget', { widgetId, params });
      syncState();
    } catch { /* ignore */ }
  };

  const handleMaxChange = (val: number) => {
    const clamped = Math.max(1, Math.min(20, val));
    setMaxVisible(clamped);
    localStorage.setItem('widget-active-plans-max', String(clamped));
  };

  if (!isTauri) {
    return (
      <div style={{ color: 'var(--text-secondary)', padding: 40, textAlign: 'center' }}>
        {t('widgets.desktopOnly')}
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>{t('widgets.title')}</h1>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24 }}>{t('widgets.subtitle')}</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
        {WIDGET_DEFS.map((w) => {
          const instanceCount = openWidgets.filter(t => t === w.id).length;
          return (
            <div
              key={w.id}
              style={{
                backgroundColor: 'var(--bg-card)',
                borderRadius: 10,
                border: `1px solid ${instanceCount > 0 ? 'var(--accent)' : 'var(--border)'}`,
                padding: 20,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                transition: 'border-color 0.2s ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 24 }}>{w.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {t(w.titleKey)}
                    {instanceCount > 0 && (
                      <span style={{
                        fontSize: 11, fontWeight: 500,
                        backgroundColor: 'rgba(34, 197, 94, 0.15)',
                        color: '#22c55e', borderRadius: 10, padding: '1px 8px',
                      }}>
                        {instanceCount}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {t(w.descKey)}
                  </div>
                </div>
              </div>

              {/* Active Plans: max visible setting */}
              {w.id === 'active-plans' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('widgets.maxVisible')}</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={maxVisible}
                    onChange={e => handleMaxChange(Number(e.target.value))}
                    style={{
                      width: 48, padding: '4px 6px', borderRadius: 4,
                      border: '1px solid var(--border)', backgroundColor: 'var(--bg-main)',
                      color: 'var(--text-primary)', fontSize: 12, textAlign: 'center',
                    }}
                  />
                </div>
              )}

              <button
                onClick={() => openWidget(w.id)}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: 'none',
                  backgroundColor: 'var(--accent)', color: '#fff',
                  cursor: 'pointer', fontSize: 13, fontWeight: 500,
                  transition: 'all 0.15s ease',
                }}
              >
                {t('widgets.open')}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
