import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AreaChart, Area, BarChart, Bar, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell, Legend,
} from 'recharts';
import { useAppSelector } from '../store/index.js';
import { api, PROVIDER_SOURCE, SOURCE_TO_PROVIDER, type ProviderFilter, type TokenUsageAggregates } from '../api/client.js';
import { DateRangePicker } from '../components/DateRangePicker.js';
import { MetricCard, WidgetCard, formatTokens, getHeatmapColor } from '../components/statsPrimitives.js';

const MODEL_COLORS = ['#8b5cf6', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PROVIDERS: { key: ProviderFilter; labelKey: string }[] = [
  { key: 'all', labelKey: 'tokens.all' },
  { key: 'claude', labelKey: 'tokens.claude' },
  { key: 'copilot', labelKey: 'tokens.copilot' },
];
const PROVIDER_COLORS: Record<string, string> = { claude: '#8b5cf6', copilot: '#3b82f6' };

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, color,
      backgroundColor: `${color}1f`, border: `1px solid ${color}55`,
    }}>
      {label}
    </span>
  );
}

/** One colored badge per platform from a comma-joined `sources` string — a project
 *  worked on with both tools shows two badges (Claude + Copilot). */
function PlatformBadge({ sources }: { sources: string }) {
  const { t } = useTranslation();
  const providers = Array.from(
    new Set((sources ?? '').split(',').map((s) => SOURCE_TO_PROVIDER[s.trim()]).filter(Boolean)),
  );
  if (providers.length === 0) return <Badge label={t('tokens.unknown')} color="#6b7280" />;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {providers.map((p) => <Badge key={p} label={t(`tokens.${p}`)} color={PROVIDER_COLORS[p] ?? '#6b7280'} />)}
    </span>
  );
}

function ModelsBar({ data }: { data: TokenUsageAggregates['byModel'] }) {
  if (data.length === 0) return null;
  const total = data.reduce((s, d) => s + d.totalTokens, 0) || 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {data.slice(0, 7).map((m, i) => {
        const pct = (m.totalTokens / total) * 100;
        return (
          <div key={m.model}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{m.model}</span>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{formatTokens(m.totalTokens)} · {pct.toFixed(0)}%</span>
            </div>
            <div style={{ height: 8, borderRadius: 4, backgroundColor: 'var(--bg-input)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, backgroundColor: MODEL_COLORS[i % MODEL_COLORS.length] }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CacheGauge({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  const color = pct >= 50 ? '#22c55e' : pct >= 25 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{ position: 'relative', width: 140, height: 140 }}>
        <svg width="140" height="140" viewBox="0 0 140 140">
          <circle cx="70" cy="70" r="60" fill="none" stroke="var(--bg-input)" strokeWidth="14" />
          <circle
            cx="70" cy="70" r="60" fill="none" stroke={color} strokeWidth="14"
            strokeDasharray={`${(pct / 100) * 377} 377`}
            strokeLinecap="round"
            transform="rotate(-90 70 70)"
          />
          <text x="70" y="76" textAnchor="middle" fontSize="24" fontWeight="700" fill="var(--text-primary)">{pct}%</text>
        </svg>
      </div>
    </div>
  );
}

function HourDayHeatmap({ data }: { data: TokenUsageAggregates['byHourDay'] }) {
  const max = data.reduce((m, d) => Math.max(m, d.totalTokens), 0);
  const lookup = new Map(data.map((d) => [`${d.dayOfWeek}-${d.hour}`, d.totalTokens]));
  const cell = 12;
  const gap = 3;
  return (
    <div>
      <div style={{ display: 'flex', gap, marginLeft: 30 }}>
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} style={{ width: cell, fontSize: 9, color: 'var(--text-secondary)', textAlign: 'center' }}>
            {h % 6 === 0 ? h : ''}
          </span>
        ))}
      </div>
      {DAY_LABELS.map((label, day) => (
        <div key={day} style={{ display: 'flex', gap, alignItems: 'center', marginTop: gap }}>
          <span style={{ width: 26, fontSize: 10, color: 'var(--text-secondary)' }}>{label}</span>
          {Array.from({ length: 24 }, (_, h) => {
            const v = lookup.get(`${day}-${h}`) ?? 0;
            return (
              <div
                key={h}
                title={`${label} ${h}:00 — ${formatTokens(v)} tokens`}
                style={{ width: cell, height: cell, borderRadius: 2, backgroundColor: getHeatmapColor(v, max) }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function TokenConsumptionPage() {
  const { t } = useTranslation();
  const { range } = useAppSelector((s) => s.dateRange);
  const [data, setData] = useState<TokenUsageAggregates | null>(null);
  const [scanning, setScanning] = useState(false);
  const [provider, setProvider] = useState<ProviderFilter>('all');
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the persisted provider filter once (shared with the widget via settings.json).
  useEffect(() => {
    api.getSettings()
      .then((s) => setProvider(s.tokenProviderFilter ?? 'all'))
      .catch(() => { /* keep default */ })
      .finally(() => setHydrated(true));
  }, []);

  const load = () => {
    api.getTokenUsage({ from: range.from, to: range.to, source: PROVIDER_SOURCE[provider] })
      .then(setData)
      .catch(() => setData(null));
  };

  // Wait for hydration so we fetch once with the persisted provider, not twice.
  useEffect(() => {
    if (hydrated) load();
  }, [range.from, range.to, provider, hydrated]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeProvider = (p: ProviderFilter) => {
    setProvider(p);
    void api.updateSettings({ tokenProviderFilter: p }).catch(() => {});
  };

  const rescan = async () => {
    setScanning(true);
    try { await api.scanTokenUsage(); load(); } finally { setScanning(false); }
  };

  const totals = data?.totals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const hasAnyTokens = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens > 0;

  const dailySeries = (data?.byDay ?? []).map((d) => ({
    date: d.date,
    input: d.inputTokens,
    output: d.outputTokens,
    cacheRead: d.cacheReadTokens,
    cacheWrite: d.cacheCreationTokens,
  }));

  return (
    <div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>{t('tokens.title')}</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('tokens.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {PROVIDERS.map(({ key, labelKey }) => {
              const active = provider === key;
              return (
                <button
                  key={key}
                  onClick={() => changeProvider(key)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    backgroundColor: active ? 'var(--accent)' : 'var(--bg-card)',
                    color: active ? '#fff' : 'var(--text-primary)',
                    fontSize: 12,
                    fontWeight: active ? 600 : 500,
                    cursor: 'pointer',
                  }}
                >
                  {t(labelKey)}
                </button>
              );
            })}
          </div>
          <DateRangePicker />
          <button
            onClick={rescan}
            disabled={scanning}
            style={{
              padding: '6px 12px', borderRadius: 6,
              border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)',
              color: 'var(--text-primary)', fontSize: 12, fontWeight: 600,
              cursor: scanning ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            {scanning ? (
              <>
                <span style={{ width: 12, height: 12, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                {t('tokens.rescanning')}
              </>
            ) : t('tokens.rescan')}
          </button>
        </div>
      </div>

      {/* ── Top-line totals ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <MetricCard label={t('tokens.input')}      value={formatTokens(totals.inputTokens)} />
        <MetricCard label={t('tokens.output')}     value={formatTokens(totals.outputTokens)} />
        <MetricCard label={t('tokens.cacheRead')}  value={formatTokens(totals.cacheReadTokens)} />
        <MetricCard label={t('tokens.cacheWrite')} value={formatTokens(totals.cacheCreationTokens)} />
      </div>

      {!hasAnyTokens && (
        <WidgetCard title={t('tokens.title')} state="empty" emptyText={t('tokens.noData')}>
          <span />
        </WidgetCard>
      )}

      {hasAnyTokens && (
        <>
          {/* Activity + Models */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24, marginBottom: 24 }}>
            <WidgetCard title={t('tokens.activity')} state="loaded">
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={dailySeries}>
                  <XAxis dataKey="date" tick={{ fill: 'var(--text-secondary)', fontSize: 10 }} tickFormatter={(v) => v.slice(5)} />
                  <YAxis hide />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    itemStyle={{ color: 'var(--text-primary)' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text-secondary)' }} />
                  <Area type="monotone" stackId="t" dataKey="input"      name={t('tokens.input')}      stroke="#8b5cf6" fill="#8b5cf640" />
                  <Area type="monotone" stackId="t" dataKey="output"     name={t('tokens.output')}     stroke="#3b82f6" fill="#3b82f640" />
                  <Area type="monotone" stackId="t" dataKey="cacheRead"  name={t('tokens.cacheRead')}  stroke="#22c55e" fill="#22c55e40" />
                  <Area type="monotone" stackId="t" dataKey="cacheWrite" name={t('tokens.cacheWrite')} stroke="#f59e0b" fill="#f59e0b40" />
                </AreaChart>
              </ResponsiveContainer>
            </WidgetCard>

            <WidgetCard title={t('tokens.models')} state={data && data.byModel.length > 0 ? 'loaded' : 'empty'} emptyText={t('tokens.noData')}>
              {data && <ModelsBar data={data.byModel} />}
            </WidgetCard>
          </div>

          {/* Cache efficiency + time-of-day */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 24, marginBottom: 24 }}>
            <WidgetCard title={t('tokens.cacheEfficiency')} state="loaded">
              <CacheGauge ratio={data?.cacheEfficiency ?? 0} />
            </WidgetCard>

            <WidgetCard title={t('tokens.timeOfDay')} state={data && data.byHourDay.length > 0 ? 'loaded' : 'empty'} emptyText={t('tokens.noData')}>
              {data && <HourDayHeatmap data={data.byHourDay} />}
            </WidgetCard>
          </div>

          {/* Top projects */}
          <WidgetCard title={t('tokens.topProjects')} state={data && data.byProject.length > 0 ? 'loaded' : 'empty'} emptyText={t('tokens.noData')} style={{ marginBottom: 24 }}>
            {data && data.byProject.length > 0 && (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('tokens.projectCol')}</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('tokens.platformCol')}</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px' }}>{t('tokens.input')}</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px' }}>{t('tokens.output')}</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px' }}>{t('tokens.cacheRead')}</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px' }}>{t('tokens.cacheWrite')}</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px' }}>{t('tokens.tokensCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byProject.slice(0, 15).map((p) => (
                    <tr key={p.project} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 8px' }}>{p.project}</td>
                      <td style={{ padding: '6px 8px' }}><PlatformBadge sources={p.sources} /></td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{formatTokens(p.inputTokens)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{formatTokens(p.outputTokens)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{formatTokens(p.cacheReadTokens)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{formatTokens(p.cacheCreationTokens)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--accent)' }}>{formatTokens(p.totalTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </WidgetCard>

          {/* Top sessions */}
          <WidgetCard title={t('tokens.topSessions')} state={data && data.topSessions.length > 0 ? 'loaded' : 'empty'} emptyText={t('tokens.noData')}>
            {data && data.topSessions.length > 0 && (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('tokens.sessionIdCol')}</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('tokens.projectCol')}</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('tokens.platformCol')}</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('tokens.modelCol')}</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px' }}>{t('tokens.startedCol')}</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px' }}>{t('tokens.tokensCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topSessions.map((s) => (
                    <tr key={s.sessionId} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 11 }}>{s.sessionId.slice(0, 8)}…</td>
                      <td style={{ padding: '6px 8px' }}>{s.project ?? t('tokens.unknown')}</td>
                      <td style={{ padding: '6px 8px' }}><PlatformBadge sources={s.source} /></td>
                      <td style={{ padding: '6px 8px' }}>{s.model}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>{new Date(s.startedAt).toLocaleString()}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--accent)' }}>{formatTokens(s.totalTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </WidgetCard>
        </>
      )}
    </div>
  );
}
