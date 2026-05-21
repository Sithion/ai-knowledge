import { useEffect, useRef, useState, type ReactNode } from 'react';

export type WidgetState = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

export function Spinner({ size = 24 }: { size?: number }) {
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

export function WidgetCard({
  title,
  state,
  children,
  emptyText = '',
  errorText = '',
  style,
  right,
}: {
  title: string;
  state: WidgetState;
  children: ReactNode;
  emptyText?: string;
  errorText?: string;
  style?: React.CSSProperties;
  right?: ReactNode;
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
        {right}
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

export function MetricCard({
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

export function getHeatmapColor(count: number, maxCount: number): string {
  if (count === 0) return 'var(--bg-input)';
  const intensity = Math.min(count / Math.max(maxCount, 1), 1);
  if (intensity <= 0.25) return '#0e4429';
  if (intensity <= 0.5) return '#006d32';
  if (intensity <= 0.75) return '#26a641';
  return '#39d353';
}

export function useContainerWidth() {
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

export const CHART_MIN_WIDTH = 300;

/** Format a token count with k/M suffixes for compact display. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
