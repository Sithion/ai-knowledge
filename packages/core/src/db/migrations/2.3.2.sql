-- v2.3.2: durable Activity-chart history.
-- The dashboard Activity chart used to aggregate the raw operations_log table,
-- which is hard-DELETE-pruned by cleanupOldOperations() every 6h. Pruned days
-- then rendered as Total=0 (zero-fill), silently losing history. This permanent,
-- never-pruned daily rollup decouples the chart from the prunable raw log —
-- mirroring token_usage's keep-forever model. Backfill from the raw rows that
-- still survive so recent history is preserved across the cutover.
CREATE TABLE IF NOT EXISTS operations_daily (
  date   TEXT PRIMARY KEY,
  reads  INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO operations_daily (date, reads, writes)
  SELECT date(created_at),
         SUM(CASE WHEN operation = 'read'  THEN 1 ELSE 0 END),
         SUM(CASE WHEN operation = 'write' THEN 1 ELSE 0 END)
  FROM operations_log
  WHERE date(created_at) IS NOT NULL
  GROUP BY date(created_at)
  ON CONFLICT(date) DO UPDATE SET reads = excluded.reads, writes = excluded.writes;
