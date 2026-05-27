import {
  createDbClient,
  createEmbeddingsTable,
  KnowledgeRepository,
  KnowledgeService,
  TokenUsageRepository,
  TokenUsageService,
  type Database,
  type SQLiteDatabase,
  type TokenUsageAggregates,
  type TokenUsageFilter,
  type ScanResult,
} from '@cognistore/core';
import { OllamaEmbeddingClient, checkOllamaHealth } from '@cognistore/embeddings';
import {
  createKnowledgeSchema,
  updateKnowledgeSchema,
  searchOptionsSchema,
  createPlanSchema,
  updatePlanSchema,
  type CreateKnowledgeInput,
  type UpdateKnowledgeInput,
  type SearchOptions,
  type SearchResult,
  type KnowledgeEntry,
  type Plan,
  type CreatePlanInput,
  type UpdatePlanInput,
  type PlanTask,
  type HealthStatus,
  type SDKConfig,
  type FederatedSearchResult,
} from '@cognistore/shared';
import { loadProviders, ProviderManager, EnvSecretStore } from '@cognistore/providers';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { resolveConfig } from './config.js';
import { ConnectionError, EmbeddingError, ValidationError } from './errors.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export class KnowledgeSDK {
  private config: SDKConfig;
  private db: Database | null = null;
  private sqlite: SQLiteDatabase | null = null;
  private service: KnowledgeService | null = null;
  private tokenService: TokenUsageService | null = null;
  private ollamaClient: OllamaEmbeddingClient;
  private providerManager: ProviderManager | null = null;
  private alwaysExternal = false;
  private initialized = false;

  constructor(config?: Partial<SDKConfig>) {
    this.config = resolveConfig(config);
    this.ollamaClient = new OllamaEmbeddingClient({
      host: this.config.ollama.host,
      model: this.config.ollama.model,
      dimensions: this.config.ollama.dimensions,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Step 1: Connect to SQLite database
      try {
        const { db, sqlite } = createDbClient(this.config.database.path);
        this.db = db;
        this.sqlite = sqlite;
      } catch (error) {
        throw new ConnectionError(
          `Failed to open database: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Step 2: Ensure Ollama model is available
      try {
        await this.ollamaClient.ensureModel();
      } catch (error) {
        throw new EmbeddingError(
          `Failed to ensure embedding model: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Step 3: Detect embedding dimension mismatch (Matryoshka migration)
      await this.detectAndMigrateDimensions();

      // Step 4: Create service
      const repository = new KnowledgeRepository(this.db!, this.sqlite!);
      this.service = new KnowledgeService(repository, this.ollamaClient);

      // Step 5: Token usage tracking (purely additive — no embedding needed).
      const tokenRepo = new TokenUsageRepository(this.sqlite!);
      this.tokenService = new TokenUsageService(tokenRepo);

      // Step 6: External knowledge providers (federated search — opt-in, off by default).
      this.reloadProviders();

      this.initialized = true;
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.cleanup();
    this.initialized = false;
  }

  async addKnowledge(input: CreateKnowledgeInput): Promise<KnowledgeEntry> {
    this.ensureInitialized();
    const parsed = createKnowledgeSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(`Invalid input: ${parsed.error.message}`);
    }
    try {
      return await this.service!.add(parsed.data as CreateKnowledgeInput);
    } catch (error) {
      throw this.wrapError(error, 'Failed to add knowledge');
    }
  }

  async getKnowledge(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    this.ensureInitialized();
    if (!query || query.trim().length === 0) {
      throw new ValidationError('Query cannot be empty');
    }
    const parsedOptions = options ? searchOptionsSchema.parse(options) : undefined;
    try {
      return await this.service!.search(query, parsedOptions as SearchOptions | undefined);
    } catch (error) {
      throw this.wrapError(error, 'Failed to search knowledge');
    }
  }

  /**
   * Federated search: local results + one section per enabled external provider.
   * Use when the caller opted in (param) or the global always-on setting is true.
   * `getKnowledge` stays local-only and backward-compatible.
   */
  async getKnowledgeFederated(
    query: string,
    options?: SearchOptions,
    opts?: { providers?: string[]; perProviderTimeoutMs?: number },
  ): Promise<FederatedSearchResult> {
    this.ensureInitialized();
    if (!query || query.trim().length === 0) {
      throw new ValidationError('Query cannot be empty');
    }
    const parsedOptions = options ? (searchOptionsSchema.parse(options) as SearchOptions) : undefined;
    const source = this.providerManager
      ? (opts?.providers ? this.providerManager.subset(opts.providers) : this.providerManager)
      : undefined;
    try {
      return await this.service!.searchFederated(query, parsedOptions, source, {
        perProviderTimeoutMs: opts?.perProviderTimeoutMs,
      });
    } catch (error) {
      throw this.wrapError(error, 'Failed to search knowledge (federated)');
    }
  }

  /** Whether the global "always search external providers" setting is on. */
  get alwaysSearchExternalProviders(): boolean {
    return this.alwaysExternal;
  }

  /**
   * Re-read providers.json + the alwaysSearchExternalProviders setting. Call after
   * the dashboard mutates either, so federated search reflects changes without a
   * restart. Never throws (a bad config keeps the previous state).
   */
  reloadProviders(): void {
    try {
      const dir = dirname(expandHome(this.config.database.path));
      this.providerManager = loadProviders(join(dir, 'providers.json'), new EnvSecretStore());
      const settingsPath = join(dir, 'settings.json');
      this.alwaysExternal = existsSync(settingsPath)
        ? (JSON.parse(readFileSync(settingsPath, 'utf-8')) as { alwaysSearchExternalProviders?: boolean })
            ?.alwaysSearchExternalProviders === true
        : false;
    } catch (e) {
      console.error('[CogniStore] reloadProviders failed:', e instanceof Error ? e.message : String(e));
    }
  }

  async getKnowledgeById(id: string): Promise<KnowledgeEntry | null> {
    this.ensureInitialized();
    try {
      return await this.service!.getById(id);
    } catch (error) {
      throw this.wrapError(error, 'Failed to get knowledge');
    }
  }

  async updateKnowledge(id: string, updates: UpdateKnowledgeInput): Promise<KnowledgeEntry | null> {
    this.ensureInitialized();
    const parsed = updateKnowledgeSchema.safeParse(updates);
    if (!parsed.success) {
      throw new ValidationError(`Invalid updates: ${parsed.error.message}`);
    }
    try {
      const existing = await this.service!.getById(id);
      if (existing?.type === 'system' && updates.type && updates.type !== 'system') {
        throw new ValidationError('System knowledge type cannot be changed');
      }
      return await this.service!.update(id, parsed.data as UpdateKnowledgeInput);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw this.wrapError(error, 'Failed to update knowledge');
    }
  }

  async deleteKnowledge(id: string): Promise<boolean> {
    this.ensureInitialized();
    try {
      const existing = await this.service!.getById(id);
      if (existing?.type === 'system') {
        throw new ValidationError('System knowledge cannot be deleted');
      }
      return await this.service!.delete(id);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw this.wrapError(error, 'Failed to delete knowledge');
    }
  }

  async listRecent(limit = 20, filters?: { type?: string; scope?: string }) {
    this.ensureInitialized();
    try {
      return await this.service!.listRecent(limit, filters);
    } catch (error) {
      throw this.wrapError(error, 'Failed to list recent knowledge');
    }
  }

  async getTopTags(limit = 10, opts: { from?: string; to?: string } = {}) {
    this.ensureInitialized();
    try {
      return await this.service!.topTags(limit, opts);
    } catch (error) {
      throw this.wrapError(error, 'Failed to get top tags');
    }
  }

  async listTags(opts: { from?: string; to?: string } = {}): Promise<string[]> {
    this.ensureInitialized();
    try {
      return await this.service!.listTags(opts);
    } catch (error) {
      throw this.wrapError(error, 'Failed to list tags');
    }
  }

  async countByType(opts: { from?: string; to?: string } = {}) {
    this.ensureInitialized();
    try {
      return await this.service!.countByType(opts);
    } catch (error) {
      throw this.wrapError(error, 'Failed to count by type');
    }
  }

  async countByScope(opts: { from?: string; to?: string } = {}) {
    this.ensureInitialized();
    try {
      return await this.service!.countByScope(opts);
    } catch (error) {
      throw this.wrapError(error, 'Failed to count by scope');
    }
  }

  async getStats() {
    this.ensureInitialized();
    try {
      return await this.service!.getStats();
    } catch (error) {
      throw this.wrapError(error, 'Failed to get stats');
    }
  }

  async listAllKnowledge(): Promise<KnowledgeEntry[]> {
    this.ensureInitialized();
    try {
      return await this.service!.listAll();
    } catch (error) {
      throw this.wrapError(error, 'Failed to list all knowledge');
    }
  }

  async listScopes(): Promise<string[]> {
    this.ensureInitialized();
    try {
      return await this.service!.listScopes();
    } catch (error) {
      throw this.wrapError(error, 'Failed to list scopes');
    }
  }

  async bulkDeleteKnowledge(ids: string[]): Promise<{ deleted: number; errors: string[] }> {
    this.ensureInitialized();
    try {
      return await this.service!.bulkDelete(ids);
    } catch (error) {
      throw this.wrapError(error, 'Failed to bulk delete knowledge');
    }
  }

  async importKnowledge(entries: CreateKnowledgeInput[]): Promise<{ imported: number; skipped: number; errors: string[] }> {
    this.ensureInitialized();
    try {
      return await this.service!.importKnowledge(entries);
    } catch (error) {
      throw this.wrapError(error, 'Failed to import knowledge');
    }
  }

  async importPlans(plans: any[]): Promise<{ imported: number; skipped: number; errors: string[] }> {
    this.ensureInitialized();
    try {
      return await this.service!.importPlans(plans);
    } catch (error) {
      throw this.wrapError(error, 'Failed to import plans');
    }
  }

  listAllPlans(): Plan[] {
    this.ensureInitialized();
    return this.service!.listAllPlans();
  }

  // ─── Plans (separate entity) ─────────────────────────────────

  async createPlan(input: CreatePlanInput & { relatedKnowledgeIds?: string[]; tasks?: { description: string; priority?: string }[] }): Promise<Plan> {
    this.ensureInitialized();
    const { relatedKnowledgeIds, ...rest } = input;
    const parsed = createPlanSchema.safeParse(rest);
    if (!parsed.success) {
      throw new ValidationError(`Invalid plan input: ${parsed.error.message}`);
    }
    try {
      const plan = await this.service!.createPlan(parsed.data as CreatePlanInput & { tasks?: { description: string; priority?: string }[] });
      if (relatedKnowledgeIds) {
        for (const kid of relatedKnowledgeIds) {
          try { this.service!.addPlanRelation(plan.id, kid, 'input'); } catch { /* silent */ }
        }
      }
      return plan;
    } catch (error) {
      throw this.wrapError(error, 'Failed to create plan');
    }
  }

  getPlanById(id: string): Plan | null {
    this.ensureInitialized();
    return this.service!.getPlanById(id);
  }

  updatePlan(id: string, updates: UpdatePlanInput): Plan | null {
    this.ensureInitialized();
    return this.service!.updatePlan(id, updates);
  }

  deletePlan(id: string): boolean {
    this.ensureInitialized();
    return this.service!.deletePlan(id);
  }

  listPlans(limit = 20, status?: string, scope?: string): Plan[] {
    this.ensureInitialized();
    return this.service!.listPlans(limit, status, scope);
  }

  async addPlanRelation(planId: string, knowledgeId: string, relationType: 'input' | 'output'): Promise<void> {
    this.ensureInitialized();
    // Guard: never link system knowledge to plans
    const entry = await this.service!.getById(knowledgeId);
    if (entry?.type === 'system') {
      return; // silently skip — system knowledge should not be linked to plans
    }
    this.service!.addPlanRelation(planId, knowledgeId, relationType);
  }

  async getPlanRelations(planId: string) {
    this.ensureInitialized();
    return this.service!.getPlanRelations(planId);
  }

  getPlansForKnowledge(knowledgeId: string) {
    this.ensureInitialized();
    return this.service!.getPlansForKnowledge(knowledgeId);
  }

  // ─── Plan Tasks ─────────────────────────────────────────────

  createPlanTask(input: { planId: string; description: string; priority?: string; notes?: string | null }): PlanTask {
    this.ensureInitialized();
    return this.service!.createPlanTask(input);
  }

  updatePlanTask(id: string, updates: { description?: string; status?: string; priority?: string; notes?: string | null; position?: number }): { task: PlanTask; planId: string; planStatus: string; progress: string; autoActions: string[] } | null {
    this.ensureInitialized();
    return this.service!.updatePlanTask(id, updates);
  }

  updatePlanTasks(updates: Array<{ taskId: string; status?: string; notes?: string | null }>): Array<{ task: PlanTask; planId: string; planStatus: string; progress: string; autoActions: string[] }> {
    this.ensureInitialized();
    const results: Array<{ task: PlanTask; planId: string; planStatus: string; progress: string; autoActions: string[] }> = [];
    for (const u of updates) {
      const result = this.service!.updatePlanTask(u.taskId, { status: u.status, notes: u.notes });
      if (result) results.push(result);
    }
    return results;
  }

  deletePlanTask(id: string): boolean {
    this.ensureInitialized();
    return this.service!.deletePlanTask(id);
  }

  listPlanTasks(planId: string): PlanTask[] {
    this.ensureInitialized();
    return this.service!.listPlanTasks(planId);
  }

  getPlanTaskStats() {
    this.ensureInitialized();
    return this.service!.getPlanTaskStats();
  }

  /**
   * Re-embed all knowledge entries and plans with the current embedding model.
   * Used during upgrade when switching embedding models (dimensions change).
   */
  async reembedAll(): Promise<number> {
    this.ensureInitialized();
    return this.service!.reembedAll();
  }

  // ─── Operations ─────────────────────────────────────────────

  getOperationCounts() {
    this.ensureInitialized();
    return this.service!.getOperationCounts();
  }

  getOperationsByDay(days: number = 15) {
    this.ensureInitialized();
    return this.service!.getOperationsByDay(days);
  }

  cleanupOldOperations() {
    if (!this.initialized || !this.service) return 0;
    return this.service!.cleanupOldOperations();
  }

  // ─── Token usage ────────────────────────────────────────────

  async scanTokenUsage(): Promise<ScanResult> {
    this.ensureInitialized();
    return this.tokenService!.scan();
  }

  getTokenUsage(filter: TokenUsageFilter): TokenUsageAggregates {
    this.ensureInitialized();
    return this.tokenService!.getAggregates(filter);
  }

  cleanupCompletedPlanEmbeddings(maxAgeDays = 30) {
    if (!this.initialized || !this.service) return 0;
    return this.service!.cleanupCompletedPlanEmbeddings(maxAgeDays);
  }

  async healthCheck(): Promise<HealthStatus> {
    const ollamaHealth = await checkOllamaHealth(this.ollamaClient);

    let dbConnected = false;
    let dbError: string | undefined;
    if (this.sqlite) {
      try {
        this.sqlite.prepare('SELECT 1').get();
        dbConnected = true;
      } catch (error) {
        dbError = error instanceof Error ? error.message : String(error);
      }
    } else {
      dbError = 'Not initialized';
    }

    return {
      database: {
        connected: dbConnected,
        path: this.config.database.path,
        error: dbError,
      },
      ollama: {
        connected: ollamaHealth.connected,
        model: ollamaHealth.model,
        host: this.config.ollama.host,
        error: ollamaHealth.error,
      },
    };
  }

  /**
   * Remove orphan embeddings (no matching entry) and run VACUUM.
   * Returns count of orphans removed and final DB size.
   */
  async cleanupDatabase(): Promise<{ orphansRemoved: number; vacuumed: boolean }> {
    this.ensureInitialized();
    try {
      // Delete embeddings whose ID is not in knowledge_entries
      const orphanIds = this.sqlite!.prepare(
        `SELECT id FROM knowledge_embeddings_rowids WHERE id NOT IN (SELECT id FROM knowledge_entries)`
      ).all() as { id: string }[];

      let removed = 0;
      const deleteStmt = this.sqlite!.prepare(`DELETE FROM knowledge_embeddings WHERE id = ?`);
      for (const row of orphanIds) {
        deleteStmt.run(row.id);
        removed++;
      }

      // VACUUM to reclaim space
      this.sqlite!.exec('VACUUM');

      return { orphansRemoved: removed, vacuumed: true };
    } catch (error) {
      throw this.wrapError(error, 'Failed to cleanup database');
    }
  }

  /**
   * Run a passive WAL checkpoint to keep the WAL file small.
   * PASSIVE mode does not block readers or writers.
   */
  walCheckpoint(): void {
    this.ensureInitialized();
    this.sqlite!.pragma('wal_checkpoint(PASSIVE)');
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.service) {
      throw new ConnectionError('SDK not initialized. Call initialize() first.');
    }
  }

  private async cleanup(): Promise<void> {
    if (this.sqlite) {
      try {
        this.sqlite.close();
      } catch {
        // Ignore cleanup errors
      }
      this.sqlite = null;
    }
    this.db = null;
    this.service = null;
    this.tokenService = null;
  }

  /**
   * Detect if stored embeddings have different dimensions than config.
   * If mismatch found (e.g., 768→256 Matryoshka migration), drop vec tables,
   * recreate at new dimensions, and re-embed all entries.
   */
  private async detectAndMigrateDimensions(): Promise<void> {
    const targetDims = this.config.ollama.dimensions;

    try {
      const sampleRow = this.sqlite!.prepare(
        'SELECT embedding FROM knowledge_embeddings LIMIT 1'
      ).get() as { embedding: Buffer } | undefined;

      if (!sampleRow) return; // No embeddings yet, nothing to migrate

      const currentDims = sampleRow.embedding.byteLength / 4; // float32 = 4 bytes
      if (currentDims === targetDims) return; // Dimensions match, no migration needed

      console.error(`[CogniStore] Embedding dimension mismatch: DB has ${currentDims}d, config wants ${targetDims}d. Re-embedding all entries...`);

      // Drop and recreate both vec tables at new dimensions
      this.sqlite!.exec('DROP TABLE IF EXISTS knowledge_embeddings');
      this.sqlite!.exec('DROP TABLE IF EXISTS plans_embeddings');
      createEmbeddingsTable(this.sqlite!, targetDims);
      this.sqlite!.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS plans_embeddings USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[${targetDims}] distance_metric=cosine
        )
      `);

      // Re-embed all entries with new dimensions
      const repository = new KnowledgeRepository(this.db!, this.sqlite!);
      const tempService = new KnowledgeService(repository, this.ollamaClient);
      const count = await tempService.reembedAll();
      console.error(`[CogniStore] Re-embedded ${count} entries at ${targetDims} dimensions`);
    } catch (error) {
      // Non-fatal: if migration fails, existing search still works (just with old dims)
      console.error(`[CogniStore] Dimension migration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private wrapError(error: unknown, context: string): Error {
    if (error instanceof Error && error.name.endsWith('Error')) {
      return error;
    }
    return new ConnectionError(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
