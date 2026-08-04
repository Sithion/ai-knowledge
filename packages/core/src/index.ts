export { createDbClient, type Database, type SQLiteDatabase } from './db/index.js';
export { runMigrations, EMBEDDED_MIGRATIONS } from './db/index.js';
export { knowledgeEntries, knowledgeTypeEnum } from './db/index.js';
export {
  createEmbeddingsTable,
  insertEmbedding,
  updateEmbedding,
  deleteEmbedding,
  searchKnn,
} from './db/index.js';
export { KnowledgeRepository } from './repositories/index.js';
export { KnowledgeService, type EmbeddingProvider } from './services/index.js';
export type { CleanupReport, CleanupCandidate } from './services/knowledge.service.js';

// Cleanup cycle: pure merge policy. Exported so the sidecar's LLM orchestration
// and the apply path share one implementation of the merge invariants.
export {
  computeMergedTags,
  validateMergeDraft,
  deterministicMergeDraft,
  MergeDraftError,
  CLEANUP_CONTROL_TAGS,
  type MergeDraft,
  type MergeMember,
} from './services/cleanup-merge.js';

// Token usage
export { TokenUsageRepository } from './repositories/token-usage.repository.js';
export { TokenUsageService } from './services/token-usage/service.js';
export { TokenUsageScanner, type ScanResult } from './services/token-usage/scanner.js';
export { ClaudeCodeAdapter } from './services/token-usage/adapters/claude-code.js';
export { CopilotCliAdapter } from './services/token-usage/adapters/copilot-cli.js';
export type { TokenSourceAdapter, ScannedTokenRecord } from './services/token-usage/adapter.js';
export type {
  TokenUsageRecord,
  TokenUsageFilter,
  TokenUsageAggregates,
  TokenUsageTotals,
  TokenUsageByDay,
  TokenUsageByModel,
  TokenUsageByProject,
  TokenUsageByHourDay,
  TopSession,
  ScanState,
} from './services/token-usage/types.js';
