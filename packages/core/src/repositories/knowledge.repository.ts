import { eq, ne, sql, and, or, isNull } from 'drizzle-orm';
import { type Database, type SQLiteDatabase } from '../db/client.js';
import { knowledgeEntries } from '../db/schema/knowledge.js';
import {
  insertEmbedding,
  updateEmbedding,
  deleteEmbedding,
  searchKnn,
  getEmbeddingById,
  insertPlanEmbedding,
  updatePlanEmbedding,
  deletePlanEmbedding,
  searchPlansKnn,
} from '../db/schema/sqlite-vec.js';
import {
  insertFts,
  updateFts,
  deleteFts,
  searchFts,
  ftsCount,
  type FtsResult,
} from '../db/schema/fts.js';
import type { CreateKnowledgeInput, UpdateKnowledgeInput, SearchOptions } from '@cognistore/shared';
import { DEFAULT_SEARCH_LIMIT, DEFAULT_SIMILARITY_THRESHOLD, isPlanStatus } from '@cognistore/shared';

// Retention window for the operations_log table. Must exceed the largest
// window the dashboard can request: /api/metrics/activity clamps its range to
// 730 days via daysBetween() in apps/dashboard/server/index.ts, and the '2y'
// preset uses that maximum. 800 = 730-day max view + ~70-day margin.
const OPERATIONS_RETENTION_DAYS = 800;

export class KnowledgeRepository {
  constructor(
    private db: Database,
    private sqlite: SQLiteDatabase
  ) {}

  /**
   * Entry row + embedding are committed atomically: a failed embedding insert
   * rolls the entry back instead of leaving an orphan row that semantic search
   * can never find. Uses a RAW prepared insert (createPlan style) inside
   * better-sqlite3's .transaction() — the body must be fully synchronous; an
   * awaited drizzle insert opens an interleaving window where a concurrent
   * create() issues BEGIN on the same connection ("cannot start a transaction
   * within a transaction"). FTS stays best-effort inside the txn.
   */
  async create(input: CreateKnowledgeInput & { embedding: number[] }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const insertTxn = this.sqlite.transaction(() => {
      this.sqlite.prepare(
        `INSERT INTO knowledge_entries
           (id, title, content, tags, type, scope, source, version, expires_at, confidence_score, related_ids, agent_id, platform, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.title,
        input.content,
        JSON.stringify(input.tags ?? []),
        input.type,
        input.scope,
        input.source,
        input.expiresAt ? input.expiresAt.toISOString() : null,
        input.confidenceScore ?? 1.0,
        input.relatedIds ? JSON.stringify(input.relatedIds) : null,
        input.agentId ?? null,
        input.platform ?? null,
        now,
        now,
      );
      // Inside the txn so a failure rolls back the entry row too.
      insertEmbedding(this.sqlite, id, input.embedding);
      try { insertFts(this.sqlite, { id, title: input.title, content: input.content, tags: ftsTags(input.tags) }); } catch { /* FTS optional */ }
    });
    insertTxn();

    return (await this.findById(id))!;
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

    // Keep the FTS5 index in sync unconditionally — title/content/tags may change
    // even when the embedding is recomputed separately. Best-effort.
    if (entry) {
      try {
        updateFts(this.sqlite, {
          id,
          title: entry.title ?? '',
          content: entry.content ?? '',
          tags: ftsTags(entry.tags),
        });
      } catch { /* FTS optional */ }
    }

    // Update embedding in virtual table if provided
    if (embedding) {
      updateEmbedding(this.sqlite, id, embedding);
    }

    return entry ?? null;
  }

  /**
   * Record that these entries were actually retrieved. Feeds the cleanup cycle's
   * "unread" detection.
   *
   * Deliberately touches ONLY last_read_at / read_count — never updated_at or
   * version. A read is not an edit: bumping updated_at here would corrupt
   * findStaleEntries and silently reorder duplicate-group canonicals.
   *
   * Chunked because SQLite caps bound variables per statement.
   */
  markRead(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      this.sqlite
        .prepare(
          `UPDATE knowledge_entries
              SET last_read_at = ?, read_count = read_count + 1
            WHERE id IN (${placeholders})`
        )
        .run(now, ...chunk);
    }
  }

  async delete(id: string) {
    const [entry] = await this.db
      .delete(knowledgeEntries)
      .where(eq(knowledgeEntries.id, id))
      .returning();

    if (entry) {
      deleteEmbedding(this.sqlite, id);
      try { deleteFts(this.sqlite, id); } catch { /* FTS optional */ }
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

    // Build a distance lookup map (cosine distance from sqlite-vec)
    const distanceMap = new Map(knnResults.map((r) => [r.id, r.distance]));

    // Hybrid: also pull keyword/BM25 candidates when the raw query text is present.
    // FTS is best-effort — if the table is missing or the query throws, fall back to
    // pure semantic so search never breaks.
    let ftsResults: FtsResult[] = [];
    if (options?.queryText) {
      try { ftsResults = searchFts(this.sqlite, options.queryText, candidateLimit); } catch { ftsResults = []; }
    }
    const bm25Map = new Map(ftsResults.map((r) => [r.id, r.bm25]));

    if (knnResults.length === 0 && ftsResults.length === 0) {
      return [];
    }

    // Union candidate IDs from both retrieval paths (dedup preserves order).
    const candidateIds = [...new Set([...knnResults.map((r) => r.id), ...ftsResults.map((r) => r.id)])];

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

    // Hybrid re-rank. semantic = 1 - cosine distance (0 when not a KNN candidate);
    // bm25Norm = sigmoid(-bm25) in (0,1) (0 when not an FTS hit). Combined score
    // keeps semantic dominant (0.7) with a keyword boost (0.3). An entry is kept
    // when it clears the semantic threshold OR it explicitly matched the keyword
    // query (so keyword-only hits with weak semantics still surface).
    return entries
      .map((entry) => {
        const semantic = 1 - (distanceMap.get(entry.id) ?? 1);
        const hasFts = bm25Map.has(entry.id);
        const bm25Norm = hasFts ? 1 / (1 + Math.exp(bm25Map.get(entry.id)!)) : 0;
        const combined = 0.7 * semantic + 0.3 * bm25Norm;
        return { entry, similarity: combined, semantic, hasFts };
      })
      .filter((r) => r.semantic >= threshold || r.hasFts)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map(({ entry, similarity }) => ({ entry, similarity }));
  }

  async listRecent(
    limit = 20,
    filters?: { type?: string; scope?: string; tags?: string[]; agent?: string; platform?: string },
    offset = 0,
  ) {
    const conditions: any[] = [ne(knowledgeEntries.type, 'system')];
    if (filters?.type) conditions.push(sql`${knowledgeEntries.type} = ${filters.type}`);
    if (filters?.scope) conditions.push(sql`${knowledgeEntries.scope} = ${filters.scope}`);
    // Provenance filters round-trip the chart sentinel labels back to the stored
    // shape: the "unspecified"/"unknown" bars represent NULL rows (and, for
    // platform, also literal "unknown" written by the MCP resolver).
    if (filters?.agent) {
      conditions.push(
        filters.agent === 'unspecified'
          ? isNull(knowledgeEntries.agentId)
          : sql`${knowledgeEntries.agentId} = ${filters.agent}`,
      );
    }
    if (filters?.platform) {
      conditions.push(
        filters.platform === 'unknown'
          ? or(isNull(knowledgeEntries.platform), sql`${knowledgeEntries.platform} = 'unknown'`)
          : sql`${knowledgeEntries.platform} = ${filters.platform}`,
      );
    }
    // Tag filter: OR across the requested tags (matches searchBySimilarity + the
    // previous client-side `.some()` semantics). Reuses the json_each EXISTS pattern.
    if (filters?.tags && filters.tags.length > 0) {
      const tagConditions = filters.tags.map(
        (tag) => sql`EXISTS (SELECT 1 FROM json_each(${knowledgeEntries.tags}) WHERE value = ${tag})`,
      );
      conditions.push(or(...tagConditions));
    }

    return this.db
      .select()
      .from(knowledgeEntries)
      .where(and(...conditions))
      .orderBy(sql`${knowledgeEntries.createdAt} DESC`)
      .limit(limit)
      .offset(offset);
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

  /** Usage count for every tag (no limit/range) — feeds merge-keeper defaults. */
  async tagCounts() {
    const result = await this.db.all<{ tag: string; count: number }>(
      sql`SELECT value as tag, COUNT(*) as count FROM knowledge_entries, json_each(knowledge_entries.tags) WHERE knowledge_entries.type != 'system' GROUP BY value`
    );
    return result;
  }

  /**
   * Rename/merge a tag across all entries. Per-row correlated rebuild of the JSON
   * tags array: replace `from`→`to`, and `json_group_array(DISTINCT ...)` collapses
   * a pre-existing `to`. The `WHERE EXISTS` guard limits both the updated_at bump
   * and the affected-id list to rows that actually contain `from`. Returns the IDs
   * of the rows that changed (callers re-embed + resync FTS for these).
   */
  renameTag(from: string, to: string): string[] {
    const now = new Date().toISOString();
    const affected = this.sqlite
      .prepare(`SELECT id FROM knowledge_entries WHERE EXISTS (SELECT 1 FROM json_each(knowledge_entries.tags) WHERE value = ?)`)
      .all(from) as { id: string }[];
    if (affected.length === 0) return [];
    this.sqlite.prepare(
      `UPDATE knowledge_entries
         SET tags = (
           SELECT json_group_array(DISTINCT CASE WHEN value = @from THEN @to ELSE value END)
           FROM json_each(knowledge_entries.tags)
         ),
         updated_at = @now
       WHERE EXISTS (SELECT 1 FROM json_each(knowledge_entries.tags) WHERE value = @from)`
    ).run({ from, to, now });
    return affected.map((r) => r.id);
  }

  /**
   * Flag stale knowledge: not updated since `cutoff` (days), OR already expired,
   * OR confidence below `minConfidence`. Lightweight metadata-only query (no new
   * column / no per-entry access tracking).
   */
  async findStaleEntries(opts: { days?: number; minConfidence?: number; limit?: number } = {}) {
    const days = opts.days ?? 90;
    const minConfidence = opts.minConfidence ?? 0.5;
    const limit = opts.limit ?? 100;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const rows = this.sqlite.prepare(
      `SELECT id, title, type, scope, confidence_score AS confidenceScore, updated_at AS updatedAt, expires_at AS expiresAt
         FROM knowledge_entries
        WHERE type != 'system'
          AND (updated_at < @cutoff OR (expires_at IS NOT NULL AND expires_at < @now) OR confidence_score < @minConfidence)
        ORDER BY updated_at ASC
        LIMIT @limit`
    ).all({ cutoff, now, minConfidence, limit }) as {
      id: string; title: string; type: string; scope: string;
      confidenceScore: number; updatedAt: string; expiresAt: string | null;
    }[];
    return rows;
  }

  // ─── Cleanup cycle: detection ───────────────────────────────
  //
  // `tags` is a JSON text array, so tag predicates go through json_each — the
  // same shape renameTag already uses. Tags are normalised to lowercase on
  // write, so the control tags are matched lowercase.

  /** Entries an agent or the user explicitly marked as superseded. */
  findDeprecatedEntries(limit = 500) {
    return this.sqlite.prepare(
      `SELECT id, title, type, scope, updated_at AS updatedAt, last_read_at AS lastReadAt
         FROM knowledge_entries
        WHERE type != 'system'
          AND EXISTS (SELECT 1 FROM json_each(knowledge_entries.tags) WHERE value = 'deprecated')
        ORDER BY updated_at ASC
        LIMIT @limit`
    ).all({ limit }) as CleanupEntryRow[];
  }

  /**
   * Entries not retrieved within `days`.
   *
   * COALESCE(last_read_at, created_at) is load-bearing: `create()` never sets
   * last_read_at, so post-migration rows carry NULL, and `NULL < cutoff` is NULL
   * (never true) — a bare comparison would make this category permanently blind
   * to exactly the new entries it exists to catch.
   *
   * `created_at < cutoff` keeps a recently created but never-read entry out of
   * the bucket: it cannot have been unread for six months if it is younger.
   */
  findUnreadEntries(days: number, limit = 500) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.sqlite.prepare(
      `SELECT id, title, type, scope, updated_at AS updatedAt, last_read_at AS lastReadAt
         FROM knowledge_entries
        WHERE type != 'system'
          AND created_at < @cutoff
          AND COALESCE(last_read_at, created_at) < @cutoff
          AND NOT EXISTS (SELECT 1 FROM json_each(knowledge_entries.tags) WHERE value = 'keep')
        ORDER BY COALESCE(last_read_at, created_at) ASC
        LIMIT @limit`
    ).all({ cutoff, limit }) as CleanupEntryRow[];
  }

  /**
   * Re-check at APPLY time that an entry still qualifies for removal.
   *
   * Approval approves a predicate, not a snapshot: between report generation and
   * the user clicking approve, an entry may have been read, un-tagged, or given
   * the `keep` escape hatch. Deleting it anyway would silently bypass the user's
   * own later decision.
   */
  qualifiesForRemoval(id: string, category: 'deprecated' | 'unread', unreadDays: number): boolean {
    if (category === 'deprecated') {
      const row = this.sqlite.prepare(
        `SELECT 1 AS ok FROM knowledge_entries
          WHERE id = @id AND type != 'system'
            AND EXISTS (SELECT 1 FROM json_each(knowledge_entries.tags) WHERE value = 'deprecated')`
      ).get({ id }) as { ok: number } | undefined;
      return row?.ok === 1;
    }
    const cutoff = new Date(Date.now() - unreadDays * 24 * 60 * 60 * 1000).toISOString();
    const row = this.sqlite.prepare(
      `SELECT 1 AS ok FROM knowledge_entries
        WHERE id = @id AND type != 'system'
          AND created_at < @cutoff
          AND COALESCE(last_read_at, created_at) < @cutoff
          AND NOT EXISTS (SELECT 1 FROM json_each(knowledge_entries.tags) WHERE value = 'keep')`
    ).get({ id, cutoff }) as { ok: number } | undefined;
    return row?.ok === 1;
  }

  /** Full rows for the entries in a candidate, for snapshotting and merging. */
  getEntriesByIds(ids: string[]): any[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.sqlite.prepare(
      `SELECT id, title, content, tags, type, scope, source, version,
              related_ids AS relatedIds, agent_id AS agentId, platform,
              created_at AS createdAt, updated_at AS updatedAt,
              last_read_at AS lastReadAt, read_count AS readCount
         FROM knowledge_entries WHERE id IN (${placeholders})`
    ).all(...ids);
  }

  /** Domain fact written by migration 2.4.0 — never read schema_version for this. */
  getCleanupMeta(key: string): string | null {
    const row = this.sqlite
      .prepare('SELECT value FROM cleanup_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Most recent read across the whole base — liveness probe for read tracking. */
  maxLastReadAt(): string | null {
    const row = this.sqlite
      .prepare('SELECT MAX(last_read_at) AS maxRead FROM knowledge_entries')
      .get() as { maxRead: string | null } | undefined;
    return row?.maxRead ?? null;
  }

  /**
   * Find near-duplicate entry pairs via per-entry KNN (avoids an O(n²) full scan).
   * The embedding MUST be read from the vec table (listAll() blanks it). Canonical
   * `id < neighborId` filter dedups pairs and drops the self-match. Returns [] when
   * there are no embeddings yet.
   */
  async findDuplicatePairs(opts: { threshold?: number; limit?: number } = {}) {
    const threshold = opts.threshold ?? 0.9;
    const limit = opts.limit ?? 100;
    const { pairs } = await this.collectDuplicatePairs(threshold, 5, limit);
    return pairs
      .map((p) => ({ a: { id: p.a.id, title: p.a.title }, b: { id: p.b.id, title: p.b.title }, similarity: p.similarity }))
      .sort((x, y) => y.similarity - x.similarity)
      .slice(0, limit);
  }

  /**
   * Shared KNN pair collection for findDuplicatePairs/findDuplicateGroups.
   * `pairCap` exists only as a runaway safety net — group callers pass a large cap
   * (a truncated pair graph would split/lose cluster members in union-find).
   */
  private async collectDuplicatePairs(threshold: number, k: number, pairCap: number) {
    type Meta = { id: string; title: string; scope: string; type: string; version: number; updatedAt: string };
    const entries = await this.listAll();
    const meta = new Map<string, Meta>(entries.map((e) => [e.id, {
      id: e.id, title: e.title, scope: e.scope, type: e.type,
      version: (e as { version?: number }).version ?? 1, updatedAt: e.updatedAt,
    }]));
    const pairs: { a: Meta; b: Meta; similarity: number }[] = [];
    for (const entry of entries) {
      const emb = getEmbeddingById(this.sqlite, entry.id);
      if (!emb) continue;
      const neighbors = searchKnn(this.sqlite, emb, k);
      for (const n of neighbors) {
        if (entry.id >= n.id) continue; // canonical order + drops self
        if (!meta.has(n.id)) continue;  // skip system / missing
        const similarity = 1 - n.distance;
        if (similarity >= threshold) {
          pairs.push({ a: meta.get(entry.id)!, b: meta.get(n.id)!, similarity });
        }
      }
      if (pairs.length >= pairCap) break;
    }
    return { pairs, meta };
  }

  // KNN width for duplicate GROUPING. Per-entry KNN keeps a cluster of up to
  // ~DUP_KNN_K identical members fully connected; raise if users report a giant
  // duplicate cluster rendering as two cards.
  private static readonly DUP_KNN_K = 20;
  // Safety net only — never intended to truncate a real pair graph (105 pairs for
  // a 15-member cluster; 5000 covers pathological DBs without unbounded memory).
  private static readonly DUP_PAIR_CAP = 5000;

  /**
   * Cluster near-duplicate pairs into connected components (union-find) so N
   * copies of one entry render as ONE group, not N(N-1)/2 repeated pair rows.
   * `limit` applies to the GROUP list (size DESC, then similarity DESC) — never
   * to the underlying pair collection.
   */
  async findDuplicateGroups(opts: { threshold?: number; limit?: number } = {}) {
    const threshold = opts.threshold ?? 0.9;
    const limit = opts.limit ?? 100;
    const { pairs } = await this.collectDuplicatePairs(
      threshold, KnowledgeRepository.DUP_KNN_K, KnowledgeRepository.DUP_PAIR_CAP,
    );

    // Union-find with path compression over pair endpoints.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
      // path compression
      let cur = x;
      while (cur !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
      return root;
    };
    const union = (a: string, b: string) => {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      const ra = find(a); const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };

    const memberMeta = new Map<string, { id: string; title: string; scope: string; type: string; version: number; updatedAt: string }>();
    const maxSim = new Map<string, number>(); // tracked per root AFTER all unions below
    for (const p of pairs) {
      union(p.a.id, p.b.id);
      memberMeta.set(p.a.id, p.a);
      memberMeta.set(p.b.id, p.b);
    }
    const grouped = new Map<string, { id: string; title: string; scope: string; type: string; version: number; updatedAt: string }[]>();
    for (const m of memberMeta.values()) {
      const root = find(m.id);
      const arr = grouped.get(root) ?? [];
      arr.push(m);
      grouped.set(root, arr);
    }
    for (const p of pairs) {
      const root = find(p.a.id);
      maxSim.set(root, Math.max(maxSim.get(root) ?? 0, p.similarity));
    }

    const groups = Array.from(grouped.entries()).map(([root, members]) => {
      members.sort((a, b) => (b.version - a.version) || b.updatedAt.localeCompare(a.updatedAt));
      const groupId = members.reduce((min, m) => (m.id < min ? m.id : min), members[0].id);
      return { groupId, maxSimilarity: maxSim.get(root) ?? 0, members };
    });
    return groups
      .sort((x, y) => (y.members.length - x.members.length) || (y.maxSimilarity - x.maxSimilarity))
      .slice(0, limit);
  }

  /**
   * (Re)populate the FTS5 index from knowledge_entries. Used at startup when the
   * index is empty but entries exist (e.g. after the FTS migration on an existing
   * DB). Best-effort and idempotent (clears then re-inserts).
   */
  backfillFts(): number {
    const rows = this.sqlite.prepare(
      `SELECT id, title, content, tags FROM knowledge_entries WHERE type != 'system'`
    ).all() as { id: string; title: string; content: string; tags: string }[];
    let count = 0;
    for (const r of rows) {
      try {
        insertFts(this.sqlite, { id: r.id, title: r.title ?? '', content: r.content ?? '', tags: ftsTags(r.tags) });
        count++;
      } catch { /* best-effort */ }
    }
    return count;
  }

  /** Backfill the FTS index only when it's empty but entries exist (startup path). */
  backfillFtsIfNeeded(): number {
    try {
      if (ftsCount(this.sqlite) > 0) return 0;
      return this.backfillFts();
    } catch { return 0; }
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

  /**
   * Count entries by the agent that created them. agent_id is caller-provided and
   * NULL when not passed; COALESCE collapses NULL into a single "unspecified"
   * bucket (the chart label the frontend round-trips back to IS NULL on filter).
   */
  async countByAgent(opts: { from?: string; to?: string } = {}) {
    const { from, to } = opts;
    const conditions = [ne(knowledgeEntries.type, 'system')];
    if (from && to) {
      conditions.push(sql`${knowledgeEntries.createdAt} >= ${from}`);
      conditions.push(sql`${knowledgeEntries.createdAt} < ${to}`);
    }
    const agentLabel = sql<string>`COALESCE(${knowledgeEntries.agentId}, 'unspecified')`;
    const results = await this.db
      .select({ agent: agentLabel, count: sql<number>`count(*)` })
      .from(knowledgeEntries)
      .where(and(...conditions))
      .groupBy(agentLabel);
    return results.map((r) => ({ agent: r.agent, count: Number(r.count) }));
  }

  /**
   * Count entries by the platform that created them. platform is NULL for
   * pre-2.3.0 / dashboard-created rows and the literal "unknown" for MCP rows
   * whose client couldn't be resolved; COALESCE merges both into one "unknown"
   * bucket so they don't render as two slices.
   */
  async countByPlatform(opts: { from?: string; to?: string } = {}) {
    const { from, to } = opts;
    const conditions = [ne(knowledgeEntries.type, 'system')];
    if (from && to) {
      conditions.push(sql`${knowledgeEntries.createdAt} >= ${from}`);
      conditions.push(sql`${knowledgeEntries.createdAt} < ${to}`);
    }
    const platformLabel = sql<string>`COALESCE(${knowledgeEntries.platform}, 'unknown')`;
    const results = await this.db
      .select({ platform: platformLabel, count: sql<number>`count(*)` })
      .from(knowledgeEntries)
      .where(and(...conditions))
      .groupBy(platformLabel);
    return results.map((r) => ({ platform: r.platform, count: Number(r.count) }));
  }

  async listAll() {
    return this.db
      .select()
      .from(knowledgeEntries)
      .where(ne(knowledgeEntries.type, 'system'))
      .orderBy(sql`${knowledgeEntries.createdAt} DESC`);
  }

  /**
   * Missing-embedding sets defined by a LEFT JOIN against the existing vec0
   * shadow tables, over ALL rows including type='system' — deliberately not
   * listAll(), which excludes it and produces a permanent off-by-one.
   */
  listMissingKnowledgeEmbeddingIds(limit?: number): { id: string; updatedAt: string }[] {
    const sql = `
      SELECT e.id, e.updated_at AS updatedAt
      FROM knowledge_entries e
      LEFT JOIN knowledge_embeddings_rowids r ON r.id = e.id
      WHERE r.id IS NULL
      ORDER BY e.created_at DESC
      ${limit ? 'LIMIT ?' : ''}
    `;
    const stmt = this.sqlite.prepare(sql);
    return (limit ? stmt.all(limit) : stmt.all()) as { id: string; updatedAt: string }[];
  }

  listMissingPlanEmbeddingIds(limit?: number): { id: string; updatedAt: string }[] {
    const sql = `
      SELECT p.id, p.updated_at AS updatedAt
      FROM plans p
      LEFT JOIN plans_embeddings_rowids r ON r.id = p.id
      WHERE r.id IS NULL
      ORDER BY p.created_at DESC
      ${limit ? 'LIMIT ?' : ''}
    `;
    const stmt = this.sqlite.prepare(sql);
    return (limit ? stmt.all(limit) : stmt.all()) as { id: string; updatedAt: string }[];
  }

  embeddingCoverage(): {
    entries: number; entryEmbeddings: number; missingEntries: number;
    plans: number; planEmbeddings: number; missingPlans: number;
  } {
    // `missing*` is a LEFT JOIN, NOT a count subtraction: the two must agree with
    // listMissing*EmbeddingIds() or the check that decides whether to repair is
    // measuring something different from the repair itself. An orphan embedding
    // (a vector whose entry was deleted — possible whenever the process died
    // between the row delete and the embedding delete, which this app did on
    // every launch since 2.5.0) inflates the embedding count and makes a
    // subtraction under-report, so a genuinely incomplete index would report as
    // complete and never get backfilled.
    const row = this.sqlite.prepare(`
      SELECT
        (SELECT COUNT(*) FROM knowledge_entries)            AS entries,
        (SELECT COUNT(*) FROM knowledge_embeddings_rowids)  AS entryEmbeddings,
        (SELECT COUNT(*) FROM plans)                        AS plans,
        (SELECT COUNT(*) FROM plans_embeddings_rowids)      AS planEmbeddings,
        (SELECT COUNT(*) FROM knowledge_entries e
           LEFT JOIN knowledge_embeddings_rowids r ON r.id = e.id
          WHERE r.id IS NULL)                               AS missingEntries,
        (SELECT COUNT(*) FROM plans p
           LEFT JOIN plans_embeddings_rowids r ON r.id = p.id
          WHERE r.id IS NULL)                               AS missingPlans
    `).get() as {
      entries: number; entryEmbeddings: number; missingEntries: number;
      plans: number; planEmbeddings: number; missingPlans: number;
    };
    return row;
  }

  getKnowledgeEntryRaw(id: string): { id: string; title: string; content: string; tags: string; updatedAt: string } | undefined {
    return this.sqlite
      .prepare('SELECT id, title, content, tags, updated_at AS updatedAt FROM knowledge_entries WHERE id = ?')
      .get(id) as { id: string; title: string; content: string; tags: string; updatedAt: string } | undefined;
  }

  getPlanRaw(id: string): { id: string; title: string; content: string; updatedAt: string } | undefined {
    return this.sqlite
      .prepare('SELECT id, title, content, updated_at AS updatedAt FROM plans WHERE id = ?')
      .get(id) as { id: string; title: string; content: string; updatedAt: string } | undefined;
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

  createPlan(input: { title: string; content: string; tags: string[]; scope: string; source: string; status?: string; planFilePath?: string | null; agentId?: string | null; platform?: string | null; parentPlanId?: string | null; rootPlanId?: string | null; embedding: number[] }): any {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sqlite.prepare(
      'INSERT INTO plans (id, title, content, tags, scope, status, source, plan_file_path, agent_id, platform, parent_plan_id, root_plan_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.title, input.content, JSON.stringify(input.tags), input.scope, input.status ?? 'draft', input.source, input.planFilePath ?? null, input.agentId ?? null, input.platform ?? null, input.parentPlanId ?? null, input.rootPlanId ?? null, now, now);

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
      // Values are bound, but a column name cannot be — it is spliced into the
      // SQL text. The keys come from a strict zod object today, so this is
      // defence in depth; it exists because one `.passthrough()` upstream would
      // silently turn this line into identifier injection.
      if (!/^[a-z_]+$/.test(col)) throw new Error(`refusing unexpected column name: ${key}`);
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

  /**
   * Rollback-only: deletes the row WITHOUT repairing lineage around it. Safe for
   * a plan that cannot have children yet (createPlan's task-creation rollback).
   * Every user-facing delete goes through deletePlanWithLineageRepair instead —
   * there is no foreign key, so a stray delete here strands root_plan_id pointers.
   */
  deletePlanRow(id: string): boolean {
    // Cascade deletes plan_relations and plan_tasks via FK
    const result = this.sqlite.prepare('DELETE FROM plans WHERE id = ?').run(id);
    try { deletePlanEmbedding(this.sqlite, id); } catch { /* silent */ }
    return result.changes > 0;
  }

  // ─── Plan lineage (parent/root chains) ──────────────────────
  //
  // Raw queries only; the traversal policy lives in services/plan-lineage.ts.
  // These rows are the narrow projection a chain exposes — never plan content.

  /**
   * Every plan in the chain rooted at `rootId`, including the root itself.
   * Bounded: a runaway chain is truncated rather than materialized whole.
   */
  getPlanChainRows(rootId: string, limit: number): { id: string; title: string; status: string; scope: string; parent_plan_id: string | null; root_plan_id: string | null; created_at: string }[] {
    return this.sqlite.prepare(
      `SELECT id, title, status, scope, parent_plan_id, root_plan_id, created_at
         FROM plans
        WHERE id = ? OR root_plan_id = ?
        ORDER BY created_at ASC
        LIMIT ?`
    ).all(rootId, rootId, limit) as any[];
  }

  /** Direct children of a plan. Used by the delete-repair path. */
  getChildPlans(parentId: string): { id: string; parent_plan_id: string | null; root_plan_id: string | null }[] {
    return this.sqlite.prepare(
      'SELECT id, parent_plan_id, root_plan_id FROM plans WHERE parent_plan_id = ?'
    ).all(parentId) as any[];
  }

  /**
   * Write lineage columns directly. Separate from updatePlan so a cascade over
   * descendants does not bump their updated_at — a re-parent upstream is not an
   * edit of the plans downstream, and listPlans orders by time.
   */
  setPlanLineage(id: string, parentPlanId: string | null, rootPlanId: string | null): void {
    this.sqlite.prepare('UPDATE plans SET parent_plan_id = ?, root_plan_id = ? WHERE id = ?')
      .run(parentPlanId, rootPlanId, id);
  }

  /** Point a whole set of plans at a new root in one statement. */
  setSubtreeRoot(ids: string[], rootPlanId: string | null): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.sqlite.prepare(`UPDATE plans SET root_plan_id = ? WHERE id IN (${placeholders})`)
      .run(rootPlanId, ...ids);
  }

  /**
   * Re-parent a plan and move its subtree onto the new root atomically. The same
   * class of invariant as deletePlanWithLineageRepair: a failure between the two
   * writes leaves the plan in one chain and its descendants caching another.
   * `verify` runs inside the transaction so a concurrent writer cannot slip a
   * cycle in between the check and the write.
   */
  relinkPlanWithSubtree(
    id: string,
    parentPlanId: string | null,
    rootPlanId: string | null,
    descendantIds: string[],
    verify: () => void
  ): void {
    this.sqlite.transaction(() => {
      verify();
      this.setPlanLineage(id, parentPlanId, rootPlanId);
      if (descendantIds.length) this.setSubtreeRoot(descendantIds, rootPlanId ?? id);
    })();
  }

  /**
   * Delete a plan and repair the lineage around it atomically: children are
   * re-parented to the deleted plan's parent, and `rootRewrites` re-homes the
   * subtrees that lose their root. A partial failure would leave root_plan_id
   * values pointing at a row that no longer exists, so it is one transaction.
   * Only the target plan is ever deleted.
   */
  deletePlanWithLineageRepair(
    id: string,
    childParentId: string | null,
    childRootId: string | null,
    rootRewrites: { ids: string[]; rootPlanId: string | null }[]
  ): boolean {
    const run = this.sqlite.transaction(() => {
      for (const child of this.getChildPlans(id)) {
        this.setPlanLineage(child.id, childParentId, childRootId);
      }
      for (const rewrite of rootRewrites) {
        this.setSubtreeRoot(rewrite.ids, rewrite.rootPlanId);
      }
      return this.sqlite.prepare('DELETE FROM plans WHERE id = ?').run(id).changes > 0;
    });
    const deleted = run();
    if (deleted) {
      try { deletePlanEmbedding(this.sqlite, id); } catch { /* silent */ }
    }
    return deleted;
  }

  listAllPlans(): any[] {
    return this.sqlite.prepare('SELECT * FROM plans ORDER BY created_at DESC').all() as any[];
  }

  /**
   * @param status Zero or more plan statuses. The SDK normalises the single-string
   *   form to an array before it reaches here, so this layer handles one shape only.
   *   Values are always bound as placeholders, so the vocabulary check is NOT an
   *   injection guard — it enforces the contract for callers that never pass through
   *   an HTTP route (the SDK and the MCP server consume this service directly), so
   *   an unknown status fails loudly instead of silently returning nothing.
   */
  listPlans(limit = 20, status?: readonly string[], scope?: string, offset = 0): any[] {
    const conditions: string[] = [];
    const params: any[] = [];
    if (status?.length) {
      const invalid = status.filter((s) => !isPlanStatus(s));
      if (invalid.length) throw new Error(`unknown plan status: ${invalid.join(', ')}`);
      conditions.push(`status IN (${status.map(() => '?').join(',')})`);
      params.push(...status);
    }
    if (scope) { conditions.push('scope = ?'); params.push(scope); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    // Param order must match `LIMIT ? OFFSET ?` exactly.
    params.push(limit, offset);
    return this.sqlite.prepare(`SELECT * FROM plans ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params) as any[];
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

  /**
   * Find plans (ANY status) in the given scope or 'global' whose embedding is
   * similar to `embedding`. Unlike findSimilarActivePlans this includes completed
   * plans — they hold the richest output knowledge — and auto-includes global scope,
   * matching knowledge search. Used for plan-augmented retrieval. JS-cosine over a
   * pre-filtered candidate set (not the sqlite-vec KNN path).
   */
  findSimilarPlansAnyStatus(embedding: number[], scope: string, threshold = 0.6, limit = 3): { plan: any; similarity: number }[] {
    try {
      const candidates = this.sqlite.prepare(
        "SELECT id FROM plans WHERE scope = ? OR scope = 'global'"
      ).all(scope) as { id: string }[];
      if (!candidates.length) return [];

      const ids = candidates.map(c => c.id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = this.sqlite.prepare(
        `SELECT id, embedding FROM plans_embeddings WHERE id IN (${placeholders})`
      ).all(...ids) as { id: string; embedding: Buffer }[];
      if (!rows.length) return [];

      const queryVec = new Float32Array(embedding);
      return rows
        .map(row => {
          const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
          return { id: row.id, similarity: cosineSimilarity(queryVec, vec) };
        })
        .filter(r => r.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit)
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

  /** Upsert-safe (falls through to INSERT on zero rows — see updateEmbedding). */
  upsertEmbeddingById(id: string, embedding: number[]): void {
    updateEmbedding(this.sqlite, id, embedding);
  }

  /** Upsert-safe plan-embedding write, NOT swallowed — callers decide how to handle failure. */
  upsertPlanEmbeddingById(id: string, embedding: number[]): void {
    updatePlanEmbedding(this.sqlite, id, embedding);
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

  // operations_daily is a permanent, never-pruned daily rollup that backs the
  // dashboard Activity chart. The raw operations_log is hard-DELETE-pruned, so
  // the chart must NOT read it directly (see getOperationsByDay). Every logged
  // operation accumulates into the rollup in the same transaction as the raw
  // insert so a crash can't drift the two apart.
  private bumpOperationsDaily(operation: 'read' | 'write', isoTs: string, count: number): void {
    const day = isoTs.slice(0, 10); // UTC 'YYYY-MM-DD' — matches SQLite date(created_at)
    const reads = operation === 'read' ? count : 0;
    const writes = operation === 'write' ? count : 0;
    this.sqlite
      .prepare(
        `INSERT INTO operations_daily (date, reads, writes) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET reads = reads + excluded.reads, writes = writes + excluded.writes`
      )
      .run(day, reads, writes);
  }

  logOperation(operation: 'read' | 'write'): void {
    const now = new Date().toISOString();
    const insert = this.sqlite.transaction(() => {
      this.sqlite
        .prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)')
        .run(operation, now);
      this.bumpOperationsDaily(operation, now, 1);
    });
    insert();
  }

  logOperationBatch(operation: 'read' | 'write', count: number): void {
    if (count <= 0) return;
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare('INSERT INTO operations_log (operation, created_at) VALUES (?, ?)');
    const insertMany = this.sqlite.transaction((n: number) => {
      for (let i = 0; i < n; i++) stmt.run(operation, now);
      this.bumpOperationsDaily(operation, now, n);
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
    const DAY = 24 * 60 * 60 * 1000;
    // Read from the permanent operations_daily rollup, NOT the prunable
    // operations_log — otherwise DELETE-pruned days would render as 0. The
    // cutoff is the date-only oldest zero-fill key: a full 24-char ISO cutoff
    // would sort GREATER than a bare 'YYYY-MM-DD' row and drop the boundary day.
    const cutoff = new Date(Date.now() - (days - 1) * DAY).toISOString().slice(0, 10);
    const rows = this.sqlite.prepare(`
      SELECT date, reads, writes
      FROM operations_daily
      WHERE date >= ?
      ORDER BY date
    `).all(cutoff) as { date: string; reads: number; writes: number }[];

    const map: Record<string, { reads: number; writes: number }> = {};
    const nowMs = Date.now();
    for (let i = days - 1; i >= 0; i--) {
      // Pure-UTC stepping so the key count is exactly `days` regardless of the
      // server's local timezone / DST (setDate arithmetic could shift ±1h).
      const dateStr = new Date(nowMs - i * DAY).toISOString().split('T')[0];
      map[dateStr] = { reads: 0, writes: 0 };
    }
    for (const row of rows) {
      if (!map[row.date]) map[row.date] = { reads: 0, writes: 0 };
      map[row.date].reads = row.reads;
      map[row.date].writes = row.writes;
    }
    return Object.entries(map).map(([date, counts]) => ({ date, ...counts }));
  }

  /** Plans created per day, zero-filled for every day in the window (mirrors getOperationsByDay). */
  getPlansByDay(days: number = 15): { date: string; count: number }[] {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.sqlite.prepare(`
      SELECT date(created_at) as date, COUNT(*) as count
      FROM plans
      WHERE created_at >= ?
      GROUP BY date(created_at)
      ORDER BY date(created_at)
    `).all(cutoff) as { date: string; count: number }[];

    const map: Record<string, number> = {};
    const nowMs = Date.now();
    for (let i = days - 1; i >= 0; i--) {
      // Pure-UTC stepping (see getOperationsByDay) so the key count is exactly `days`.
      map[new Date(nowMs - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0]] = 0;
    }
    for (const row of rows) {
      map[row.date] = row.count;
    }
    return Object.entries(map).map(([date, count]) => ({ date, count }));
  }

  /**
   * Self-heal operations_daily from the still-retained raw operations_log window.
   * Uses MAX-merge (never overwrite): a stale/other process (e.g. an older MCP
   * server) may INSERT raw rows without bumping the rollup, so the raw sum can be
   * higher — take it; but a partially-pruned boundary day has a raw sum LOWER
   * than the accumulated rollup — keep the rollup. MAX is correct both ways and
   * survives the cross-process race with the live `reads + excluded` upsert.
   * MUST run BEFORE cleanupOldOperations so about-to-be-pruned rows are captured.
   */
  reconcileOperationsDaily(): number {
    return this.sqlite.prepare(`
      INSERT INTO operations_daily (date, reads, writes)
      SELECT date(created_at),
             SUM(CASE WHEN operation = 'read'  THEN 1 ELSE 0 END),
             SUM(CASE WHEN operation = 'write' THEN 1 ELSE 0 END)
      FROM operations_log
      WHERE date(created_at) IS NOT NULL
      GROUP BY date(created_at)
      ON CONFLICT(date) DO UPDATE SET
        reads  = MAX(reads,  excluded.reads),
        writes = MAX(writes, excluded.writes)
    `).run().changes;
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

  // ─── Cleanup cycle: report + candidate queue ────────────────
  //
  // Raw prepared statements rather than drizzle, deliberately: these are
  // queue-shaped tables with JSON payload columns, mirroring how
  // operations_daily is handled.

  /** Insert a report and its candidates atomically. Throws on a second open report. */
  createCleanupReport(
    report: { id: string; createdAt: string; stats: Record<string, unknown> },
    candidates: {
      id: string; category: string; entryIds: string[]; payload: Record<string, unknown>;
    }[],
  ): void {
    const insertReport = this.sqlite.prepare(
      `INSERT INTO cleanup_reports (id, created_at, status, stats) VALUES (?, ?, 'open', ?)`
    );
    const insertCandidate = this.sqlite.prepare(
      `INSERT INTO cleanup_candidates (id, report_id, category, entry_ids, payload, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    );
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      insertReport.run(report.id, report.createdAt, JSON.stringify(report.stats));
      for (const c of candidates) {
        insertCandidate.run(c.id, report.id, c.category, JSON.stringify(c.entryIds), JSON.stringify(c.payload), now);
      }
    })();
  }

  getOpenCleanupReport(): CleanupReportRow | null {
    const row = this.sqlite
      .prepare(`SELECT id, created_at AS createdAt, status, stats FROM cleanup_reports WHERE status = 'open'`)
      .get() as CleanupReportRow | undefined;
    return row ?? null;
  }

  getLatestCleanupReport(): CleanupReportRow | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, created_at AS createdAt, status, stats FROM cleanup_reports
          ORDER BY status = 'open' DESC, created_at DESC LIMIT 1`
      )
      .get() as CleanupReportRow | undefined;
    return row ?? null;
  }

  getCleanupReportById(id: string): CleanupReportRow | null {
    const row = this.sqlite
      .prepare(`SELECT id, created_at AS createdAt, status, stats FROM cleanup_reports WHERE id = ?`)
      .get(id) as CleanupReportRow | undefined;
    return row ?? null;
  }

  listCleanupCandidates(reportId: string): CleanupCandidateRow[] {
    return this.sqlite
      .prepare(
        `SELECT id, report_id AS reportId, category, entry_ids AS entryIds, payload, status,
                resolution, updated_at AS updatedAt
           FROM cleanup_candidates WHERE report_id = ? ORDER BY category, updated_at`
      )
      .all(reportId) as CleanupCandidateRow[];
  }

  getCleanupCandidate(id: string): CleanupCandidateRow | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, report_id AS reportId, category, entry_ids AS entryIds, payload, status,
                resolution, updated_at AS updatedAt
           FROM cleanup_candidates WHERE id = ?`
      )
      .get(id) as CleanupCandidateRow | undefined;
    return row ?? null;
  }

  /**
   * Atomically take ownership of a pending candidate.
   *
   * Two dashboard windows (or the sidecar and a second process) can both read a
   * candidate as `pending` and both apply it — deleting twice, or merging twice.
   * The conditional UPDATE makes the transition itself the lock: exactly one
   * caller sees changes === 1.
   *
   * The resolution written here already carries the pre-delete snapshot, so the
   * only recovery data for an irreversible delete exists BEFORE anything is
   * destroyed rather than after.
   */
  claimCleanupCandidate(id: string, resolution: Record<string, unknown>): boolean {
    const res = this.sqlite
      .prepare(
        `UPDATE cleanup_candidates SET status = 'applying', resolution = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run(JSON.stringify(resolution), new Date().toISOString(), id);
    return res.changes === 1;
  }

  /**
   * Patch a candidate. Returns whether a row actually changed.
   *
   * `expectedStatus` makes the write conditional, which matters because
   * `resolution` holds the pre-delete snapshot of entries that are already gone:
   * an unguarded write from a stale caller (a double-clicked approve, a dismiss
   * arriving after an apply) would replace the only recovery data with an error
   * string. Every caller that is not already holding the claim must pass it.
   */
  updateCleanupCandidate(
    id: string,
    patch: { status?: string; resolution?: Record<string, unknown>; expectedStatus?: string },
  ): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.resolution !== undefined) { sets.push('resolution = ?'); params.push(JSON.stringify(patch.resolution)); }
    if (sets.length === 0) return false;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString(), id);
    let where = 'id = ?';
    if (patch.expectedStatus !== undefined) { where += ' AND status = ?'; params.push(patch.expectedStatus); }
    const res = this.sqlite
      .prepare(`UPDATE cleanup_candidates SET ${sets.join(', ')} WHERE ${where}`)
      .run(...params);
    return res.changes === 1;
  }

  /**
   * Close a report: untouched candidates are dismissed and the report is sealed.
   *
   * Only `pending` rows are dismissed. An `applying` row belongs to an apply
   * that already took the claim — stealing it would let that apply's terminal
   * write fail, losing the record of entries it is in the middle of deleting.
   * A row orphaned in `applying` by a dead process is inert once its report is
   * closed (nothing reads it, and the report tally counts only `applied`).
   */
  closeCleanupReport(id: string, stats: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `UPDATE cleanup_candidates SET status = 'dismissed', updated_at = ?
            WHERE report_id = ? AND status = 'pending'`
        )
        .run(now, id);
      this.sqlite
        .prepare(`UPDATE cleanup_reports SET status = 'closed', stats = ? WHERE id = ?`)
        .run(JSON.stringify(stats), id);
    })();
  }

  countPendingCleanupCandidates(): number {
    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM cleanup_candidates c
           JOIN cleanup_reports r ON r.id = c.report_id
          WHERE r.status = 'open' AND c.status = 'pending'`
      )
      .get() as { n: number };
    return row.n;
  }
}

export interface CleanupEntryRow {
  id: string;
  title: string;
  type: string;
  scope: string;
  updatedAt: string;
  lastReadAt: string | null;
}

export interface CleanupReportRow {
  id: string;
  createdAt: string;
  status: string;
  stats: string;
}

export interface CleanupCandidateRow {
  id: string;
  reportId: string;
  category: string;
  entryIds: string;
  payload: string;
  status: string;
  resolution: string | null;
  updatedAt: string;
}

/**
 * Coerce stored tags (a JSON string from raw sqlite, or an already-parsed array
 * from drizzle's json mode) into a single space-joined string for the FTS column.
 */
function ftsTags(tags: unknown): string {
  let arr: unknown = tags;
  if (typeof tags === 'string') {
    try { arr = JSON.parse(tags); } catch { return tags; }
  }
  return Array.isArray(arr) ? arr.filter(Boolean).join(' ') : '';
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
