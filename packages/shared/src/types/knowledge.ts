export enum KnowledgeType {
  DECISION = 'decision',
  PATTERN = 'pattern',
  FIX = 'fix',
  CONSTRAINT = 'constraint',
  GOTCHA = 'gotcha',
  SYSTEM = 'system',
}

export enum KnowledgeStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  ARCHIVED = 'archived',
}

export enum TaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
}

export enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  embedding: number[];
  tags: string[];
  type: KnowledgeType;
  scope: string;
  source: string;
  version: number;
  expiresAt: Date | null;
  confidenceScore: number;
  relatedIds: string[] | null;
  /** Caller-provided agent/role identity that created this entry (e.g. "documentation"). */
  agentId: string | null;
  /** Auto-detected host platform: "claude-code" | "copilot" | "opencode" | "unknown". */
  platform: string | null;
  /**
   * Last time this entry was actually retrieved (opt-in `trackRead` searches and
   * nothing else). Drives the cleanup cycle's "unread" detection. Never touched
   * by edits, so it is a pure retention signal.
   */
  lastReadAt: Date | null;
  /** How many times this entry has been retrieved since read tracking began. */
  readCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateKnowledgeInput {
  title: string;
  content: string;
  tags: string[];
  type: KnowledgeType;
  scope: string;
  source: string;
  confidenceScore?: number;
  expiresAt?: Date | null;
  relatedIds?: string[] | null;
  agentId?: string | null;
  platform?: string | null;
  skipDedup?: boolean;
}

export interface UpdateKnowledgeInput {
  title?: string;
  content?: string;
  tags?: string[];
  type?: KnowledgeType;
  scope?: string;
  source?: string;
  confidenceScore?: number;
  expiresAt?: Date | null;
  relatedIds?: string[] | null;
  agentId?: string | null;
  platform?: string | null;
}

// ─── Plans (separate entity) ─────────────────────────────────

export interface Plan {
  id: string;
  title: string;
  content: string;
  tags: string[];
  scope: string;
  status: KnowledgeStatus;
  source: string;
  /** Absolute path to the local plan file this plan was authored from (plan mode), if any. */
  planFilePath?: string | null;
  /** Caller-provided agent/role identity that created this plan (e.g. "documentation"). */
  agentId?: string | null;
  /** Auto-detected host platform: "claude-code" | "copilot" | "opencode" | "unknown". */
  platform?: string | null;
  /** Plan that spawned this one. NULL means this plan is the ORIGINAL (root) of its chain. */
  parentPlanId?: string | null;
  /** First plan of this chain. NULL means this plan IS the root. May drift — see PlanChainEntry. */
  rootPlanId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One plan in a lineage chain, as returned by getPlanChain.
 *
 * Deliberately a narrow projection: chains are shown to agents, and plan content
 * (authored by subagents that may have ingested untrusted input) is never included.
 * `depth` is precomputed server-side so no consumer has to walk parent pointers.
 */
export interface PlanChainEntry {
  id: string;
  title: string;
  status: KnowledgeStatus;
  scope: string;
  parentPlanId: string | null;
  depth: number;
  isCurrent: boolean;
}

export interface PlanChain {
  /** The ORIGINAL plan of the chain. */
  rootPlanId: string;
  /** Root first, then depth ascending, ties broken by creation time. */
  chain: PlanChainEntry[];
  /** True when the chain hit PLAN_CHAIN_MAX_ENTRIES or PLAN_CHAIN_MAX_DEPTH. */
  truncated: boolean;
}

export interface CreatePlanInput {
  title: string;
  content: string;
  tags: string[];
  scope: string;
  source: string;
  status?: KnowledgeStatus;
  /** Absolute path to the local plan file (REQUIRED whenever a plan was persisted to a file). */
  planFilePath?: string | null;
  agentId?: string | null;
  platform?: string | null;
  /** Plan that spawned this one. Omit for a brand-new ORIGINAL effort. */
  parentPlanId?: string | null;
  /** Derived from the parent by the service — never supplied by callers. */
  rootPlanId?: string | null;
}

export interface UpdatePlanInput {
  title?: string;
  content?: string;
  tags?: string[];
  scope?: string;
  status?: KnowledgeStatus;
  source?: string;
  planFilePath?: string | null;
  agentId?: string | null;
  platform?: string | null;
  /** Retroactive linking. `null` unlinks the plan, making it the root of its own chain. */
  parentPlanId?: string | null;
  /** Recomputed by the service when parentPlanId changes — never supplied by callers. */
  rootPlanId?: string | null;
}

// ─── Plan Tasks ──────────────────────────────────────────────

export interface PlanTask {
  id: string;
  planId: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  notes: string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePlanTaskInput {
  planId: string;
  description: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  notes?: string | null;
  position?: number;
}

export interface UpdatePlanTaskInput {
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  notes?: string | null;
  position?: number;
}

// ─── Plan Task Update Result ─────────────────────────────────

export interface PlanTaskUpdateResult {
  task: PlanTask;
  plan: { id: string; status: string; progress: string };
  autoActions: string[];
  reminder: string;
}

// ─── Plan Relations ──────────────────────────────────────────

export interface PlanRelation {
  entry: KnowledgeEntry;
  relationType: 'input' | 'output';
}

// ─── Search ──────────────────────────────────────────────────

export interface SearchOptions {
  tags?: string[];
  type?: KnowledgeType;
  scope?: string;
  limit?: number;
  threshold?: number;
  /**
   * Also surface knowledge linked to semantically similar plans (input = consulted,
   * output = produced). Off by default; the MCP getKnowledge handler enables it.
   */
  includePlanContext?: boolean;
  /**
   * Raw query text for the keyword/BM25 half of hybrid search. Injected by
   * KnowledgeService.search (it holds the original query). When absent, the
   * repository falls back to pure semantic ranking (e.g. plan-context path).
   */
  queryText?: string;
  /**
   * Record this search's hits as reads (`last_read_at` / `read_count`), feeding
   * the cleanup cycle's unread detection. Opt-IN: only retrieval that reflects
   * real usage should set it — the MCP getKnowledge tool and the dashboard's
   * explicit search. Internal scans, re-embeds and browsing must leave it off,
   * otherwise the retention signal is polluted and nothing is ever "unread".
   */
  trackRead?: boolean;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  similarity: number;
  /**
   * Present when this result was surfaced via a similar plan rather than a direct
   * match. Such results are ranked AFTER all direct hits.
   */
  provenance?: {
    viaPlanId: string;
    viaPlanTitle: string;
    relationType: 'input' | 'output';
    viaPlanSimilarity: number;
  };
}

export interface HealthStatus {
  database: { connected: boolean; path?: string; error?: string };
  ollama: { connected: boolean; model?: string; host?: string; error?: string };
}
