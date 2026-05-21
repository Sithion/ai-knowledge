import type { SQLiteDatabase } from '../db/client.js';
import type {
  ScanState,
  TokenUsageByDay,
  TokenUsageByHourDay,
  TokenUsageByModel,
  TokenUsageByProject,
  TokenUsageFilter,
  TokenUsageRecord,
  TokenUsageTotals,
  TopSession,
} from '../services/token-usage/types.js';

const RANGE_CLAUSE = 'occurred_at >= ? AND occurred_at <= ?';

function applyOptionalFilters(filter: TokenUsageFilter): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [filter.from, filter.to];
  let sql = RANGE_CLAUSE;
  if (filter.source) { sql += ' AND source = ?'; params.push(filter.source); }
  if (filter.model)  { sql += ' AND model = ?';  params.push(filter.model);  }
  if (filter.project){ sql += ' AND project = ?';params.push(filter.project);}
  return { sql, params };
}

export class TokenUsageRepository {
  constructor(private readonly sqlite: SQLiteDatabase) {}

  // ─── Writes ────────────────────────────────────────────────────

  /** Insert if new; never throw on conflict (deterministic id makes this idempotent). */
  insertMany(records: TokenUsageRecord[]): number {
    if (records.length === 0) return 0;
    const stmt = this.sqlite.prepare(`
      INSERT OR IGNORE INTO token_usage
        (id, source, model, project, session_id, message_id, occurred_at,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const scannedAt = new Date().toISOString();
    const tx = this.sqlite.transaction((rows: TokenUsageRecord[]) => {
      let inserted = 0;
      for (const r of rows) {
        const info = stmt.run(
          r.id, r.source, r.model, r.project, r.sessionId, r.messageId, r.occurredAt,
          r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, scannedAt,
        );
        if (info.changes > 0) inserted++;
      }
      return inserted;
    });
    return tx(records);
  }

  // ─── Scan state ────────────────────────────────────────────────

  getScanState(source: string, filePath: string): ScanState | undefined {
    const row = this.sqlite.prepare(`
      SELECT source, file_path as filePath, last_offset as lastOffset, last_mtime as lastMtime
      FROM scan_state WHERE source = ? AND file_path = ?
    `).get(source, filePath) as ScanState | undefined;
    return row;
  }

  upsertScanState(state: ScanState): void {
    this.sqlite.prepare(`
      INSERT INTO scan_state (source, file_path, last_offset, last_mtime, last_scanned_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source, file_path) DO UPDATE SET
        last_offset = excluded.last_offset,
        last_mtime = excluded.last_mtime,
        last_scanned_at = excluded.last_scanned_at
    `).run(state.source, state.filePath, state.lastOffset, state.lastMtime, new Date().toISOString());
  }

  // ─── Aggregations ──────────────────────────────────────────────

  totals(filter: TokenUsageFilter): TokenUsageTotals {
    const { sql, params } = applyOptionalFilters(filter);
    const row = this.sqlite.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0)          as inputTokens,
        COALESCE(SUM(output_tokens), 0)         as outputTokens,
        COALESCE(SUM(cache_read_tokens), 0)     as cacheReadTokens,
        COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens
      FROM token_usage WHERE ${sql}
    `).get(...params) as TokenUsageTotals;
    return row;
  }

  byDay(filter: TokenUsageFilter): TokenUsageByDay[] {
    const { sql, params } = applyOptionalFilters(filter);
    const rows = this.sqlite.prepare(`
      SELECT
        date(occurred_at) as date,
        COALESCE(SUM(input_tokens), 0)          as inputTokens,
        COALESCE(SUM(output_tokens), 0)         as outputTokens,
        COALESCE(SUM(cache_read_tokens), 0)     as cacheReadTokens,
        COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens
      FROM token_usage WHERE ${sql}
      GROUP BY date(occurred_at)
      ORDER BY date(occurred_at)
    `).all(...params) as TokenUsageByDay[];
    return rows;
  }

  byModel(filter: TokenUsageFilter): TokenUsageByModel[] {
    const { sql, params } = applyOptionalFilters(filter);
    const rows = this.sqlite.prepare(`
      SELECT
        model,
        COALESCE(SUM(input_tokens), 0)          as inputTokens,
        COALESCE(SUM(output_tokens), 0)         as outputTokens,
        COALESCE(SUM(cache_read_tokens), 0)     as cacheReadTokens,
        COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as totalTokens
      FROM token_usage WHERE ${sql}
      GROUP BY model
      ORDER BY totalTokens DESC
    `).all(...params) as TokenUsageByModel[];
    return rows;
  }

  byProject(filter: TokenUsageFilter): TokenUsageByProject[] {
    const { sql, params } = applyOptionalFilters(filter);
    const rows = this.sqlite.prepare(`
      SELECT
        COALESCE(project, '(unknown)') as project,
        COALESCE(SUM(input_tokens), 0)          as inputTokens,
        COALESCE(SUM(output_tokens), 0)         as outputTokens,
        COALESCE(SUM(cache_read_tokens), 0)     as cacheReadTokens,
        COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as totalTokens
      FROM token_usage WHERE ${sql}
      GROUP BY project
      ORDER BY totalTokens DESC
    `).all(...params) as TokenUsageByProject[];
    return rows;
  }

  byHourDay(filter: TokenUsageFilter): TokenUsageByHourDay[] {
    const { sql, params } = applyOptionalFilters(filter);
    // SQLite's strftime returns '0' (Sun) through '6' (Sat) for %w.
    const rows = this.sqlite.prepare(`
      SELECT
        CAST(strftime('%w', occurred_at) AS INTEGER) as dayOfWeek,
        CAST(strftime('%H', occurred_at) AS INTEGER) as hour,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as totalTokens
      FROM token_usage WHERE ${sql}
      GROUP BY dayOfWeek, hour
    `).all(...params) as TokenUsageByHourDay[];
    return rows;
  }

  topSessions(filter: TokenUsageFilter, limit = 20): TopSession[] {
    const { sql, params } = applyOptionalFilters(filter);
    const rows = this.sqlite.prepare(`
      SELECT
        session_id as sessionId,
        MAX(project) as project,
        MAX(model) as model,
        MIN(occurred_at) as startedAt,
        MAX(occurred_at) as endedAt,
        COUNT(*) as messageCount,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as totalTokens
      FROM token_usage WHERE ${sql} AND session_id IS NOT NULL
      GROUP BY session_id
      ORDER BY totalTokens DESC
      LIMIT ?
    `).all(...params, limit) as TopSession[];
    return rows;
  }
}
