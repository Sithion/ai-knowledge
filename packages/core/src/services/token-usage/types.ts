/**
 * Record stored in the `token_usage` table — one row per Claude/Copilot/Cursor
 * assistant message that included a usage payload.
 *
 * `id` is a deterministic hash so re-scanning is idempotent.
 */
export interface TokenUsageRecord {
  id: string;
  source: string;
  model: string;
  project: string | null;
  sessionId: string | null;
  messageId: string | null;
  occurredAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Resume-state stored per JSONL file, so re-scans only read appended bytes. */
export interface ScanState {
  source: string;
  filePath: string;
  lastOffset: number;
  lastMtime: string;
}

export interface TokenUsageFilter {
  from: string;
  to: string;
  source?: string;
  model?: string;
  project?: string;
}

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface TokenUsageByDay {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface TokenUsageByModel {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface TokenUsageByProject {
  project: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Comma-joined distinct sources contributing to this project (e.g. "claude-code,copilot-cli"). */
  sources: string;
}

export interface TokenUsageByHourDay {
  dayOfWeek: number;
  hour: number;
  totalTokens: number;
}

export interface TopSession {
  sessionId: string;
  project: string | null;
  model: string;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  totalTokens: number;
  /** Source/tool that produced the session (e.g. "claude-code" | "copilot-cli"). */
  source: string;
}

export interface TokenUsageAggregates {
  totals: TokenUsageTotals;
  byDay: TokenUsageByDay[];
  byModel: TokenUsageByModel[];
  byProject: TokenUsageByProject[];
  byHourDay: TokenUsageByHourDay[];
  topSessions: TopSession[];
  cacheEfficiency: number;
}
