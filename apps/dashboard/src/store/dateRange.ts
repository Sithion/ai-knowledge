import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type DateRangePreset = '1d' | '1w' | '1m' | '1y' | 'custom';

export interface DateRange {
  from: string;
  to: string;
}

interface DateRangeState {
  preset: DateRangePreset;
  range: DateRange;
}

/** Inclusive range ending at "now" for a preset. */
export function rangeForPreset(preset: Exclude<DateRangePreset, 'custom'>): DateRange {
  const to = new Date();
  const from = new Date(to);
  switch (preset) {
    case '1d': from.setDate(from.getDate() - 1); break;
    case '1w': from.setDate(from.getDate() - 7); break;
    case '1m': from.setMonth(from.getMonth() - 1); break;
    case '1y': from.setFullYear(from.getFullYear() - 1); break;
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

const initialState: DateRangeState = {
  preset: '1w',
  range: rangeForPreset('1w'),
};

const dateRangeSlice = createSlice({
  name: 'dateRange',
  initialState,
  reducers: {
    setPreset(state, action: PayloadAction<Exclude<DateRangePreset, 'custom'>>) {
      state.preset = action.payload;
      state.range = rangeForPreset(action.payload);
    },
    setCustomRange(state, action: PayloadAction<DateRange>) {
      state.preset = 'custom';
      state.range = action.payload;
    },
    hydrateRange(state, action: PayloadAction<{ preset: DateRangePreset; range: DateRange | null }>) {
      const { preset, range } = action.payload;
      state.preset = preset;
      if (preset === 'custom' && range) {
        state.range = range;
      } else if (preset !== 'custom') {
        state.range = rangeForPreset(preset);
      }
    },
  },
});

export const { setPreset, setCustomRange, hydrateRange } = dateRangeSlice.actions;
export const dateRangeReducer = dateRangeSlice.reducer;
