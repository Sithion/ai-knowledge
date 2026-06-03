import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import { api } from '../api/client.js';

/* ── Types ── */

interface Stats {
  total: number;
  byType: { type: string; count: number }[];
  byScope: { scope: string; count: number }[];
}

interface Metrics {
  database: { sizeBytes: number; sizeFormatted: string; path: string };
  activity: { last24h: number; last7d: number; last30d: number; total: number };
  activityByDay: { date: string; count: number }[];
  typeDistribution: { name: string; value: number }[];
  operations: { readsLastHour: number; readsLastDay: number; writesLastHour: number; writesLastDay: number };
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'empty' | 'error';

export type RefreshInterval = 0 | 1 | 10 | 30 | 60 | 300;

export const REFRESH_OPTIONS: { label: string; value: RefreshInterval }[] = [
  { label: 'Off', value: 0 },
  { label: '1s', value: 1 },
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '5m', value: 300 },
];

interface StatsState {
  stats: Stats | null;
  statsState: LoadState;
  metrics: Metrics | null;
  metricsState: LoadState;
  lastFetchedAt: number | null;
  /** Whether any fetch is currently in-flight (for the header indicator) */
  isRefreshing: boolean;
  /** Auto-refresh interval in seconds (0 = off) */
  refreshInterval: RefreshInterval;
}

const initialState: StatsState = {
  stats: null,
  statsState: 'idle',
  metrics: null,
  metricsState: 'idle',
  lastFetchedAt: null,
  isRefreshing: false,
  refreshInterval: 30,
};

/* ── Thunks ── */

export const fetchStats = createAsyncThunk(
  'stats/fetchStats',
  async (_, { rejectWithValue }) => {
    let attempt = 0;
    while (attempt < 3) {
      try {
        attempt++;
        const data = await api.getStats();
        return data as Stats;
      } catch {
        if (attempt >= 3) return rejectWithValue('Failed after 3 attempts');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  },
);

export const fetchMetrics = createAsyncThunk(
  'stats/fetchMetrics',
  async (_, { rejectWithValue }) => {
    let attempt = 0;
    while (attempt < 3) {
      try {
        attempt++;
        const data = await api.getMetrics();
        return data as Metrics;
      } catch {
        if (attempt >= 3) return rejectWithValue('Failed after 3 attempts');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  },
);

/* ── Slice ── */

const statsSlice = createSlice({
  name: 'stats',
  initialState,
  reducers: {
    setRefreshInterval(state, action: PayloadAction<RefreshInterval>) {
      state.refreshInterval = action.payload;
    },
  },
  extraReducers: (builder) => {
    // Stats
    builder
      .addCase(fetchStats.pending, (state) => {
        if (!state.stats) state.statsState = 'loading';
        state.isRefreshing = true;
      })
      .addCase(fetchStats.fulfilled, (state, action) => {
        state.stats = action.payload ?? null;
        state.statsState = action.payload && action.payload.total > 0 ? 'loaded' : 'empty';
        state.lastFetchedAt = Date.now();
        state.isRefreshing = false;
      })
      .addCase(fetchStats.rejected, (state) => {
        if (!state.stats) {
          state.stats = { total: 0, byType: [], byScope: [] };
          state.statsState = 'empty';
        }
        state.isRefreshing = false;
      });

    // Metrics
    builder
      .addCase(fetchMetrics.pending, (state) => {
        if (!state.metrics) state.metricsState = 'loading';
        state.isRefreshing = true;
      })
      .addCase(fetchMetrics.fulfilled, (state, action) => {
        state.metrics = action.payload ?? null;
        state.metricsState = 'loaded';
        state.isRefreshing = false;
      })
      .addCase(fetchMetrics.rejected, (state) => {
        if (!state.metrics) state.metricsState = 'error';
        state.isRefreshing = false;
      });
  },
});

export const { setRefreshInterval } = statsSlice.actions;
export const statsReducer = statsSlice.reducer;
