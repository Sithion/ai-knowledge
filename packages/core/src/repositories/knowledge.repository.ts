import { eq, ne, sql, and, or, isNull } from 'drizzle-orm';
import { type Database, type SQLiteDatabase } from '../db/client.js';
import { knowledgeEntries } from '../db/schema/knowledge.js';
import {
  insertEmbedding,
  updateEmbedding,
  deleteEmbedding,
  searchKnn,
  insertPlanEmbedding,
  updatePlanEmbedding,
  deletePlanEmbedding,
  searchPlansKnn,
} from '../db/schema/sqlite-vec.js';
import type { CreateKnowledgeInput, UpdateKnowledgeInput, SearchOptions } from '@cognistore/shared';
import { DEFAULT_SEARCH_LIMIT, DEFAULT_SIMILARITY_THRESHOLD } from '@cognistore/shared';

// Retention window for the operations_log table. Must be >= the largest window
// the dashboard chart asks for (currently 15 days via getOperationsByDay).
const OPERATIONS_RETENTION_DAYS = 30;

export class KnowledgeRepository {
  constructor(
    private db: Database,
    private sqlite: SQLiteDatabase
  ) {}

  async create(input: CreateKnowledgeInput & { embedding: number[] }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const [entry] = await this.db
      .insert(knowledgeEntries)
      .values({
        id,
        title: input.title,
        content: input.content,
        tags: input.tags,
        type: input.type,
        scope: input.scope,
        source: input.source,
        confidenceScore: input.confidenceScore ?? 1.0,
        expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
        relatedIds: input.relatedIds ?? null,
        agentId: input.agentId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Insert embedding into the sqlite-vec virtual table
    insertEmbedding(this.sqlite, id, input.embedding);

    return entry;
  }

  async findById(id: string) {
    const [entry] = await this.db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.id, id));
    return entry ?? null;
  }

  async update(id: string, updates: UpdateKnowledgeInput & { embedding?: number[] }) {
    const { embedding, ...rest } = updates;

    const values: Record<string, unknown> = {
      ...rest,
      updatedAt: new Date().toISOString(),
    };

    // Convert Date to ISO string for SQLite
    if (rest.expiresAt !== undefined) {
      values.expiresAt = rest.expiresAt ? rest.expiresAt.toISOString() : null;
    }

    const [entry] = await this.db
      .update(knowledgeEntries)
      .set({
        ...values,
        version: sql`${knowledgeEntries.version} + 1`,
      })
      .where(eq(knowledgeEntries.id, id))
      .returning();

    // Update embedding in virtual table if provided
    if (embedding) {
      updateEmbedding(this.sqlite, id, embedding);
    }

    return entry ?? null;
  }

  async delete(id: string) {
    const [entry] = await this.db
      .delete(knowledgeEntries)
      .where(eq(knowledgeEntries.id, id))
      .returning();

    if (entry) {
      deleteEmbedding(this.sqlite, id);
    }

    return entry ?? null;
  }

  /**
   * Semantic search using cosine similarity on embeddings.
   * Uses sqlite-vec KNN search on the virtual table, then filters by metadata.
   * IMPORTANT: When a specific scope is provided, global knowledge is ALWAYS included.
   */
  async searchBySimilarity(queryEmbedding: number[], options?: SearchOptions) {
    const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
    const threshold = options?.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;

    // Fetch more candidates than needed to account for metadata filtering
    const candidateLimit = limit * 5;
    const knnResults = searchKnn(this.sqlite, queryEmbedding, candidateLimit);

    if (knnResults.length === 0) {
      return [];
    }

    // Get the candidate IDs
    const candidateIds = knnResults.map((r) => r.id);
    // Build a distance lookup map (cosine distance from sqlite-vec)
    const distanceMap = new Map(knnResults.map((r) => [r.id, r.distance]));

    // Fetch full entries for candidates
    const conditions = [];

    // Filter to only candidates from KNN
    conditions.push(
      sql`${knowledgeEntries.id} IN (${sql.join(
        candidateIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    );

    // Scope filter: always include global + specific scope
    if (options?.scope) {
      conditions.push(
        or(
          eq(knowledgeEntries.scope, 'global'),
          eq(knowledgeEntries.scope, options.scope)
        )
      );
    }

    // Tag filter: check if any requested tag is in the JSON tags array
    if (options?.tags && options.tags.length > 0) {
      const tagConditions = options.tags.map(
        (tag) => sql`EXISTS (SELECT 1 FROM json_each(${knowledgeEntries.tags}) WHERE value = ${tag})`
      );
      conditions.push(or(...tagConditions));
    }

    // Type filter
    if (options?.type) {
      conditions.push(eq(knowledgeEntries.type, options.type));
    }

    // Exclude system entries from search results (injected via hook only)
    conditions.push(ne(knowledgeEntries.type, 'system'));

    // Exclude expired entries
    conditions.push(
      or(
        isNull(knowledgeEntries.expiresAt),
        sql`${knowledgeEntries.expiresAt} > ${new Date().toISOString()}`
      )
    );

    const whereClause = and(...conditions);

    const entries = await this.db
      .select()
      .from(knowledgeEntries)
      .where(whereClause);

    // Convert cosine distance to similarity (similarity = 1 - distance)
    // and filter by threshold, then sort and limit
    return entries
      .map((entry) => ({
        entry,
        similarity: 1 - (distanceMap.get(entry.id) ?? 1),
      }))
      .filter((r) => r.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async listRecent(limit = 20, filters?: { type?: string; scope?: string }) {
    const conditions: any[] = [ne(knowledgeEntries.type, 'system')];
    if (filters?.type) conditions.push(sql`${knowledgeEntries.type} = ${filters.type}`);
    if (filters?.scope) conditions.push(sql`${knowledgeEntries.scope} = ${filters.scope}`);

    return this.db
      .select()
      .from(knowledgeEntries)
      .where(and(...conditions))
      .orderBy(sql`${knowledgeEntries.createdAt} DESC`)
      .limit(limit);
  }

  async listTags(opts: { from?: string; to?: string } = {}) {
    const { from, to } = opts;
    if (from && to) {
      const result = await this.db.all<{ value: string }>(
        sql`SELECT DISTINCT value FROM knowledge_entries, json_each(knowledge_entries.tags)
            WHERE knowledge_entries.type != 'system'
              AND knowledge_entries.created_at >= ${from}
              AND knowledge_entries.created_at < ${to}`
      );
      return result.map((r) => r.value);
    }
    const result = await this.db.all<{ value: string }>(
      sql`SELECT DISTINCT value FROM knowledge_entries, json_each(knowledge_entries.tags) WHERE knowledge_entries.type != 'system'`
    );
    return result.map((r) => r.value);
  }

  async topTags(limit = 10, opts: { from?: string; to?: string } = {}) {
    const { from, to } = opts;
    if (from && to) {
      const result = await this.db.all<{ tag: string; count: number }>(
        sql`SELECT value as tag, COUNT(*) as count FROM knowledge_entries, json_each(knowledge_entries.tags)
            WHERE knowledge_entries.type != 'system'
              AND knowledge_entries.created_at >= ${from}
              AND knowledge_entries.created_at < ${to}
            GROUP BY value ORDER BY count DESC LIMIT ${limit}`
      );
      return result;
    }
    const result = await this.db.all<{ tag: string; count: number }>(
      sql`SELECT value as tag, COUNT(*) as count FROM knowledge_entries, json_each(knowledge_entries.tags) WHERE knowledge_entries.type != 'system' GROUP BY value ORDER BY count DESC LIMIT ${limit}`
    );
    return result;
  }

  async count() {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(knowledgeEntries)
      .where(ne(knowledgeEntries.type, 'system'));
    return Number(result.count);
  }

  async lastUpdatedAt(): Promise<string | null> {
    const result = await this.db.all<{ latest: string }>(
      sql`SELECT MAX(updated_at) as latest FROM knowledge_entries`
    );
    return result[0]?.latest ?? null;
  }

  async countByType(opts: { from?: string; to?: string } = {}) {
    const { from, to } = opts;
    const conditions = [ne(knowledgeEntries.type, 'system')];
    if (from && to) {
      conditions.push(sql`${knowledgeEntries.createdAt} >= ${from}`);
      conditions.push(sql`${knowledgeEntries.createdAt} < ${to}`);
    }
    const results = await this.db
      .select({
        type: knowledgeEntries.type,
        count: sql<number>`count(*)`,
      })
      .from(knowledgeEntries)
      .where(and(...conditions))
      .groupBy(knowledgeEntries.type);
    return results.map((r) => ({ type: r.type, count: Number(r.count) }));
  }

  async countByScope(opts: { from?: string; to?: string } = {}) {
    const { from, to } = opts;
    const conditions = [ne(knowledgeEntries.type, 'system')];
    if (from && to) {
      conditions.push(sql`${knowledgeEntries.createdAt} >= ${from}`);
      conditions.push(sql`${knowledgeEntries.createdAt} < ${to}`);
    }
    const results = await this.db
      .select({
        scope: knowledgeEntries.scope,
        count: sql<number>`count(*)`,
      })
      .from(knowledgeEntries)
      .where(and(...conditions))
      .groupBy(knowledgeEntries.scope);
    return results.map((r) => ({ scope: r.scope, count: Number(r.count) }));
  }

  async listAll() {
    return this.db
      .select()
      .from(knowledgeEntries)
      .where(ne(knowledgeEntries.type, 'system'))
      .orderBy(sql`${knowledgeEntries.createdAt} DESC`);
  }

  async listScopes(): Promise<string[]> {
    const rows = this.sqlite.prepare(
      `SELECT DISTINCT scope FROM knowledge_entries
       UNION
       SELECT DISTINCT scope FROM plans
       ORDER BY scope`
    ).all() as { scope: string }[];
    return rows.map((r) => r.scope);
  }

  // ─── Plans (separate table) ──────────────────────────────────

  createPlan(input: { title: string; content: string; tags: string[]; scope: string; source: string; status?: string; embedding: number[] }): any {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sqlite.prepare(
      'INSERT INTO plans (id, title, content, tags, scope, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.title, input.content, JSON.stringify(input.tags), input.scope, input.status ?? 'draft', input.source, now, now);

    // Insert embedding into plans_embeddings
    try {
      insertPlanEmbedding(this.sqlite, id, input.embedding);
    } catch { /* vec table may not exist yet */ }

    return this.getPlanById(id);
  }

  getPlanById(id: string): any | null {
    return this.sqlite.prepare('SELECT * FROM plans WHERE id = ?').get(id) ?? null;
  }

  updatePlan(id: string, updates: Record<string, unknown>): any | null {
    const setClauses: string[] = [];
    const values: any[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      const col = key === 'tags' ? 'tags' : key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
      setClauses.push(`${col} = ?`);
      values.push(key === 'tags' ? JSON.stringify(value) : value);
    }
    if (setClauses.length === 0) return this.getPlanById(id);

    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.sqlite.prepare(`UPDATE plans SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    return this.getPlanById(id);
  }

  deletePlan(id: string): boolean {
    // Cascade deletes plan_relations and plan_tasks via FK
    const result = this.sqlite.prepare('DELETE FROM plans WHERE id = ?').run(id);
    try { deletePlanEmbedding(this.sqlite, id); } catch { /* silent */ }
    return result.changes > 0;
  }

  listAllPlans(): any[] {
    return this.sqlite.prepare('SELECT * FROM plans ORDER BY created_at DESC').all() as any[];
  }

  listPlans(limit = 20, status?: string, scope?: string): any[] {
    const conditions: string[] = [];
    const params: any[] = [];
    if (status) { conditions.push('status = ?'); params.push(status); }
    if (scope) { conditions.push('scope = ?'); params.push(scope); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit);
    return this.sqlite.prepare(`SELECT * FROM plans ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as any[];
  }

  findSimilarActivePlans(embedding: number[], scope: string, threshold = 0.5): { plan: any; similarity: number }[] {
    try {
      // Pre-filter: only draft/active plans in scope (avoids KNN saturation from completed plans)
      const candidates = this.sqlite.prepare(
        "SELECT id FROM plans WHERE scope = ? AND status IN ('draft', 'active')"
      ).all(scope) as { id: string }[];
      if (!candidates.length) return [];

      // Fetch embeddings for those candidates only
      const ids = candidates.map(c => c.id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = this.sqlite.prepare(
        `SELECT id, embedding FROM plans_embeddings WHERE id IN (${placeholders})`
      ).all(...ids) as { id: string; embedding: Buffer }[];
      if (!rows.length) return [];

      // Compute cosine similarity in JS
      const queryVec = new Float32Array(embedding);
      return rows
        .map(row => {
          const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
          const sim = cosineSimilarity(queryVec, vec);
          return { id: row.id, similarity: sim };
        })
        .filter(r => r.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .map(r => ({
          plan: this.sqlite.prepare('SELECT * FROM plans WHERE id = ?').get(r.id),
          similarity: r.similarity,
        }));
    } catch {
      return [];
    }
  }

  archiveStaleDrafts(maxAgeHours = 24): number {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    return this.sqlite.prepare(
      "UPDATE plans SET status = 'archived', updated_at = ? WHERE status = 'draft' AND updated_at < ?"
    ).run(new Date().toISOString(), cutoff).changes;
  }

  deletePlanTasks(planId: string): number {
    return this.sqlite.prepare('DELETE FROM plan_tasks WHERE plan_id = ?').run(planId).changes;
  }

  updatePlanEmbeddingById(id: string, embedding: number[]): void {
    try { updatePlanEmbedding(this.sqlite, id, embedding); } catch { /* silent */ }
  }

  insertEmbeddingById(id: string, embedding: number[]): void {
    insertEmbedding(this.sqlite, id, embedding);
  }

  insertPlanEmbeddingById(id: string, embedding: number[]): void {
    insertPlanEmbedding(this.sqlite, id, embedding);
  }

  // ─── Plan Relations ─────────────────────────────────────────

  addPlanRelation(planId: string, knowledgeId: string, relationType: 'input' | 'output'): void {
    this.sqlite
      .prepare('INSERT OR IGNORE INTO plan_relations (plan_id, knowledge_id, relation_type, created_at) VALUES (?, ?, ?, ?)')
      .run(planId, knowledgeId, relationType, new Date().toISOString());
  }

  getPlanRelations(planId: string): { id: string; relationType: string }[] {
    return this.sqlite
      .prepare('SELECT knowledge_id as id, relation_type as relationType FROM plan_relations WHERE plan_id = ? ORDER BY created_at')
      .all(planId) as { id: string; relationType: string }[];
  }

  deletePlanRelations(planId: string): number {
    return this.sqlite.prepare('DELETE FROM plan_relations WHERE plan_id = ?').run(planId).changes;
  }

  getPlansForKnowledge(knowledgeId: string): { planId: string; relationType: string; title: string; status: string }[] {
    return this.sqlite
      .prepare(`
        SELECT pr.plan_id as planId, pr.relation_type as relationType, p.title, p.status
        FROM plan_relations pr
        JOIN plans p ON p.id = pr.plan_id
        WHERE pr.knowledge_id = ?
        ORDER BY pr.created_at
      `)
      .all(knowledgeId) as { planId: string; relationType: string; title: string; status: string }[];
  }

  // ─── Plan Tasks ─────────────────────────────────────────────

  createPlanTask(input: { planId: string; description: string; status?: string; priority?: string; notes?: string | null; position?: number }): any {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const maxPos = this.sqlite.prepare('SELECT MAX(position) as max FROM plan_tasks WHERE plan_id = ?').get(input.planId) as any;
    const position = input.position ?? ((maxPos?.max ?? -1) + 1);

    this.sqlite.prepare(
      'INSERT INTO plan_tasks (id, plan_id, description, status, priority, notes, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.planId, input.description, input.status ?? 'pending', input.priority ?? 'medium', input.notes ?? null, position, now, now);

    return this.getPlanTaskById(id);
  }

  updatePlanTask(id: string, updates: { description?: string; status?: string; priority?: string; notes?: string | null; position?: number }): any | null {
    const setClauses: string[] = [];
    const values: any[] = [];

    if (updates.description !== undefined) { setClauses.push('description = ?'); values.push(updates.description); }
    if (updates.status !== undefined) { setClauses.push('status = ?'); values.push(updates.status); }
    if (updates.priority !== undefined) { setClauses.push('priority = ?'); values.push(updates.priority); }
    if (updates.notes !== undefined) { setClauses.push('notes = ?'); values.push(updates.notes); }
    if (updates.position !== undefined) { setClauses.push('position = ?'); values.push(updates.position); }

    if (setClauses.length === 0) return this.getPlanTaskById(id);

    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.sqlite.prepare(`UPDATE plan_tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    return this.getPlanTaskById(id);
  }

  deletePlanTask(id: string): boolean {
    return this.sqlite.prepare('DELETE FROM plan_tasks WHERE id = ?').run(id).changes > 0;
  }

  listPlanTasks(planId: string): any[] {
    return this.sqlite.prepare('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY position ASC').all(planId) as any[];
  }

  getPlanTaskById(id: string): any | null {
    return this.sqlite.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(id) ?? null;
  }

  getTaskPlanId(taskId: string): string | null {
    const row = this.sqlite.prepare('SELECT plan_id FROM plan_tasks WHERE id = ?').get(taskId) as { plan_id: string } | undefined;
    return row?.plan_id ?? null;
  }

  countIncompleteTasks(planId: string): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) as cnt FROM plan_tasks WHERE plan_id = ? AND status != 'completed'").get(planId) as { cnt: number };
    return row?.cnt ?? 0;
  }

  getPlanTaskStats(): { total: number; pending: number; inProgress: number; completed: number } {
    const result = this.sqlite.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
      FROM plan_tasks
    `).get() as any;
    return { total: result?.total ?? 0, pending: result?.pending ?? 0, inProgress: result?.in_progress ?? 0, completed: result?.completed ?? 0 };
  }

  // ─── Operations Log ────────────────────────────────────────────

  logOperation(operation: 'read' | 'write'): void {
    this.sqlite
      .prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)')
      .run(operation, new Date().toISOString());
  }

  logOperationBatch(operation: 'read' | 'write', count: number): void {
    if (count <= 0) return;
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)');
    const insertMany = this.sqlite.transaction((n: number) => {
      for (let i = 0; i < n; i++) stmt.run(operation, now);
    });
    insertMany(count);
  }

  getOperationCounts(): {
    readsLastHour: number;
    readsLastDay: number;
    writesLastHour: number;
    writesLastDay: number;
  } {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const result = this.sqlite
      .prepare(
        `SELECT
          SUM(CASE WHEN operation = 'read'  AND created_at >= ? THEN 1 ELSE 0 END) as reads_1h,
          SUM(CASE WHEN operation = 'read'  AND created_at >= ? THEN 1 ELSE 0 END) as reads_24h,
          SUM(CASE WHEN operation = 'write' AND created_at >= ? THEN 1 ELSE 0 END) as writes_1h,
          SUM(CASE WHEN operation = 'write' AND created_at >= ? THEN 1 ELSE 0 END) as writes_24h
        FROM operations_log
        WHERE created_at >= ?`
      )
      .get(oneHourAgo, oneDayAgo, oneHourAgo, oneDayAgo, oneDayAgo) as any;

    return {
      readsLastHour: result?.reads_1h ?? 0,
      readsLastDay: result?.reads_24h ?? 0,
      writesLastHour: result?.writes_1h ?? 0,
      writesLastDay: result?.writes_24h ?? 0,
    };
  }

  getOperationsByDay(days: number = 15): { date: string; reads: number; writes: number }[] {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.sqlite.prepare(`
      SELECT date(created_at) as date, operation, COUNT(*) as count
      FROM operations_log
      WHERE created_at >= ?
      GROUP BY date(created_at), operation
      ORDER BY date(created_at)
    `).all(cutoff) as { date: string; operation: string; count: number }[];

    const map: Record<string, { reads: number; writes: number }> = {};
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      map[dateStr] = { reads: 0, writes: 0 };
    }
    for (const row of rows) {
      if (!map[row.date]) map[row.date] = { reads: 0, writes: 0 };
      if (row.operation === 'read') map[row.date].reads = row.count;
      else if (row.operation === 'write') map[row.date].writes = row.count;
    }
    return Object.entries(map).map(([date, counts]) => ({ date, ...counts }));
  }

  cleanupOldOperations(): number {
    const cutoff = new Date(Date.now() - OPERATIONS_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    return this.sqlite.prepare('DELETE FROM operations_log WHERE created_at < ?').run(cutoff).changes;
  }

  /**
   * Delete embeddings for completed/archived plans older than maxAgeDays.
   * These plans are never searched semantically (only draft/active are).
   */
  cleanupCompletedPlanEmbeddings(maxAgeDays = 30): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const oldPlans = this.sqlite.prepare(
      `SELECT id FROM plans WHERE status IN ('completed', 'archived') AND updated_at < ?`
    ).all(cutoff) as { id: string }[];

    if (oldPlans.length === 0) return 0;

    let removed = 0;
    const deleteStmt = this.sqlite.prepare('DELETE FROM plans_embeddings WHERE id = ?');
    for (const plan of oldPlans) {
      const result = deleteStmt.run(plan.id);
      removed += result.changes;
    }
    return removed;
  }
}

/** Cosine similarity between two Float32Arrays: dot(a,b) / (|a| * |b|) */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
