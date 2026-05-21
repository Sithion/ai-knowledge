import type { ScanState, TokenUsageRecord } from './types.js';

/**
 * Yielded by an adapter for each parsed line. `byteOffset` is the position
 * the scanner should persist as the new `lastOffset` once the row is stored.
 *
 * `record` can be `null` to mark a file as "seen at this size, but no usable
 * row to emit" — e.g. a Copilot session that hasn't shut down yet. The scanner
 * still advances `scan_state` for that file so the next pass skips it until
 * more bytes arrive.
 */
export interface ScannedTokenRecord {
  record: TokenUsageRecord | null;
  filePath: string;
  byteOffset: number;
  mtime: string;
}

export interface TokenSourceAdapter {
  /** Unique source name (matches the `source` column). */
  readonly name: string;

  /**
   * Scan whatever this adapter knows about — JSONL files, OTel exports, etc.
   * Implementations resume from `getState(filePath)` so re-runs are incremental.
   */
  scan(getState: (filePath: string) => ScanState | undefined): AsyncIterable<ScannedTokenRecord>;
}
