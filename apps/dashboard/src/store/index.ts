import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import { statsReducer } from './statsSlice.js';
import { dateRangeReducer } from './dateRange.js';

export const store = configureStore({
  reducer: {
    stats: statsReducer,
    dateRange: dateRangeReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
