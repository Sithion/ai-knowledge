import type { TokenUsageRepository } from '../../repositories/token-usage.repository.js';
import { TokenUsageScanner, type ScanResult } from './scanner.js';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import type { TokenSourceAdapter } from './adapter.js';
import type { TokenUsageAggregates, TokenUsageFilter } from './types.js';

const DEFAULT_TOP_SESSIONS = 20;

export class TokenUsageService {
  private readonly scanner: TokenUsageScanner;

  constructor(
    private readonly repo: TokenUsageRepository,
    adapters?: TokenSourceAdapter[],
  ) {
    this.scanner = new TokenUsageScanner(repo, adapters ?? [new ClaudeCodeAdapter()]);
  }

  scan(): Promise<ScanResult> {
    return this.scanner.scanAll();
  }

  getAggregates(filter: TokenUsageFilter): TokenUsageAggregates {
    const totals = this.repo.totals(filter);
    const byDay = this.repo.byDay(filter);
    const byModel = this.repo.byModel(filter);
    const byProject = this.repo.byProject(filter);
    const byHourDay = this.repo.byHourDay(filter);
    const topSessions = this.repo.topSessions(filter, DEFAULT_TOP_SESSIONS);

    const cacheDenom = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
    const cacheEfficiency = cacheDenom > 0 ? totals.cacheReadTokens / cacheDenom : 0;

    return { totals, byDay, byModel, byProject, byHourDay, topSessions, cacheEfficiency };
  }
}
