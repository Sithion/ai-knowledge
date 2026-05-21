import { useEffect, useRef, useState, useCallback, type ReactNode, type CSSProperties } from 'react';
import { api } from '../api/client.js';
import { useTranslation } from 'react-i18next';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Label,
  AreaChart, Area, ResponsiveContainer, Legend, Line, LineChart,
} from 'recharts';
import { useAppDispatch, useAppSelector } from '../store/index.js';
import { fetchStats, fetchMetrics, fetchTags } from '../store/statsSlice.js';
import { DateRangePicker } from '../components/DateRangePicker.js';

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
}: {
  title: string;
  state: WidgetState;
  children: ReactNode;
  emptyText?: string;
  errorText?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        backgroundColor: 'var(--bg-card)',
        borderRadius: 10,
        border: '1px solid var(--border)',
        padding: 20,
        position: 'relative',
        overflow: 'hidden',
        ...style,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600 }}>{title}</h3>
      </div>
      {state === 'loading' && !children && <Spinner />}
      {state === 'error' && (
        <p style={{ color: '#ef4444', fontSize: 13, textAlign: 'center', padding: 16 }}>{errorText}</p>
      )}
      {state === 'empty' && (
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center', padding: 16 }}>{emptyText}</p>
      )}
      {(state === 'loaded' || (state === 'loading' && children)) && children}
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

/* ── Heatmap ── */

function getHeatmapColor(count: number, maxCount: number): string {
  if (count === 0) return 'var(--bg-input)';
  const intensity = Math.min(count / Math.max(maxCount, 1), 1);
  if (intensity <= 0.25) return '#0e4429';
  if (intensity <= 0.5) return '#006d32';
  if (intensity <= 0.75) return '#26a641';
  return '#39d353';
}

function ContributionHeatmap({ data }: { data: { date: string; count: number }[] }) {
  const { t } = useTranslation();
  const maxCount = Math.max(...data.map((d) => d.count), 1);

  const weeks: { date: string; count: number; day: number }[][] = [];
  let currentWeek: { date: string; count: number; day: number }[] = [];

  for (const item of data) {
    const d = new Date(item.date);
    const day = d.getDay();
    if (day === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push({ ...item, day });
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  if (weeks.length > 0) {
    const firstDay = weeks[0][0]?.day ?? 0;
    for (let i = 0; i < firstDay; i++) {
      weeks[0].unshift({ date: '', count: -1, day: i });
    }
  }

  const cellSize = 12;
  const gap = 3;
  const dayLabels = ['Sun', '', 'Tue', '', 'Thu', '', 'Sat'];

  const monthLabels: { label: string; col: number }[] = [];
  let lastMonth = '';
  for (let w = 0; w < weeks.length; w++) {
    for (const cell of weeks[w]) {
      if (cell.date) {
        const month = cell.date.slice(0, 7);
        if (month !== lastMonth) {
          const d = new Date(cell.date);
          monthLabels.push({ label: d.toLocaleString('en', { month: 'short' }), col: w });
          lastMonth = month;
        }
        break;
      }
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', marginLeft: 28, marginBottom: 4, gap: 0 }}>
        {monthLabels.map((m, i) => (
          <span
            key={i}
            style={{
              fontSize: 10,
              color: 'var(--text-secondary)',
              position: 'relative',
              left: m.col * (cellSize + gap),
            }}
          >
            {m.label}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap, marginRight: 4, width: 24 }}>
          {dayLabels.map((label, i) => (
            <div
              key={i}
              style={{
                height: cellSize,
                fontSize: 9,
                color: 'var(--text-secondary)',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {label}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap }}>
          {weeks.map((week, wi) => (
            <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap }}>
              {week.map((cell, di) => (
                <div
                  key={di}
                  title={cell.count >= 0 ? `${cell.date}: ${cell.count} entries` : ''}
                  style={{
                    width: cellSize,
                    height: cellSize,
                    borderRadius: 2,
                    backgroundColor:
                      cell.count < 0 ? 'transparent' : getHeatmapColor(cell.count, maxCount),
                    cursor: cell.count >= 0 ? 'pointer' : 'default',
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8, marginLeft: 28 }}>
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginRight: 4 }}>{t('stats.less')}</span>
        {[0, 0.25, 0.5, 0.75, 1].map((level, i) => (
          <div
            key={i}
            style={{
              width: cellSize,
              height: cellSize,
              borderRadius: 2,
              backgroundColor:
                level === 0 ? 'var(--bg-input)' : getHeatmapColor(level * maxCount, maxCount),
            }}
          />
        ))}
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 4 }}>{t('stats.more')}</span>
      </div>
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

function TopTagsChart({ data }: { data: { tag: string; count: number }[] }) {
  const { ref, width } = useContainerWidth();
  const maxVal = Math.max(...data.map(d => d.count));

  return (
    <div ref={ref}>
      {width >= CHART_MIN_WIDTH ? (
        <ResponsiveContainer width="100%" height={Math.max(180, data.length * 28)}>
          <BarChart data={data} layout="vertical" margin={{ left: 60 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="tag" tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} width={80} />
            <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} itemStyle={{ color: 'var(--text-primary)' }} labelStyle={{ color: 'var(--text-secondary)' }} />
            <Bar dataKey="count" fill="#8b5cf6" radius={[0, 4, 4, 0]} barSize={16} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.map((entry) => (
            <div key={entry.tag}>
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

/* ── Main Page ── */

export function StatsPage() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const lastTotalRef = useRef<number | null>(null);

  const {
    stats, statsState,
    metrics, metricsState,
    tags, tagsState,
    lastFetchedAt,
    isRefreshing,
  } = useAppSelector((s) => s.stats);

  const [topTags, setTopTags] = useState<{ tag: string; count: number }[]>([]);
  const { range } = useAppSelector((s) => s.dateRange);
  const [rangedActivity, setRangedActivity] = useState<{ date: string; reads: number; writes: number }[]>([]);
  const [rangedHeatmap, setRangedHeatmap] = useState<{ date: string; count: number }[]>([]);
  // cleanup moved to Settings page


  const loadTopTags = useCallback(() => {
    api.getTopTags(10).then(setTopTags).catch(() => {});
  }, []);

  const refreshAll = useCallback(() => {
    dispatch(fetchStats());
    dispatch(fetchMetrics());
    dispatch(fetchTags());
    loadTopTags();
  }, [dispatch, loadTopTags]);

  // Range-driven activity + contributions
  useEffect(() => {
    let cancelled = false;
    api.getActivity(range.from, range.to)
      .then((r) => { if (!cancelled) setRangedActivity(r.operationsByDay); })
      .catch(() => { if (!cancelled) setRangedActivity([]); });
    api.getContributions(range.from, range.to)
      .then((r) => { if (!cancelled) setRangedHeatmap(r.heatmap); })
      .catch(() => { if (!cancelled) setRangedHeatmap([]); });
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
  const hasTypeData = metrics && metrics.typeDistribution.length > 0;
  const hasScopeData = stats && stats.byScope.length > 0;
  const hasActivityData = rangedActivity.some((d) => d.reads + d.writes > 0);
  const hasHeatmap = rangedHeatmap.length > 0;
  const hasTags = tags.length > 0;

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

      {/* ── Total Entries (only metric card that stays) ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <MetricCard label={t('stats.totalEntries')} value={stats?.total ?? 0} />
      </div>

      {/* ── Charts Row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
        {/* Type Distribution */}
        <WidgetCard title={t('stats.knowledgeByType')} state={hasTypeData ? 'loaded' : 'empty'}>
          {metrics && metrics.typeDistribution.length > 0 && (
            <TypeDistribution data={metrics.typeDistribution} />
          )}
        </WidgetCard>

        {/* Scope Distribution */}
        <WidgetCard title={t('stats.knowledgeByScope')} state={hasScopeData ? 'loaded' : 'empty'}>
          {stats && stats.byScope.length > 0 && (
            <ScopeDistribution data={stats.byScope} />
          )}
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
                  tickFormatter={(v) => v.slice(5)}
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

      {/* ── Contribution Heatmap + Top Tags ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
        <WidgetCard
          title={t('stats.contributions')}
          state={hasHeatmap ? 'loaded' : 'empty'}
        >
          {hasHeatmap && <ContributionHeatmap data={rangedHeatmap} />}
        </WidgetCard>

        <WidgetCard
          title={t('stats.topTags')}
          state={topTags.length > 0 ? 'loaded' : 'empty'}
          emptyText={t('stats.noTags')}
        >
          {topTags.length > 0 && <TopTagsChart data={topTags} />}
        </WidgetCard>
      </div>

      {/* ── Tag Cloud ── */}
      <WidgetCard title={t('stats.tagCloud')} state={hasTags ? 'loaded' : 'empty'}>
        {tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {tags.slice(0, 30).map((tag, i) => (
              <span
                key={tag}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  color: 'var(--accent)',
                  padding: '4px 12px',
                  borderRadius: 14,
                  fontSize: 11 + (i % 3) * 3,
                  fontWeight: i % 2 === 0 ? 600 : 400,
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
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
  const [data, setData] = useState<{
    plans: { total: number; draft: number; active: number; completed: number; archived: number };
    tasks: { total: number; pending: number; inProgress: number; completed: number; avgPerPlan: number };
    plansByDay: { date: string; count: number }[];
  } | null>(null);

  useEffect(() => {
    api.getPlanMetrics().then(setData).catch(() => {});
  }, []);

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
        <WidgetCard title={t('stats.plansActivity15d')} state="loaded">
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={data.plansByDay}>
              <XAxis dataKey="date" tickFormatter={(v) => v.slice(5)} tick={{ fill: 'var(--text-secondary)', fontSize: 10 }} axisLine={false} tickLine={false} />
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
