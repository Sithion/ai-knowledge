import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { useAppDispatch, useAppSelector } from '../store/index.js';
import {
  hydrateRange,
  rangeForPreset,
  setCustomRange,
  setPreset,
  type DateRangePreset,
} from '../store/dateRange.js';
import { api } from '../api/client.js';

const PRESETS: { key: Exclude<DateRangePreset, 'custom'>; labelKey: string }[] = [
  { key: '1d', labelKey: 'dateRange.1d' },
  { key: '1w', labelKey: 'dateRange.1w' },
  { key: '1m', labelKey: 'dateRange.1m' },
  { key: '1y', labelKey: 'dateRange.1y' },
];

function formatLabel(from: string, to: string): string {
  const f = new Date(from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const t = new Date(to).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${f} – ${t}`;
}

/** Single shared picker. Persists choice to ~/.cognistore/settings.json. */
export function DateRangePicker() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const { preset, range } = useAppSelector((s) => s.dateRange);
  const [openCalendar, setOpenCalendar] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);

  // Hydrate once from server settings.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    api.getSettings()
      .then((s) => dispatch(hydrateRange({ preset: s.dateRangePreset, range: s.lastSelectedRange })))
      .catch(() => { /* fall back to defaults */ });
  }, [dispatch]);

  // Close popover on outside click.
  useEffect(() => {
    if (!openCalendar) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpenCalendar(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [openCalendar]);

  const applyPreset = (key: Exclude<DateRangePreset, 'custom'>) => {
    dispatch(setPreset(key));
    const r = rangeForPreset(key);
    void api.updateSettings({ dateRangePreset: key, lastSelectedRange: null }).catch(() => {});
    void r; // tracked for completeness; range comes from the slice
  };

  const applyCustom = (from: Date, to: Date) => {
    const fromISO = new Date(from);
    fromISO.setHours(0, 0, 0, 0);
    const toISO = new Date(to);
    toISO.setHours(23, 59, 59, 999);
    const r = { from: fromISO.toISOString(), to: toISO.toISOString() };
    dispatch(setCustomRange(r));
    void api.updateSettings({ dateRangePreset: 'custom', lastSelectedRange: r }).catch(() => {});
    setOpenCalendar(false);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
      {PRESETS.map(({ key, labelKey }) => {
        const active = preset === key;
        return (
          <button
            key={key}
            onClick={() => applyPreset(key)}
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
      <button
        onClick={() => setOpenCalendar((v) => !v)}
        style={{
          padding: '6px 12px',
          borderRadius: 6,
          border: `1px solid ${preset === 'custom' ? 'var(--accent)' : 'var(--border)'}`,
          backgroundColor: preset === 'custom' ? 'var(--accent)' : 'var(--bg-card)',
          color: preset === 'custom' ? '#fff' : 'var(--text-primary)',
          fontSize: 12,
          fontWeight: preset === 'custom' ? 600 : 500,
          cursor: 'pointer',
        }}
      >
        {preset === 'custom' ? formatLabel(range.from, range.to) : t('dateRange.custom')}
      </button>

      {openCalendar && (
        <div
          ref={popoverRef}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 1000,
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          }}
        >
          <DayPicker
            mode="range"
            defaultMonth={new Date(range.from)}
            selected={{ from: new Date(range.from), to: new Date(range.to) }}
            onSelect={(r) => { if (r?.from && r?.to) applyCustom(r.from, r.to); }}
            numberOfMonths={2}
          />
        </div>
      )}
    </div>
  );
}
