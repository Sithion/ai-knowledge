import { useEffect, useRef, useState, useCallback, type ReactNode, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useTranslation } from 'react-i18next';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Label,
  AreaChart, Area, ResponsiveContainer, Legend, Line, LineChart, ReferenceLine,
} from 'recharts';
import { useAppDispatch, useAppSelector } from '../store/index.js';
import { fetchStats, fetchMetrics } from '../store/statsSlice.js';
import { DateRangePicker } from '../components/DateRangePicker.js';
import { dateAxisProps } from '../utils/chartAxis.js';

/* ── Constants ── */

const TYPE_COLORS: Record<string, string> = {
  Decision: '#8b5cf6',
  Pattern: '#3b82f6',
  Fix: '#22c55e',
  Constraint: '#f59e0b',
  Gotcha: '#ef4444',
};

const PIE_COLORS = ['#8b5cf6', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444'];
const SCOPE_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899'];

const POLL_INTERVAL_MS = 5_000;

/* ── Spinner ── */

function Spinner({ size = 24 }: { size?: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
      <div
        style={{
          width: size,
          height: size,
          border: '3px solid var(--border)',
          borderTopColor: 'var(--accent)',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }}
      />
    </div>
  );
}

/* ── Widget Card ── */

type WidgetState = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

function WidgetCard({
  title,
  state,
  children,
  emptyText = '',
  errorText = '',
  style,
  maxBodyHeight,
  badge,
}: {
  title: string;
  state: WidgetState;
  children: ReactNode;
  emptyText?: string;
  errorText?: string;
  style?: React.CSSProperties;
  /**
   * When set, the body wrapper caps at this height and scrolls vertically.
   * Useful for cards whose content is unbounded (e.g. ~30 scopes), so they
   * don't push the rest of the page down.
   */
  maxBodyHeight?: number | string;
  /** Optional content rendered on the right of the header (e.g. a count badge). */
  badge?: ReactNode;
}) {
  const bodyStyle: CSSProperties | undefined = maxBodyHeight
    ? { maxHeight: maxBodyHeight, overflowY: 'auto', overflowX: 'hidden', paddingRight: 4 }
    : undefined;
  return (
    <div
      style={{
        backgroundColor: 'var(--bg-card)',
        borderRadius: 10,
        border: '1px solid var(--border)',
        padding: 20,
        position: 'relative',
        overflow: maxBodyHeight ? 'visible' : 'hidden',
        ...style,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600 }}>{title}</h3>
        {badge != null && badge}
      </div>
      {state === 'loading' && !children && <Spinner />}
      {state === 'error' && (
        <p style={{ color: '#ef4444', fontSize: 13, textAlign: 'center', padding: 16 }}>{errorText}</p>
      )}
      {state === 'empty' && (
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center', padding: 16 }}>{emptyText}</p>
      )}
      {(state === 'loaded' || (state === 'loading' && children)) && (
        bodyStyle ? <div style={bodyStyle}>{children}</div> : children
      )}
    </div>
  );
}

/* ── Metric Card ── */

function MetricCard({
  label,
  value,
  sub,
  loading,
}: {
  label: string;
  value: string | number;
  sub?: string;
  loading?: boolean;
}) {
  return (
    <div
      style={{
        backgroundColor: 'var(--bg-card)',
        borderRadius: 10,
        border: '1px solid var(--border)',
        padding: 16,
        flex: 1,
        minWidth: 140,
      }}
    >
      <p
        style={{
          fontSize: 11,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 4,
        }}
      >
        {label}
      </p>
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', height: 32 }}>
          <div
            style={{
              width: 18,
              height: 18,
              border: '2px solid var(--border)',
              borderTopColor: 'var(--accent)',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
        </div>
      ) : (
        <>
          <p style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent)' }}>{value}</p>
          {sub && (
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</p>
          )}
        </>
      )}
    </div>
  );
}

/* ── Responsive Chart Wrappers ── */

const CHART_MIN_WIDTH = 300;

function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return { ref, width };
}

function TypeDistribution({ data }: { data: { name: string; value: number }[] }) {
  const { ref, width } = useContainerWidth();
  const maxVal = Math.max(...data.map(d => d.value));

  return (
    <div ref={ref}>
      {width >= CHART_MIN_WIDTH ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <ResponsiveContainer width="50%" height={180}>
            <PieChart>
              <Pie data={data} cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={3} dataKey="value">
                {data.map((entry, i) => (
                  <Cell key={entry.name} fill={TYPE_COLORS[entry.name] || PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} itemStyle={{ color: 'var(--text-primary)' }} labelStyle={{ color: 'var(--text-secondary)' }} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.map((entry, i) => (
              <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: TYPE_COLORS[entry.name] || PIE_COLORS[i % PIE_COLORS.length] }} />
                <span style={{ color: 'var(--text-secondary)' }}>{entry.name}</span>
                <span style={{ fontWeight: 600 }}>{entry.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.map((entry, i) => (
            <div key={entry.name}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: TYPE_COLORS[entry.name] || PIE_COLORS[i % PIE_COLORS.length] }} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{entry.name}</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{entry.value}</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, backgroundColor: 'var(--bg-input)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 3, width: `${(entry.value / maxVal) * 100}%`, backgroundColor: TYPE_COLORS[entry.name] || PIE_COLORS[i % PIE_COLORS.length] }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScopeDistribution({ data }: { data: { scope: string; count: number }[] }) {
  const { ref, width } = useContainerWidth();
  const pieData = data.map(d => ({ name: d.scope, value: d.count }));
  const maxVal = Math.max(...data.map(d => d.count));

  return (
    <div ref={ref}>
      {width >= CHART_MIN_WIDTH ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <ResponsiveContainer width="50%" height={180}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={3} dataKey="value">
                {pieData.map((entry, i) => (
                  <Cell key={entry.name} fill={SCOPE_COLORS[i % SCOPE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} itemStyle={{ color: 'var(--text-primary)' }} labelStyle={{ color: 'var(--text-secondary)' }} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pieData.map((entry, i) => (
              <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: SCOPE_COLORS[i % SCOPE_COLORS.length] }} />
                <span style={{ color: 'var(--text-secondary)' }}>{entry.name}</span>
                <span style={{ fontWeight: 600 }}>{entry.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.map((entry, i) => (
            <div key={entry.scope}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: SCOPE_COLORS[i % SCOPE_COLORS.length] }} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{entry.scope}</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{entry.count}</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, backgroundColor: 'var(--bg-input)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 3, width: `${(entry.count / maxVal) * 100}%`, backgroundColor: SCOPE_COLORS[i % SCOPE_COLORS.length] }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function TopTagsChart({ data }: { data: { tag: string; count: number }[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { ref, width } = useContainerWidth();
  const maxVal = Math.max(...data.map(d => d.count));
  const med = median(data.map(d => d.count));

  // Open the knowledge listing filtered by the clicked tag (HomePage reads ?tag=).
  const goToTag = (tag?: string) => {
    if (tag) navigate('/?tag=' + encodeURIComponent(tag));
  };

  return (
    <div ref={ref}>
      {width >= CHART_MIN_WIDTH ? (
        <ResponsiveContainer width="100%" height={Math.max(180, data.length * 28)}>
          <BarChart data={data} layout="vertical" margin={{ left: 60 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="tag" tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} width={80} />
            <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} itemStyle={{ color: 'var(--text-primary)' }} labelStyle={{ color: 'var(--text-secondary)' }} />
            {data.length >= 2 && (
              <ReferenceLine
                x={med}
                stroke="var(--text-secondary)"
                strokeDasharray="4 3"
                label={{ value: `${t('stats.median')} ${med}`, position: 'top', fontSize: 10, fill: 'var(--text-secondary)' }}
              />
            )}
            <Bar
              dataKey="count"
              fill="#8b5cf6"
              radius={[0, 4, 4, 0]}
              barSize={16}
              cursor="pointer"
              onClick={(d: any) => goToTag(d?.tag ?? d?.payload?.tag)}
            />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.map((entry) => (
            <div key={entry.tag} style={{ cursor: 'pointer' }} onClick={() => goToTag(entry.tag)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{entry.tag}</span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{entry.count}</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, backgroundColor: 'var(--bg-input)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 3, width: `${(entry.count / maxVal) * 100}%`, backgroundColor: '#8b5cf6' }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Horizontal bar chart for provenance (agent/platform). Bars are clickable and
 * deep-link to the knowledge list filtered by the clicked value — the chart
 * labels include the "unspecified"/"unknown" sentinels, which HomePage + the
 * repository round-trip back to NULL, so no special-casing is needed here.
 */
function ProvenanceChart({ data, color, linkParam }: { data: { name: string; count: number }[]; color: string; linkParam: 'agent' | 'platform' }) {
  const navigate = useNavigate();
  const { ref, width } = useContainerWidth();
  const maxVal = Math.max(...data.map((d) => d.count));

  const go = (name?: string) => {
    if (name) navigate(`/?${linkParam}=` + encodeURIComponent(name));
  };

  return (
    <div ref={ref}>
      {width >= CHART_MIN_WIDTH ? (
        <ResponsiveContainer width="100%" height={Math.max(160, data.length * 28)}>
          <BarChart data={data} layout="vertical" margin={{ left: 60 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="name" tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} width={90} />
            <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} itemStyle={{ color: 'var(--text-primary)' }} labelStyle={{ color: 'var(--text-secondary)' }} />
            <Bar
              dataKey="count"
              fill={color}
              radius={[0, 4, 4, 0]}
              barSize={16}
              cursor="pointer"
              onClick={(d: any) => go(d?.name ?? d?.payload?.name)}
            />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.map((entry) => (
            <div key={entry.name} style={{ cursor: 'pointer' }} onClick={() => go(entry.name)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{entry.name}</span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{entry.count}</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, backgroundColor: 'var(--bg-input)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 3, width: `${(entry.count / maxVal) * 100}%`, backgroundColor: color }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main Page ── */

export function StatsPage() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const lastTotalRef = useRef<number | null>(null);

  const {
    stats, statsState,
    metrics, metricsState,
    lastFetchedAt,
    isRefreshing,
  } = useAppSelector((s) => s.stats);

  const { range } = useAppSelector((s) => s.dateRange);
  const [rangedActivity, setRangedActivity] = useState<{ date: string; reads: number; writes: number }[]>([]);
  // The four "distribution" cards below also follow the global date range as of v1.4.0.
  const [rangedTopTags, setRangedTopTags] = useState<{ tag: string; count: number }[]>([]);
  const [distinctTagCount, setDistinctTagCount] = useState(0);
  const [rangedByType, setRangedByType] = useState<{ type: string; count: number }[]>([]);
  const [rangedByScope, setRangedByScope] = useState<{ scope: string; count: number }[]>([]);
  const [rangedByAgent, setRangedByAgent] = useState<{ agent: string; count: number }[]>([]);
  const [rangedByPlatform, setRangedByPlatform] = useState<{ platform: string; count: number }[]>([]);
  // cleanup moved to Settings page


  const refreshAll = useCallback(() => {
    dispatch(fetchStats());
    dispatch(fetchMetrics());
  }, [dispatch]);

  // Range-driven cards: activity, top-tags, distinct-tag count, by-type, by-scope
  useEffect(() => {
    let cancelled = false;
    const r = { from: range.from, to: range.to };
    api.getActivity(range.from, range.to)
      .then((res) => { if (!cancelled) setRangedActivity(res.operationsByDay); })
      .catch(() => { if (!cancelled) setRangedActivity([]); });
    api.getTopTags(10, r)
      .then((res) => { if (!cancelled) setRangedTopTags(res); })
      .catch(() => { if (!cancelled) setRangedTopTags([]); });
    api.listTags(r)
      .then((res) => { if (!cancelled) setDistinctTagCount(res.length); })
      .catch(() => { if (!cancelled) setDistinctTagCount(0); });
    api.getByType(r)
      .then((res) => { if (!cancelled) setRangedByType(res); })
      .catch(() => { if (!cancelled) setRangedByType([]); });
    api.getByScope(r)
      .then((res) => { if (!cancelled) setRangedByScope(res); })
      .catch(() => { if (!cancelled) setRangedByScope([]); });
    api.getByAgent(r)
      .then((res) => { if (!cancelled) setRangedByAgent(res); })
      .catch(() => { if (!cancelled) setRangedByAgent([]); });
    api.getByPlatform(r)
      .then((res) => { if (!cancelled) setRangedByPlatform(res); })
      .catch(() => { if (!cancelled) setRangedByPlatform([]); });
    return () => { cancelled = true; };
  }, [range.from, range.to]);

  // Initial fetch
  useEffect(() => {
    const hasCached = stats !== null || metrics !== null;
    if (!hasCached) {
      refreshAll();
    } else {
      // Background refresh if data exists
      refreshAll();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll every 5s
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const data = await api.getStats() as { total: number };
        if (lastTotalRef.current !== null && data.total !== lastTotalRef.current) {
          refreshAll();
        }
        lastTotalRef.current = data.total;
      } catch { /* ignore polling errors */ }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshAll]);

  // Never show blocking loading — always treat as loaded or empty
  const rangedTypeData = rangedByType.map((t) => ({
    name: t.type ? t.type.charAt(0).toUpperCase() + t.type.slice(1) : 'Unknown',
    value: t.count,
  }));
  const hasTypeData = rangedTypeData.length > 0;
  const hasScopeData = rangedByScope.length > 0;
  const agentChartData = rangedByAgent.map((a) => ({ name: a.agent, count: a.count }));
  const platformChartData = rangedByPlatform.map((p) => ({ name: p.platform, count: p.count }));
  const hasAgentData = agentChartData.length > 0;
  const hasPlatformData = platformChartData.length > 0;
  const hasActivityData = rangedActivity.some((d) => d.reads + d.writes > 0);
  const hasTopTags = rangedTopTags.length > 0;
  // Silence unused warnings — `metrics` and `stats.byScope` are still
  // populated by polling for the Total Entries card and future consumers.
  void metrics; void stats?.byScope;

  return (
    <div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>{t('statsTitle.knowledge')}</h1>
          {isRefreshing && (
            <div
              style={{
                width: 14,
                height: 14,
                border: '2px solid var(--border)',
                borderTopColor: 'var(--accent)',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }}
            />
          )}
        </div>
        <DateRangePicker />
      </div>

      {/* ── Total Entries (range-independent) ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <MetricCard label={t('stats.totalEntries')} value={stats?.total ?? 0} />
      </div>

      {/* ── Consulted / Written (range-dependent, reflects the selected period) ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <MetricCard
          label={t('stats.consulted')}
          value={rangedActivity.reduce((s, d) => s + d.reads, 0)}
          sub={t('stats.consultedSub')}
        />
        <MetricCard
          label={t('stats.written')}
          value={rangedActivity.reduce((s, d) => s + d.writes, 0)}
          sub={t('stats.writtenSub')}
        />
      </div>

      {/* ── Charts Row (range-driven as of v1.4.0) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
        {/* Type Distribution */}
        <WidgetCard
          title={`${t('stats.knowledgeByType')} ${t('stats.thisPeriod')}`}
          state={hasTypeData ? 'loaded' : 'empty'}
          emptyText={t('stats.noData')}
          maxBodyHeight={380}
        >
          {hasTypeData && <TypeDistribution data={rangedTypeData} />}
        </WidgetCard>

        {/* Scope Distribution */}
        <WidgetCard
          title={`${t('stats.knowledgeByScope')} ${t('stats.thisPeriod')}`}
          state={hasScopeData ? 'loaded' : 'empty'}
          emptyText={t('stats.noData')}
          maxBodyHeight={380}
        >
          {hasScopeData && <ScopeDistribution data={rangedByScope} />}
        </WidgetCard>
      </div>

      {/* ── Provenance Row: who created the knowledge (agent + platform) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
        {/* Agent Distribution (clickable → filtered knowledge list) */}
        <WidgetCard
          title={`${t('stats.knowledgeByAgent')} ${t('stats.thisPeriod')}`}
          state={hasAgentData ? 'loaded' : 'empty'}
          emptyText={t('stats.noData')}
          maxBodyHeight={380}
        >
          {hasAgentData && <ProvenanceChart data={agentChartData} color="#06b6d4" linkParam="agent" />}
        </WidgetCard>

        {/* Platform Distribution (clickable → filtered knowledge list) */}
        <WidgetCard
          title={`${t('stats.knowledgeByPlatform')} ${t('stats.thisPeriod')}`}
          state={hasPlatformData ? 'loaded' : 'empty'}
          emptyText={t('stats.noData')}
          maxBodyHeight={380}
        >
          {hasPlatformData && <ProvenanceChart data={platformChartData} color="#ec4899" linkParam="platform" />}
        </WidgetCard>
      </div>

      {/* ── Activity Chart (driven by global range) ── */}
      <WidgetCard
        title={t('stats.activity')}
        state={hasActivityData ? 'loaded' : 'empty'}
        emptyText={t('stats.noActivity')}
        style={{ marginBottom: 24 }}
      >
        {rangedActivity.length > 0 && (() => {
          const chartData = rangedActivity.map((d) => ({
            date: d.date,
            total: d.reads + d.writes,
            reads: d.reads,
            writes: d.writes,
          }));
          return (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData}>
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
                  {...dateAxisProps(chartData.length)}
                />
                <YAxis hide />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  itemStyle={{ color: 'var(--text-primary)' }}
                  labelStyle={{ color: 'var(--text-secondary)' }}
                  labelFormatter={(v) => `${t('stats.dateLabel')}: ${v}`}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, color: 'var(--text-secondary)' }}
                />
                <Line type="monotone" dataKey="total" name={t('stats.totalLine')} stroke="#8b5cf6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="reads" name={t('stats.consultedLine')} stroke="#3b82f6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="writes" name={t('stats.writtenLine')} stroke="#22c55e" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          );
        })()}
      </WidgetCard>

      {/* ── Top Tags (range-driven, full width) ── */}
      <WidgetCard
        title={`${t('stats.topTags')} ${t('stats.thisPeriod')}`}
        state={hasTopTags ? 'loaded' : 'empty'}
        emptyText={t('stats.noTags')}
        maxBodyHeight={380}
        style={{ marginBottom: 24 }}
        badge={
          distinctTagCount > 0 ? (
            <span
              style={{
                backgroundColor: 'var(--bg-input)',
                color: 'var(--text-secondary)',
                padding: '2px 10px',
                borderRadius: 12,
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {`${distinctTagCount} ${t('stats.distinctTags')}`}
            </span>
          ) : undefined
        }
      >
        {hasTopTags && <TopTagsChart data={rangedTopTags} />}
      </WidgetCard>

    </div>
  );
}

/* ── Plan Analytics Section ── */

const PLAN_STATUS_COLORS: Record<string, string> = {
  Draft: '#6b7280', Active: '#3b82f6', Completed: '#22c55e', Archived: '#a78bfa',
};

const TASK_STATUS_COLORS: Record<string, string> = {
  Pending: '#6b7280', 'In Progress': '#3b82f6', Completed: '#22c55e',
};

export function PlanStatsPage() {
  const { t } = useTranslation();
  const { range } = useAppSelector((s) => s.dateRange);
  const [data, setData] = useState<{
    plans: { total: number; draft: number; active: number; completed: number; archived: number };
    tasks: { total: number; pending: number; inProgress: number; completed: number; avgPerPlan: number };
    plansByDay: { date: string; count: number }[];
  } | null>(null);

  useEffect(() => {
    api.getPlanMetrics(range.from, range.to).then(setData).catch(() => {});
  }, [range.from, range.to]);

  if (!data) return <div style={{ color: 'var(--text-secondary)' }}>{t('stats.loading')}</div>;
  if (data.plans.total === 0) return <div style={{ color: 'var(--text-secondary)' }}>{t('stats.noPlanData')}</div>;

  const planDistribution = [
    { name: 'Draft', value: data.plans.draft },
    { name: 'Active', value: data.plans.active },
    { name: 'Completed', value: data.plans.completed },
    { name: 'Archived', value: data.plans.archived },
  ].filter((d) => d.value > 0);

  const taskDistribution = [
    { name: 'Pending', value: data.tasks.pending },
    { name: 'In Progress', value: data.tasks.inProgress },
    { name: 'Completed', value: data.tasks.completed },
  ].filter((d) => d.value > 0);

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24 }}>
        {t('statsTitle.plans')}
      </h1>

      {/* Plan Metric Cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <MetricCard label={t('stats.totalPlans')} value={data.plans.total} />
        <MetricCard label={t('stats.activePlans')} value={data.plans.active} />
        <MetricCard label={t('stats.completedPlans')} value={data.plans.completed} />
        <MetricCard label={t('stats.avgTasksPerPlan')} value={data.tasks.avgPerPlan} />
      </div>

      {/* Plan Charts */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        {/* Plan Status Distribution */}
        {planDistribution.length > 0 && (
          <WidgetCard title={t('stats.planStatus')} state="loaded" style={{ flex: 1, minWidth: 200 }}>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={planDistribution} cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={planDistribution.length > 1 ? 3 : 0} stroke="none" startAngle={90} endAngle={-270} dataKey="value" label={({ name, value, cx, cy, midAngle, outerRadius: or }) => {
                  if (planDistribution.length <= 1) return null;
                  const RADIAN = Math.PI / 180;
                  const radius = or + 16;
                  const x = cx + radius * Math.cos(-midAngle * RADIAN);
                  const y = cy + radius * Math.sin(-midAngle * RADIAN);
                  return <text x={x} y={y} fill="var(--text-secondary)" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" fontSize={10}>{value}</text>;
                }}>
                  {planDistribution.map((d) => (
                    <Cell key={d.name} fill={PLAN_STATUS_COLORS[d.name] || '#6b7280'} />
                  ))}
                  <Label value={data.plans.total} position="center" fill="var(--text-primary)" fontSize={20} fontWeight={700} />
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary)' }}
                  itemStyle={{ color: 'var(--text-primary)' }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              {planDistribution.map((d) => (
                <span key={d.name} style={{ fontSize: 10, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: PLAN_STATUS_COLORS[d.name] }} />
                  {d.name}: {d.value}
                </span>
              ))}
            </div>
          </WidgetCard>
        )}

        {/* Task Completion Rate */}
        {taskDistribution.length > 0 && (
          <WidgetCard title={t('stats.taskStatus')} state="loaded" style={{ flex: 1, minWidth: 200 }}>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={taskDistribution} cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={taskDistribution.length > 1 ? 3 : 0} stroke="none" startAngle={90} endAngle={-270} dataKey="value" label={({ name, value, cx, cy, midAngle, outerRadius: or }) => {
                  if (taskDistribution.length <= 1) return null;
                  const RADIAN = Math.PI / 180;
                  const radius = or + 16;
                  const x = cx + radius * Math.cos(-midAngle * RADIAN);
                  const y = cy + radius * Math.sin(-midAngle * RADIAN);
                  return <text x={x} y={y} fill="var(--text-secondary)" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" fontSize={10}>{value}</text>;
                }}>
                  {taskDistribution.map((d) => (
                    <Cell key={d.name} fill={TASK_STATUS_COLORS[d.name] || '#6b7280'} />
                  ))}
                  <Label value={data.tasks.total} position="center" fill="var(--text-primary)" fontSize={20} fontWeight={700} />
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary)' }}
                  itemStyle={{ color: 'var(--text-primary)' }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              {taskDistribution.map((d) => (
                <span key={d.name} style={{ fontSize: 10, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: TASK_STATUS_COLORS[d.name] }} />
                  {d.name}: {d.value}
                </span>
              ))}
            </div>
          </WidgetCard>
        )}
      </div>

      {/* Plans Activity Chart */}
      {data.plansByDay.some((d) => d.count > 0) && (
        <WidgetCard title={t('stats.plansActivity')} state="loaded">
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={data.plansByDay}>
              <XAxis dataKey="date" {...dateAxisProps(data.plansByDay.length)} tick={{ fill: 'var(--text-secondary)', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fill: 'var(--text-secondary)', fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary)' }}
                itemStyle={{ color: 'var(--text-primary)' }}
                labelStyle={{ color: 'var(--text-primary)' }}
              />
              <Area type="monotone" dataKey="count" stroke="#3b82f6" fill="#3b82f620" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </WidgetCard>
      )}
    </div>
  );
}
