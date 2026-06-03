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
  agentId: string | null;
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
  createdAt: Date;
  updatedAt: Date;
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
}

export interface UpdatePlanInput {
  title?: string;
  content?: string;
  tags?: string[];
  scope?: string;
  status?: KnowledgeStatus;
  source?: string;
  planFilePath?: string | null;
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
