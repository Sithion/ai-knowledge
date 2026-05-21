import type { TokenUsageRepository } from '../../repositories/token-usage.repository.js';
import type { TokenSourceAdapter } from './adapter.js';
import type { TokenUsageRecord } from './types.js';

export interface ScanResult {
  inserted: number;
  scanned: number;
  bySource: Record<string, { inserted: number; scanned: number }>;
}

const BATCH_SIZE = 200;

/**
 * Runs every registered adapter once, collects records in small batches, and
 * persists them via INSERT OR IGNORE so re-scans are idempotent. After every
 * file the scan_state is advanced to the file's byte length at the time of
 * scanning, so the next run only reads appended content.
 */
export class TokenUsageScanner {
  constructor(
    private readonly repo: TokenUsageRepository,
    private readonly adapters: TokenSourceAdapter[],
  ) {}

  async scanAll(): Promise<ScanResult> {
    const bySource: Record<string, { inserted: number; scanned: number }> = {};
    let totalInserted = 0;
    let totalScanned = 0;

    for (const adapter of this.adapters) {
      const stats = { inserted: 0, scanned: 0 };
      bySource[adapter.name] = stats;

      let batch: TokenUsageRecord[] = [];
      const offsets = new Map<string, { offset: number; mtime: string }>();

      const flush = () => {
        if (batch.length === 0) return;
        stats.inserted += this.repo.insertMany(batch);
        batch = [];
      };

      for await (const { record, filePath, byteOffset, mtime } of adapter.scan(
        (fp) => this.repo.getScanState(adapter.name, fp),
      )) {
        // record === null is a "seen this file, nothing to store yet" signal —
        // we still record the offset so we don't reread on the next pass.
        if (record) {
          batch.push(record);
          if (batch.length >= BATCH_SIZE) flush();
        }
        offsets.set(filePath, { offset: byteOffset, mtime });
        stats.scanned++;
      }
      flush();

      // Advance scan_state once per file we read from.
      for (const [filePath, { offset, mtime }] of offsets) {
        this.repo.upsertScanState({
          source: adapter.name,
          filePath,
          lastOffset: offset,
          lastMtime: mtime,
        });
      }

      totalInserted += stats.inserted;
      totalScanned += stats.scanned;
    }

    return { inserted: totalInserted, scanned: totalScanned, bySource };
  }
}
