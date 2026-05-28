import { KnowledgeRepository } from '../repositories/knowledge.repository.js';
import type {
  CreateKnowledgeInput,
  UpdateKnowledgeInput,
  SearchOptions,
  KnowledgeEntry,
  SearchResult,
  Plan,
  CreatePlanInput,
  UpdatePlanInput,
  PlanTask,
  FederatedProviderSource,
  FederatedSearchResult,
  ExternalSection,
} from '@cognistore/shared';
import {
  DEFAULT_SEARCH_LIMIT,
  PLAN_DEDUP_THRESHOLD,
  PLAN_ACTIVE_MERGE_THRESHOLD,
  PLAN_CONTEXT_THRESHOLD,
  PLAN_CONTEXT_LIMIT,
  PLAN_CONTEXT_EXTRA,
} from '@cognistore/shared';

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export class KnowledgeService {
  private lastArchiveRunMs = 0;

  constructor(
    private repository: KnowledgeRepository,
    private embeddingProvider: EmbeddingProvider
  ) {}

  private logOp(op: 'read' | 'write', count = 1) {
    try {
      if (count <= 1) this.repository.logOperation(op);
      else this.repository.logOperationBatch(op, count);
    } catch { /* silent */ }
  }

  private buildEmbeddingText(title: string, content: string, tags: string[]): string {
    return `${title} ${content} ${tags.join(' ')}`;
  }

  async add(input: CreateKnowledgeInput): Promise<KnowledgeEntry & { deduplicated?: boolean }> {
    const { skipDedup, ...rest } = input;
    const embeddingText = this.buildEmbeddingText(rest.title, rest.content, rest.tags);
    const embedding = await this.embeddingProvider.embed(embeddingText);

    // Dedup: check for existing similar entry in same scope + type
    if (!skipDedup) {
      try {
        const similar = await this.repository.searchBySimilarity(embedding, {
          scope: rest.scope,
          type: rest.type,
          limit: 1,
          threshold: 0.85,
        });
        if (similar.length > 0) {
          const existing = similar[0].entry;
          const updated = await this.repository.update(existing.id, { ...rest, embedding });
          this.logOp('write');
          return { ...this.toKnowledgeEntry(updated!), deduplicated: true };
        }
      } catch { /* best-effort dedup — proceed with insert on failure */ }
    }

    const entry = await this.repository.create({ ...rest, embedding });
    this.logOp('write');
    return this.toKnowledgeEntry(entry);
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const queryEmbedding = await this.embeddingProvider.embed(query);
    const results = await this.repository.searchBySimilarity(queryEmbedding, options);
    this.logOp('read', results.length);
    const direct: SearchResult[] = results.map((r) => ({
      entry: this.toKnowledgeEntry(r.entry),
      similarity: r.similarity,
    }));

    if (!options?.includePlanContext) return direct;
    try {
      return await this.augmentWithPlanContext(queryEmbedding, options, direct);
    } catch {
      return direct; // augmentation is best-effort; never fail the base search
    }
  }

  /**
   * Plan-augmented retrieval: mine knowledge linked (input + output) to plans whose
   * embedding is similar to the query, dedup against direct hits, and append them
   * AFTER all direct results (hard-demoted), capped at PLAN_CONTEXT_EXTRA.
   */
  private async augmentWithPlanContext(
    queryEmbedding: number[],
    options: SearchOptions,
    direct: SearchResult[],
  ): Promise<SearchResult[]> {
    const scope = options.scope ?? 'global';
    const plans = this.repository.findSimilarPlansAnyStatus(
      queryEmbedding,
      scope,
      PLAN_CONTEXT_THRESHOLD,
      PLAN_CONTEXT_LIMIT,
    );
    if (!plans.length) return direct;

    const seen = new Set(direct.map((r) => r.entry.id));
    const extras: SearchResult[] = [];
    for (const { plan, similarity } of plans) {
      for (const rel of this.repository.getPlanRelations(plan.id)) {
        if (extras.length >= PLAN_CONTEXT_EXTRA) break;
        if (seen.has(rel.id)) continue;
        const entry = await this.repository.findById(rel.id);
        if (!entry) continue;
        seen.add(rel.id);
        extras.push({
          entry: this.toKnowledgeEntry(entry),
          similarity,
          provenance: {
            viaPlanId: plan.id,
            viaPlanTitle: plan.title,
            relationType: rel.relationType as 'input' | 'output',
            viaPlanSimilarity: similarity,
          },
        });
      }
      if (extras.length >= PLAN_CONTEXT_EXTRA) break;
    }

    return [...direct, ...extras];
  }

  /**
   * Local-first federated search: runs the local cosine search and, if a provider
   * source is given, fans out to enabled external providers concurrently. External
   * failures/timeouts are isolated inside `fanOut` and never affect local results.
   */
  async searchFederated(
    query: string,
    options?: SearchOptions,
    source?: FederatedProviderSource,
    opts?: { perProviderTimeoutMs?: number; signal?: AbortSignal },
  ): Promise<FederatedSearchResult> {
    const k = options?.limit ?? DEFAULT_SEARCH_LIMIT;
    const localPromise = this.search(query, options);
    const externalPromise: Promise<ExternalSection[]> = source
      ? source.fanOut(query, k, opts?.perProviderTimeoutMs ?? 5000, opts?.signal)
      : Promise.resolve([]);
    const [local, external] = await Promise.all([localPromise, externalPromise]);
    return { local, external };
  }

  async getById(id: string): Promise<KnowledgeEntry | null> {
    const entry = await this.repository.findById(id);
    return entry ? this.toKnowledgeEntry(entry) : null;
  }

  async update(id: string, updates: UpdateKnowledgeInput): Promise<KnowledgeEntry | null> {
    let embedding: number[] | undefined;
    if (updates.content || updates.title || updates.tags) {
      const current = await this.repository.findById(id);
      const title = updates.title || current?.title || '';
      const content = updates.content || current?.content || '';
      const tags = updates.tags || (current?.tags ?? []);
      embedding = await this.embeddingProvider.embed(this.buildEmbeddingText(title, content, tags));
    }
    const entry = await this.repository.update(id, { ...updates, embedding });
    if (entry) this.logOp('write');
    return entry ? this.toKnowledgeEntry(entry) : null;
  }

  async delete(id: string): Promise<boolean> {
    const entry = await this.repository.delete(id);
    if (entry) this.logOp('write');
    return entry !== null;
  }

  async listAll() {
    const entries = await this.repository.listAll();
    return entries.map((e) => this.toKnowledgeEntry(e));
  }

  /**
   * Re-embed all knowledge entries and plans with the current embedding provider.
   * Used when switching embedding models (e.g. all-minilm 384d → nomic-embed-text 768d).
   * Assumes vec tables have already been dropped and recreated with new dimensions.
   */
  async reembedAll(): Promise<number> {
    let count = 0;

    // Re-embed knowledge entries
    const entries = await this.repository.listAll();
    for (const entry of entries) {
      try {
        const tags = Array.isArray(entry.tags) ? entry.tags : JSON.parse(entry.tags ?? '[]');
        const text = this.buildEmbeddingText(entry.title, entry.content, tags);
        const embedding = await this.embeddingProvider.embed(text);
        try { this.repository.insertEmbeddingById(entry.id, embedding); } catch { /* may already exist */ }
        count++;
      } catch (e) {
        console.warn(`[CogniStore] Re-embed failed for entry ${entry.id}:`, e);
      }
    }

    // Re-embed plans
    const plans = this.repository.listAllPlans();
    for (const plan of plans) {
      try {
        const embedding = await this.embeddingProvider.embed(`${plan.title} ${plan.content}`);
        try { this.repository.insertPlanEmbeddingById(plan.id, embedding); } catch { /* may already exist */ }
        count++;
      } catch (e) {
        console.warn(`[CogniStore] Re-embed failed for plan ${plan.id}:`, e);
      }
    }

    return count;
  }

  async listScopes(): Promise<string[]> {
    return this.repository.listScopes();
  }

  async bulkDelete(ids: string[]): Promise<{ deleted: number; errors: string[] }> {
    let deleted = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        // Guard: skip system knowledge entries
        const entry = await this.repository.findById(id);
        if (entry?.type === 'system') {
          errors.push(`Skipped ${id}: system knowledge cannot be deleted`);
          continue;
        }
        const result = await this.repository.delete(id);
        if (result) {
          deleted++;
          this.logOp('write');
        }
      } catch (err) {
        errors.push(`Failed to delete ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { deleted, errors };
  }

  async importKnowledge(entries: CreateKnowledgeInput[]): Promise<{ imported: number; skipped: number; errors: string[] }> {
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Build hash set of existing entries for duplicate detection
    const existing = await this.repository.listAll();
    const existingHashes = new Set<string>();
    for (const e of existing) {
      const hash = this.hashContent((e.title ?? '') + e.content);
      existingHashes.add(hash);
    }

    for (const entry of entries) {
      try {
        const hash = this.hashContent((entry.title ?? '') + entry.content);
        if (existingHashes.has(hash)) {
          skipped++;
          continue;
        }
        const tagsText = entry.tags.join(' ');
        const embedding = await this.embeddingProvider.embed(tagsText);
        await this.repository.create({ ...entry, embedding });
        existingHashes.add(hash);
        imported++;
        this.logOp('write');
      } catch (err) {
        errors.push(`Failed to import "${entry.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { imported, skipped, errors };
  }

  private hashContent(text: string): string {
    // Simple hash for duplicate detection (no crypto.subtle needed — sync)
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }

  async listRecent(limit = 20, filters?: { type?: string; scope?: string }) {
    const entries = await this.repository.listRecent(limit, filters);
    return entries.map((e) => this.toKnowledgeEntry(e));
  }

  async topTags(limit = 10, opts: { from?: string; to?: string } = {}) {
    return this.repository.topTags(limit, opts);
  }

  async listTags(opts: { from?: string; to?: string } = {}): Promise<string[]> {
    return this.repository.listTags(opts);
  }

  async getStats() {
    const [count, byType, byScope, lastUpdatedAt] = await Promise.all([
      this.repository.count(),
      this.repository.countByType(),
      this.repository.countByScope(),
      this.repository.lastUpdatedAt(),
    ]);
    return { total: count, byType, byScope, lastUpdatedAt };
  }

  async countByType(opts: { from?: string; to?: string } = {}) {
    return this.repository.countByType(opts);
  }

  async countByScope(opts: { from?: string; to?: string } = {}) {
    return this.repository.countByScope(opts);
  }

  // ─── Plans (separate entity) ────────────────────────────────

  async createPlan(input: CreatePlanInput & { tasks?: { description: string; priority?: string }[]; skipDedup?: boolean }): Promise<Plan & { deduplicated?: boolean; deduplicatedAction?: string; dedupSkipped?: boolean; nearestSimilarity?: number; nearestPlanId?: string; hint?: string }> {
    const { tasks, skipDedup, ...planInput } = input;
    const embedding = await this.embeddingProvider.embed(`${input.title} ${input.content}`);

    // ─── Housekeeping: archive stale drafts before dedup (throttled to 1h) ───
    const now = Date.now();
    if (now - this.lastArchiveRunMs > 3_600_000) {
      try { this.repository.archiveStaleDrafts(24); this.lastArchiveRunMs = now; } catch { /* best-effort */ }
    }

    // ─── Dedup: only merge into a genuinely related plan in the same scope. ───
    // A DRAFT is unconfirmed and cheap to update (PLAN_DEDUP_THRESHOLD). Appending
    // into an ACTIVE (in-progress) plan disturbs real work, so it needs a higher bar
    // (PLAN_ACTIVE_MERGE_THRESHOLD). Different work — even in the same project — falls
    // through to a new plan instead of being force-merged.
    const similarPlans = skipDedup ? [] : this.repository.findSimilarActivePlans(embedding, input.scope, PLAN_DEDUP_THRESHOLD);
    let nearest: { id: string; similarity: number; status: string } | undefined;
    if (similarPlans.length > 0) {
      const { plan: existingRow, similarity } = similarPlans[0];
      const status = (existingRow as any).status as string;
      nearest = { id: existingRow.id, similarity, status };
      const isActive = status === 'active';

      if (isActive && similarity >= PLAN_ACTIVE_MERGE_THRESHOLD) {
        // Active plan, clearly the same effort: add tasks to it (don't overwrite
        // content). Still link the local plan file if one was provided.
        if (tasks && tasks.length > 0) {
          for (const task of tasks) {
            this.repository.createPlanTask({ planId: existingRow.id, description: task.description, priority: task.priority });
          }
        }
        let activeRow = existingRow;
        if (input.planFilePath) {
          activeRow = this.repository.updatePlan(existingRow.id, { planFilePath: input.planFilePath }) ?? existingRow;
        }
        const plan = this.toPlan(activeRow);
        return { ...plan, deduplicated: true, deduplicatedAction: 'tasks_added_to_active_plan' };
      } else if (!isActive) {
        // Draft plan: update content and replace tasks
        this.repository.updatePlan(existingRow.id, {
          title: input.title,
          content: input.content,
          tags: input.tags,
          source: input.source,
          planFilePath: input.planFilePath,
        });
        if (tasks && tasks.length > 0) {
          this.repository.deletePlanTasks(existingRow.id);
          for (let i = 0; i < tasks.length; i++) {
            this.repository.createPlanTask({ planId: existingRow.id, description: tasks[i].description, priority: tasks[i].priority, position: i });
          }
        }
        try {
          this.repository.updatePlanEmbeddingById(existingRow.id, embedding);
        } catch { /* silent */ }
        const updated = this.repository.getPlanById(existingRow.id);
        const plan = this.toPlan(updated);
        return { ...plan, deduplicated: true, deduplicatedAction: 'draft_plan_updated' };
      }
      // Active but below the active-merge bar → keep separate; create a new plan.
    }

    // No (close enough) duplicate — create normally.
    const row = this.repository.createPlan({ ...planInput, embedding });
    const plan = this.toPlan(row);

    if (tasks && tasks.length > 0) {
      try {
        for (let i = 0; i < tasks.length; i++) {
          this.repository.createPlanTask({ planId: plan.id, description: tasks[i].description, priority: tasks[i].priority, position: i });
        }
      } catch (err) {
        this.repository.deletePlan(plan.id);
        throw err;
      }
    }

    if (nearest) {
      // A related (but distinct) plan existed and we deliberately did NOT merge.
      const pct = Math.round(nearest.similarity * 100);
      return {
        ...plan,
        dedupSkipped: true,
        nearestSimilarity: nearest.similarity,
        nearestPlanId: nearest.id,
        hint: `A related ${nearest.status} plan (${pct}% similar) exists in this scope but was different enough to keep as a separate plan. If this is actually the same effort, add to it via updatePlan("${nearest.id}", ...) instead.`,
      };
    }

    return plan;
  }

  getPlanById(id: string): Plan | null {
    const row = this.repository.getPlanById(id);
    return row ? this.toPlan(row) : null;
  }

  updatePlan(id: string, updates: UpdatePlanInput): Plan | null {
    const row = this.repository.updatePlan(id, updates as Record<string, unknown>);
    if (!row) return null;

    // Guard: when plan is completed, auto-complete all incomplete tasks
    if (updates.status === 'completed') {
      const tasks = this.repository.listPlanTasks(id);
      for (const t of tasks) {
        if ((t as any).status !== 'completed') {
          this.repository.updatePlanTask((t as any).id, { status: 'completed' });
        }
      }
    }

    return this.toPlan(row);
  }

  deletePlan(id: string): boolean {
    return this.repository.deletePlan(id);
  }

  listAllPlans(): Plan[] {
    const rows = this.repository.listAllPlans();
    return rows.map((r) => this.toPlan(r));
  }

  listPlans(limit = 20, status?: string, scope?: string): Plan[] {
    const rows = this.repository.listPlans(limit, status, scope);
    return rows.map((r) => this.toPlan(r));
  }

  archiveStaleDrafts(maxAgeHours = 24): number {
    return this.repository.archiveStaleDrafts(maxAgeHours);
  }

  async importPlans(plans: (CreatePlanInput & { tasks?: { description: string; status?: string; priority?: string; notes?: string | null }[] })[]): Promise<{ imported: number; skipped: number; errors: string[] }> {
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    const existing = this.repository.listAllPlans();
    const existingHashes = new Set<string>();
    for (const p of existing) {
      existingHashes.add(this.hashContent(p.title + p.content));
    }

    for (const plan of plans) {
      try {
        const hash = this.hashContent(plan.title + plan.content);
        if (existingHashes.has(hash)) {
          skipped++;
          continue;
        }
        const { tasks, ...planInput } = plan;
        const embedding = await this.embeddingProvider.embed(planInput.tags.join(' '));
        const row = this.repository.createPlan({ ...planInput, embedding });
        const createdPlan = this.toPlan(row);

        if (tasks && tasks.length > 0) {
          for (let i = 0; i < tasks.length; i++) {
            this.repository.createPlanTask({
              planId: createdPlan.id,
              description: tasks[i].description,
              status: tasks[i].status,
              priority: tasks[i].priority,
              notes: tasks[i].notes,
              position: i,
            });
          }
        }
        existingHashes.add(hash);
        imported++;
      } catch (err) {
        errors.push(`Failed to import plan "${plan.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { imported, skipped, errors };
  }

  // ─── Plan Relations ─────────────────────────────────────────

  addPlanRelation(planId: string, knowledgeId: string, relationType: 'input' | 'output') {
    this.repository.addPlanRelation(planId, knowledgeId, relationType);
  }

  async getPlanRelations(planId: string) {
    const relations = this.repository.getPlanRelations(planId);
    const results: { entry: KnowledgeEntry; relationType: string }[] = [];
    for (const rel of relations) {
      const entry = await this.repository.findById(rel.id);
      if (entry) results.push({ entry: this.toKnowledgeEntry(entry), relationType: rel.relationType });
    }
    return results;
  }

  getPlansForKnowledge(knowledgeId: string) {
    return this.repository.getPlansForKnowledge(knowledgeId);
  }

  // ─── Plan Tasks ─────────────────────────────────────────────

  createPlanTask(input: { planId: string; description: string; status?: string; priority?: string; notes?: string | null; position?: number }): PlanTask {
    return this.toPlanTask(this.repository.createPlanTask(input));
  }

  updatePlanTask(id: string, updates: { description?: string; status?: string; priority?: string; notes?: string | null; position?: number }): { task: PlanTask; planId: string; planStatus: string; progress: string; autoActions: string[] } | null {
    const row = this.repository.updatePlanTask(id, updates);
    if (!row) return null;

    const task = this.toPlanTask(row);
    const planId = this.repository.getTaskPlanId(id);
    const autoActions: string[] = [];

    if (planId) {
      // A1: Auto-activate plan when any task starts (from draft or completed)
      if (updates.status === 'in_progress') {
        const plan = this.repository.getPlanById(planId);
        if (plan && (plan.status === 'draft' || plan.status === 'completed')) {
          this.repository.updatePlan(planId, { status: 'active' });
          autoActions.push(`Plan auto-activated from ${plan.status} to active`);
        }
      }

      // A2: Auto-complete plan when all tasks done
      if (updates.status === 'completed') {
        const incomplete = this.repository.countIncompleteTasks(planId);
        if (incomplete === 0) {
          this.repository.updatePlan(planId, { status: 'completed' });
          autoActions.push('Plan auto-completed — all tasks done');
        }
      }
    }

    // Get current plan status and progress
    const currentPlan = planId ? this.repository.getPlanById(planId) : null;
    const allTasks = planId ? this.repository.listPlanTasks(planId) : [];
    const completedCount = allTasks.filter((t: any) => t.status === 'completed').length;
    const progress = `${completedCount}/${allTasks.length} completed`;

    return {
      task,
      planId: planId ?? '',
      planStatus: currentPlan?.status ?? 'unknown',
      progress,
      autoActions,
    };
  }

  deletePlanTask(id: string): boolean {
    return this.repository.deletePlanTask(id);
  }

  listPlanTasks(planId: string): PlanTask[] {
    return this.repository.listPlanTasks(planId).map((r) => this.toPlanTask(r));
  }

  getPlanTaskStats() {
    return this.repository.getPlanTaskStats();
  }

  // ─── Operations ─────────────────────────────────────────────

  getOperationCounts() {
    return this.repository.getOperationCounts();
  }

  getOperationsByDay(days: number = 15) {
    return this.repository.getOperationsByDay(days);
  }

  cleanupOldOperations() {
    return this.repository.cleanupOldOperations();
  }

  cleanupCompletedPlanEmbeddings(maxAgeDays = 30) {
    return this.repository.cleanupCompletedPlanEmbeddings(maxAgeDays);
  }

  // ─── Converters ─────────────────────────────────────────────

  private toKnowledgeEntry(row: any): KnowledgeEntry {
    return {
      id: row.id,
      title: row.title ?? '',
      content: row.content,
      embedding: [],
      tags: Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags ?? '[]'),
      type: row.type,
      scope: row.scope,
      source: row.source,
      version: row.version,
      expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
      confidenceScore: row.confidenceScore,
      relatedIds: row.relatedIds
        ? Array.isArray(row.relatedIds)
          ? row.relatedIds
          : JSON.parse(row.relatedIds)
        : null,
      agentId: row.agentId,
      createdAt: new Date(row.createdAt ?? row.created_at),
      updatedAt: new Date(row.updatedAt ?? row.updated_at),
    };
  }

  private toPlan(row: any): Plan {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      tags: Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags ?? '[]'),
      scope: row.scope,
      status: row.status,
      source: row.source ?? '',
      planFilePath: row.plan_file_path ?? row.planFilePath ?? null,
      createdAt: new Date(row.created_at ?? row.createdAt),
      updatedAt: new Date(row.updated_at ?? row.updatedAt),
    };
  }

  private toPlanTask(row: any): PlanTask {
    return {
      id: row.id,
      planId: row.plan_id ?? row.planId,
      description: row.description,
      status: row.status,
      priority: row.priority,
      notes: row.notes ?? null,
      position: row.position,
      createdAt: new Date(row.created_at ?? row.createdAt),
      updatedAt: new Date(row.updated_at ?? row.updatedAt),
    };
  }
}
