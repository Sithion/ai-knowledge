/**
 * Shared X-axis props for daily date-series charts (dates are 'YYYY-MM-DD').
 * - <= 60 points: recharts' own thinning ('preserveStartEnd'), MM-DD labels.
 * - >  60 points: explicit interval targeting ~12 ticks so a 730-point series
 *   doesn't overlap.
 * - > 365 points: labels switch to YYYY-MM so multi-year ranges stay
 *   unambiguous. Tooltips are unaffected — they render the raw datum
 *   ('YYYY-MM-DD'), which already includes the year.
 */
export function dateAxisProps(pointCount: number): {
  interval: number | 'preserveStartEnd';
  tickFormatter: (v: string) => string;
} {
  return {
    interval: pointCount > 60 ? Math.max(1, Math.ceil(pointCount / 12) - 1) : 'preserveStartEnd',
    tickFormatter: (v: string) => (pointCount > 365 ? v.slice(0, 7) : v.slice(5)),
  };
}
