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
import { computeMergedTags, validateMergeDraft } from './cleanup-merge.js';
import { walkAncestors, deriveRoot, isDescendant, buildChain, collectDescendants, recomputeSubtreeRoot, type ChainRow } from './plan-lineage.js';
import { PLAN_CHAIN_MAX_ENTRIES } from '@cognistore/shared';
import type { PlanChain } from '@cognistore/shared';

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/** Default window for "nobody has retrieved this" (days). */
export const CLEANUP_UNREAD_DAYS = 180;
/**
 * Similarity above which two entries are proposed for consolidation. High on
 * purpose: the non-canonical members are deleted, so a false positive costs
 * real knowledge.
 */
export const CLEANUP_DUP_THRESHOLD = 0.92;
/**
 * If no read has been recorded in this many days, treat read tracking as not
 * running and suppress unread detection entirely.
 */
export const CLEANUP_READ_LIVENESS_DAYS = 14;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Domain shapes for the cleanup queue.
 *
 * The repository stores `stats` / `entry_ids` / `payload` / `resolution` as JSON
 * text. Callers get them parsed, so HTTP routes and the UI never re-implement
 * the same `JSON.parse` — the raw row types stay a repository detail.
 */
export interface CleanupReport {
  id: string;
  createdAt: string;
  status: string;
  stats: Record<string, any>;
}

export interface CleanupCandidate {
  id: string;
  reportId: string;
  category: 'deprecated' | 'unread' | 'duplicate_group' | string;
  entryIds: string[];
  payload: Record<string, any>;
  status: string;
  resolution: Record<string, any> | null;
  updatedAt: string;
}

const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

function toCleanupReport(row: { id: string; createdAt: string; status: string; stats: string }): CleanupReport {
  return { id: row.id, createdAt: row.createdAt, status: row.status, stats: parseJson(row.stats, {}) };
}

function toCleanupCandidate(row: {
  id: string; reportId: string; category: string; entryIds: string;
  payload: string; status: string; resolution: string | null; updatedAt: string;
}): CleanupCandidate {
  return {
    id: row.id,
    reportId: row.reportId,
    category: row.category,
    entryIds: parseJson<string[]>(row.entryIds, []),
    payload: parseJson(row.payload, {}),
    status: row.status,
    resolution: row.resolution ? parseJson<Record<string, any>>(row.resolution, {}) : null,
    updatedAt: row.updatedAt,
  };
}

/** Levenshtein edit distance (two-row DP). No external dependency. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
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

  /**
   * Conservative tag normalization: trim + lowercase + dedup (order-preserving).
   * Deliberately does NOT rewrite tokens (e.g. nest.js→nestjs) — that's left to
   * the explicit merge flow so meaning is never silently changed.
   */
  private normalizeTags(tags: string[] = []): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of tags) {
      const t = (raw ?? '').trim().toLowerCase();
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out;
  }

  async add(input: CreateKnowledgeInput): Promise<KnowledgeEntry & { deduplicated?: boolean }> {
    const { skipDedup, ...rest } = input;
    rest.tags = this.normalizeTags(rest.tags);
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
          // Preserve provenance on the dedup-update path: createKnowledgeSchema defaults
          // agentId/platform to null, so a re-add that omits them would otherwise wipe the
          // existing row's provenance back to NULL. Only overwrite when a non-null value is
          // supplied (last-non-null-wins); omitting keeps what was already recorded.
          const { platform, agentId, ...keep } = rest;
          const prov: { platform?: string; agentId?: string } = {};
          if (platform != null) prov.platform = platform;
          if (agentId != null) prov.agentId = agentId;
          const updated = await this.repository.update(existing.id, { ...keep, ...prov, embedding });
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
    // Inject the raw query text for the keyword/BM25 half of hybrid search. We do
    // this here (not via the schema-validated options) because the validation
    // schema would otherwise be the only place to thread it; the original query
    // string lives in this method, so pass it straight through to the repository.
    const results = await this.repository.searchBySimilarity(queryEmbedding, { ...options, queryText: query });
    this.logOp('read', results.length);
    // Retention signal for the cleanup cycle. Opt-IN by design: only callers that
    // represent real usage (the MCP getKnowledge tool, the dashboard's explicit
    // search) pass trackRead. Internal scans and browsing must not mark, or
    // nothing would ever qualify as unread.
    //
    // Deferred off the response path on purpose: better-sqlite3 is synchronous
    // and a contended write (the MCP server and the sidecar share this DB) would
    // otherwise stall the caller for up to busy_timeout. Do NOT "fix" this into
    // an inline await. Best-effort: a lost mark only delays a cleanup candidate.
    if (options?.trackRead && results.length > 0) {
      const readIds = results.map((r) => r.entry.id);
      setImmediate(() => {
        try { this.repository.markRead(readIds); } catch { /* best-effort */ }
      });
    }
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
    if (updates.tags) updates.tags = this.normalizeTags(updates.tags);
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

  async listRecent(limit = 20, filters?: { type?: string; scope?: string; tags?: string[]; agent?: string; platform?: string }, offset = 0) {
    const entries = await this.repository.listRecent(limit, filters, offset);
    return entries.map((e) => this.toKnowledgeEntry(e));
  }

  async topTags(limit = 10, opts: { from?: string; to?: string } = {}) {
    return this.repository.topTags(limit, opts);
  }

  async listTags(opts: { from?: string; to?: string } = {}): Promise<string[]> {
    return this.repository.listTags(opts);
  }

  /**
   * Suggest near-duplicate tag pairs to merge (e.g. nest.js ↔ nestjs, redis ↔ Redis).
   * Compares lowercased forms via max(normalized Levenshtein, token-set Jaccard).
   * O(n²) over the small DISTINCT tag set.
   */
  async suggestTagMerges(threshold = 0.82): Promise<{ a: string; b: string; similarity: number; countA: number; countB: number }[]> {
    const counts = new Map((await this.repository.tagCounts()).map((r) => [r.tag, r.count]));
    const tags = Array.from(counts.keys());
    const out: { a: string; b: string; similarity: number; countA: number; countB: number }[] = [];
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const sim = this.tagSimilarity(tags[i], tags[j]);
        if (sim >= threshold) {
          out.push({
            a: tags[i], b: tags[j], similarity: Math.round(sim * 100) / 100,
            countA: counts.get(tags[i]) ?? 0, countB: counts.get(tags[j]) ?? 0,
          });
        }
      }
    }
    return out.sort((x, y) => y.similarity - x.similarity);
  }

  private tagSimilarity(a: string, b: string): number {
    const la = a.trim().toLowerCase();
    const lb = b.trim().toLowerCase();
    if (!la || !lb) return 0;
    if (la === lb) return 1;
    // Normalized Levenshtein
    const lev = 1 - levenshtein(la, lb) / Math.max(la.length, lb.length);
    // Token-set Jaccard (split on non-alphanumerics) — catches nest.js vs nestjs
    const ta = new Set(la.split(/[^a-z0-9]+/).filter(Boolean));
    const tb = new Set(lb.split(/[^a-z0-9]+/).filter(Boolean));
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    const union = new Set([...ta, ...tb]).size;
    const jaccard = union ? inter / union : 0;
    return Math.max(lev, jaccard);
  }

  /**
   * Merge tag `from` into `to` across all entries, then re-embed + resync FTS for
   * affected rows. Re-embeds via repository.update (the UPDATE path), NOT the
   * insert path — and update() also resyncs the FTS row.
   */
  async mergeTag(from: string, to: string): Promise<{ merged: number }> {
    const f = (from ?? '').trim();
    const t = (to ?? '').trim();
    if (!f || !t || f === t) return { merged: 0 };
    const affected = this.repository.renameTag(f, t);
    for (const id of affected) {
      const entry = await this.repository.findById(id);
      if (!entry) continue;
      const tags = Array.isArray(entry.tags) ? entry.tags : JSON.parse((entry.tags as unknown as string) ?? '[]');
      const embedding = await this.embeddingProvider.embed(this.buildEmbeddingText(entry.title, entry.content, tags));
      await this.repository.update(id, { embedding });
    }
    if (affected.length) this.logOp('write', affected.length);
    return { merged: affected.length };
  }

  /**
   * Apply several tag merges in ONE pass. All conflict detection happens BEFORE
   * the first renameTag SQL executes, so a CONFLICT never leaves a partially
   * merged DB:
   *  - duplicate `from` mapped to different targets → CONFLICT error
   *  - cycles (a→b, b→a) → CONFLICT error
   *  - chains collapse to their terminal target (a→b, b→c ⇒ a→c, b→c), which is
   *    equivalent to sequential application: renameTag is idempotent per terminal
   *    target and json_group_array(DISTINCT …) collapses a pre-existing target.
   * Affected entry ids are UNIONED so an entry touched by two merges is re-embedded
   * exactly once, AFTER all renames (buildEmbeddingText reads the final tags).
   * Re-embeds run through repository.update (UPDATE path: FTS resync + version
   * bump — never the embedding-insert path) with bounded concurrency; one failed
   * re-embed does not abort the rest.
   */
  async mergeTagsBatch(merges: { from: string; to: string }[]): Promise<{
    applied: { from: string; to: string; count: number }[];
    entriesReembedded: number;
  }> {
    // Normalize + drop no-ops.
    const cleaned = merges
      .map((m) => ({ from: (m.from ?? '').trim(), to: (m.to ?? '').trim() }))
      .filter((m) => m.from && m.to && m.from !== m.to);
    if (cleaned.length === 0) return { applied: [], entriesReembedded: 0 };

    // Conflict detection — before ANY write.
    const target = new Map<string, string>();
    for (const m of cleaned) {
      const existing = target.get(m.from);
      if (existing !== undefined && existing !== m.to) {
        throw new Error(`CONFLICT: tag "${m.from}" is merged into multiple targets ("${existing}" and "${m.to}")`);
      }
      target.set(m.from, m.to);
    }
    // Resolve each `from` to its terminal target; a revisit of `from` ⇒ cycle.
    const terminal = new Map<string, string>();
    for (const from of target.keys()) {
      const visited = new Set<string>([from]);
      let to = target.get(from)!;
      while (target.has(to)) {
        if (visited.has(to)) {
          throw new Error(`CONFLICT: circular merge chain involving tag "${to}"`);
        }
        visited.add(to);
        to = target.get(to)!;
      }
      terminal.set(from, to);
    }

    // Apply renames (sync SQL), unioning affected ids.
    const applied: { from: string; to: string; count: number }[] = [];
    const affectedIds = new Set<string>();
    for (const [from, to] of terminal) {
      const ids = this.repository.renameTag(from, to);
      for (const id of ids) affectedIds.add(id);
      applied.push({ from, to, count: ids.length });
    }

    // Re-embed each affected entry once, bounded concurrency, failures collected.
    const ids = Array.from(affectedIds);
    await this.mapWithConcurrency(ids, 4, async (id) => {
      try {
        const entry = await this.repository.findById(id);
        if (!entry) return;
        const tags = Array.isArray(entry.tags) ? entry.tags : JSON.parse((entry.tags as unknown as string) ?? '[]');
        const embedding = await this.embeddingProvider.embed(this.buildEmbeddingText(entry.title, entry.content, tags));
        await this.repository.update(id, { embedding });
      } catch { /* tags already renamed in SQL; a stale embedding heals on next update */ }
    });

    if (affectedIds.size) this.logOp('write', affectedIds.size);
    return { applied, entriesReembedded: affectedIds.size };
  }

  /** Minimal worker-pool: run `fn` over `items` with at most `limit` in flight. */
  private async mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]);
      }
    });
    await Promise.all(workers);
  }

  async findStaleEntries(opts: { days?: number; minConfidence?: number; limit?: number } = {}) {
    return this.repository.findStaleEntries(opts);
  }

  async findDuplicatePairs(opts: { threshold?: number; limit?: number } = {}) {
    return this.repository.findDuplicatePairs(opts);
  }

  async findDuplicateGroups(opts: { threshold?: number; limit?: number } = {}) {
    return this.repository.findDuplicateGroups(opts);
  }

  // ─── Cleanup cycle ──────────────────────────────────────────

  /**
   * Build the periodic cleanup report: deprecated entries, entries unread for
   * `unreadDays`, and near-duplicate groups to consolidate.
   *
   * Detection only — nothing is deleted or merged here, and no model is called.
   * The user approves each candidate individually; these methods just describe
   * what could be removed.
   */
  async generateCleanupReport(opts: { unreadDays?: number; dupThreshold?: number } = {}) {
    const unreadDays = opts.unreadDays ?? CLEANUP_UNREAD_DAYS;
    const dupThreshold = opts.dupThreshold ?? CLEANUP_DUP_THRESHOLD;

    // Idempotent: one open report at a time. A second call while a report is
    // still open returns it rather than piling up duplicates.
    const existing = this.repository.getOpenCleanupReport();
    if (existing) return { report: toCleanupReport(existing), created: false as const };

    const candidates: { id: string; category: string; entryIds: string[]; payload: Record<string, unknown> }[] = [];
    const claimed = new Set<string>();

    // (a) explicitly deprecated
    const deprecated = this.repository.findDeprecatedEntries();
    for (const e of deprecated) {
      claimed.add(e.id);
      candidates.push({
        id: crypto.randomUUID(),
        category: 'deprecated',
        entryIds: [e.id],
        payload: { title: e.title, scope: e.scope, type: e.type, updatedAt: e.updatedAt, lastReadAt: e.lastReadAt },
      });
    }

    // (b) unread — double-gated, see unreadGateReason.
    const unreadGate = this.unreadGateReason(unreadDays);
    let unreadCount = 0;
    if (!unreadGate) {
      for (const e of this.repository.findUnreadEntries(unreadDays)) {
        if (claimed.has(e.id)) continue;
        claimed.add(e.id);
        unreadCount++;
        candidates.push({
          id: crypto.randomUUID(),
          category: 'unread',
          entryIds: [e.id],
          payload: { title: e.title, scope: e.scope, type: e.type, updatedAt: e.updatedAt, lastReadAt: e.lastReadAt },
        });
      }
    }

    // (c) near-duplicate groups to consolidate into the newest member.
    let groupCount = 0;
    let groupMemberTotal = 0;
    const groups = await this.repository.findDuplicateGroups({ threshold: dupThreshold });
    for (const g of groups) {
      // An entry already queued for deletion must not also be merged. Drop it
      // from the group; a group that falls below two members is not a group.
      const members = g.members.filter((m) => !claimed.has(m.id));
      if (members.length < 2) continue;
      // The repository sorts members by version DESC first, so members[0] is the
      // most-EDITED entry, not the newest. The user's rule is "newest wins", and
      // the losers are deleted — so re-sort here rather than trusting that order.
      members.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const [canonical, ...rest] = members;
      for (const m of members) claimed.add(m.id);
      groupCount++;
      groupMemberTotal += rest.length;
      candidates.push({
        id: crypto.randomUUID(),
        category: 'duplicate_group',
        entryIds: [canonical.id, ...rest.map((m) => m.id)],
        payload: {
          maxSimilarity: g.maxSimilarity,
          // Pinned so apply can detect the canonical changing under the user.
          canonicalUpdatedAt: canonical.updatedAt,
          members: members.map((m) => ({ id: m.id, title: m.title, scope: m.scope, updatedAt: m.updatedAt })),
        },
      });
    }

    const stats: Record<string, unknown> = {
      // Pin the parameters the user is reviewing: apply re-validates against
      // THESE, not against whatever the settings say later.
      unreadDays,
      dupThreshold,
      generatedAt: new Date().toISOString(),
      counts: {
        deprecated: deprecated.length,
        unread: unreadCount,
        duplicateGroups: groupCount,
        removableEntries: deprecated.length + unreadCount + groupMemberTotal,
      },
    };
    if (unreadGate) stats.unreadGate = unreadGate;

    const report = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), stats };
    try {
      this.repository.createCleanupReport(report, candidates);
    } catch (err: any) {
      // Lost the race against another generator: the unique partial index on
      // status='open' rejected us. Return theirs.
      const open = this.repository.getOpenCleanupReport();
      if (open) return { report: toCleanupReport(open), created: false as const };
      throw err;
    }
    this.logOp('write');
    return { report: toCleanupReport(this.repository.getCleanupReportById(report.id)!), created: true as const };
  }

  /**
   * Why unread detection is suppressed, or null when it may run.
   *
   * Two independent gates, both necessary:
   *  - AGE: at install the backfill sets last_read_at = now for every entry, so
   *    "unread for 180 days" is only meaningful once tracking has existed that
   *    long. Reading it from cleanup_meta (written by the migration) rather than
   *    schema_version keeps this a domain fact, not migration bookkeeping.
   *  - LIVENESS: reads mostly arrive through the npx-published MCP server. A
   *    user still on a pre-2.4.0 build reads constantly and records nothing —
   *    after which every heavily-used entry looks abandoned. If no read has been
   *    recorded recently, the signal is not trustworthy and we stay silent.
   */
  private unreadGateReason(unreadDays: number): string | null {
    const since = this.repository.getCleanupMeta('read_tracking_since');
    if (!since) return 'read tracking has not been initialised yet';
    const elapsedDays = (Date.now() - Date.parse(since)) / 86_400_000;
    if (!Number.isFinite(elapsedDays)) return 'read tracking start timestamp is unreadable';
    if (elapsedDays < unreadDays) {
      const activatesAt = new Date(Date.parse(since) + unreadDays * 86_400_000).toISOString();
      return `read tracking started ${Math.floor(elapsedDays)}d ago; unread detection activates ${activatesAt.slice(0, 10)}`;
    }
    const lastRead = this.repository.maxLastReadAt();
    if (!lastRead) return 'no reads have ever been recorded — read tracking may not be active';
    const staleDays = (Date.now() - Date.parse(lastRead)) / 86_400_000;
    if (staleDays > CLEANUP_READ_LIVENESS_DAYS) {
      return `no read recorded in ${Math.floor(staleDays)}d — read tracking appears inactive (outdated MCP server?)`;
    }
    return null;
  }

  getLatestCleanupReport(): { report: CleanupReport; candidates: CleanupCandidate[] } | null {
    const report = this.repository.getLatestCleanupReport();
    if (!report) return null;
    return {
      report: toCleanupReport(report),
      candidates: this.repository.listCleanupCandidates(report.id).map(toCleanupCandidate),
    };
  }

  getCleanupCandidate(id: string): CleanupCandidate | null {
    const row = this.repository.getCleanupCandidate(id);
    return row ? toCleanupCandidate(row) : null;
  }

  /**
   * The entries still backing a candidate, for previewing a merge. Rows may be
   * missing: entries can be deleted between report generation and review.
   */
  getEntriesForCleanupCandidate(candidateId: string): any[] {
    const candidate = this.repository.getCleanupCandidate(candidateId);
    if (!candidate) return [];
    return this.repository.getEntriesByIds(parseJson<string[]>(candidate.entryIds, []));
  }

  /**
   * The tags a merge WOULD produce, so the preview shows the real outcome.
   * Advisory only — apply recomputes them from freshly-read members.
   */
  previewMergedTags(members: { tags: string[] }[]): string[] {
    return computeMergedTags(members as any);
  }

  countPendingCleanupCandidates(): number {
    return this.repository.countPendingCleanupCandidates();
  }

  /**
   * Delete the entries behind a `deprecated` / `unread` candidate.
   *
   * Rejects duplicate_group on purpose: that category's entry_ids start with the
   * CANONICAL, so treating it as a removal would delete the very entry meant to
   * survive, along with the whole group.
   */
  async applyRemovalCandidate(candidateId: string) {
    const candidate = this.repository.getCleanupCandidate(candidateId);
    if (!candidate) throw new Error('Cleanup candidate not found');
    if (candidate.category !== 'deprecated' && candidate.category !== 'unread') {
      throw new Error(`applyRemovalCandidate cannot handle category "${candidate.category}"`);
    }
    const unreadDays = this.reportUnreadDays(candidate.reportId);
    const ids: string[] = JSON.parse(candidate.entryIds);

    // Re-validate NOW: the user approved a predicate, and between generation and
    // this click an entry may have been read, un-tagged, or marked `keep`.
    const qualifying = ids.filter((id) =>
      this.repository.qualifiesForRemoval(id, candidate.category as 'deprecated' | 'unread', unreadDays)
    );
    const skipped = ids.filter((id) => !qualifying.includes(id));

    // Snapshot BEFORE deleting and inside the claim, so the only recovery data
    // for an irreversible delete exists even if the process dies mid-apply.
    const snapshot = this.repository.getEntriesByIds(qualifying);
    if (!this.repository.claimCleanupCandidate(candidateId, {
      intendedIds: qualifying, skipped, deletedSnapshot: snapshot,
    })) {
      throw new Error('Cleanup candidate is not pending (already applied or dismissed)');
    }

    try {
      const result = qualifying.length > 0
        ? await this.bulkDelete(qualifying)
        : { deleted: 0, errors: [] as string[] };
      // expectedStatus pins this to the claim we took. Without it, a terminal
      // write could land on a candidate whose report was sealed meanwhile,
      // recording deletions the closed report's tally never counted.
      this.repository.updateCleanupCandidate(candidateId, {
        status: 'applied',
        expectedStatus: 'applying',
        resolution: {
          deletedIds: qualifying, deleted: result.deleted, skipped,
          errors: result.errors, deletedSnapshot: snapshot,
        },
      });
      return { deleted: result.deleted, skipped: skipped.length, errors: result.errors };
    } catch (err: any) {
      this.repository.updateCleanupCandidate(candidateId, {
        status: 'failed',
        expectedStatus: 'applying',
        resolution: { error: err?.message ?? String(err), intendedIds: qualifying, deletedSnapshot: snapshot },
      });
      throw err;
    }
  }

  /**
   * Consolidate a duplicate group into its canonical entry.
   *
   * The caller supplies only title + content (from the LLM or the deterministic
   * fallback, always after the user has seen it). Tags are recomputed HERE from
   * the re-fetched members — a client cannot choose them, so it cannot inject
   * the `deprecated`/`keep` control tags and rig the next cycle.
   */
  async applyConsolidationCandidate(candidateId: string, draft: unknown, usedLlm = false) {
    const candidate = this.repository.getCleanupCandidate(candidateId);
    if (!candidate) throw new Error('Cleanup candidate not found');
    if (candidate.category !== 'duplicate_group') {
      throw new Error(`applyConsolidationCandidate cannot handle category "${candidate.category}"`);
    }
    // Bail out BEFORE the stale-check below, which writes to the candidate. A
    // second approval of an already-applied group always looks "stale" (its
    // members are gone), and an unguarded failure write would replace the
    // resolution — including the pre-delete snapshot of the entries it just
    // destroyed — with an error string.
    if (candidate.status !== 'pending') {
      throw new Error('Cleanup candidate is not pending (already applied or dismissed)');
    }
    const validated = validateMergeDraft(draft);
    const ids: string[] = JSON.parse(candidate.entryIds);
    const payload = JSON.parse(candidate.payload ?? '{}');

    const rows = this.repository.getEntriesByIds(ids);
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    const canonical = byId.get(ids[0]);
    const survivors = ids.filter((id) => byId.has(id));

    // Abort rather than half-merge if the world moved: the canonical vanished,
    // it was edited since the report (so the user reviewed stale text), or the
    // group no longer has anything to merge.
    const stale =
      !canonical ? 'canonical entry no longer exists'
      : survivors.length < 2 ? 'fewer than two members still exist'
      : payload.canonicalUpdatedAt && canonical.updatedAt !== payload.canonicalUpdatedAt
        ? 'canonical entry was modified after the report was generated'
        : null;
    if (stale) {
      // Conditional: another process may have claimed it since the read above.
      this.repository.updateCleanupCandidate(candidateId, {
        status: 'failed', resolution: { error: stale }, expectedStatus: 'pending',
      });
      throw new Error(`Consolidation aborted: ${stale}`);
    }

    const members = survivors.map((id) => {
      const r: any = byId.get(id);
      return {
        id: r.id, title: r.title, content: r.content,
        tags: Array.isArray(r.tags) ? r.tags : JSON.parse(r.tags ?? '[]'),
        updatedAt: r.updatedAt,
      };
    });
    const toDelete = survivors.slice(1);
    const mergedTags = computeMergedTags(members);
    // Union of every member's relations, minus the ids about to disappear and
    // the canonical itself — a member pointing at the survivor would otherwise
    // leave the merged entry related to itself.
    const relatedIds = Array.from(new Set(
      members.flatMap((m) => {
        const r: any = byId.get(m.id);
        const rel = r.relatedIds ? (Array.isArray(r.relatedIds) ? r.relatedIds : JSON.parse(r.relatedIds)) : [];
        return Array.isArray(rel) ? rel : [];
      })
    ))
      .filter((id: string) => UUID_RE.test(id) && !toDelete.includes(id) && id !== canonical.id)
      .slice(0, 50);

    const snapshot = this.repository.getEntriesByIds(toDelete);
    if (!this.repository.claimCleanupCandidate(candidateId, {
      canonicalId: canonical.id, intendedIds: toDelete, deletedSnapshot: snapshot, usedLlm,
    })) {
      throw new Error('Cleanup candidate is not pending (already applied or dismissed)');
    }

    try {
      // Only these four fields. Passing agentId/platform/confidenceScore here
      // would null-wipe them (the update schema defaults them to null), and
      // `version` is not accepted at all — repository.update bumps it itself.
      const updated = await this.update(canonical.id, {
        title: validated.title,
        content: validated.content,
        tags: mergedTags,
        relatedIds: relatedIds.length > 0 ? relatedIds : null,
      });
      if (!updated) throw new Error('Failed to update the canonical entry');

      // Delete members only AFTER the canonical survives the update. A crash
      // between the two leaves the merged canonical plus its duplicates, which
      // the next cycle simply re-detects — never content loss.
      const result = await this.bulkDelete(toDelete);
      // See applyRemovalCandidate: the terminal write is pinned to our claim.
      this.repository.updateCleanupCandidate(candidateId, {
        status: 'applied',
        expectedStatus: 'applying',
        resolution: {
          canonicalId: canonical.id, deletedIds: toDelete, deleted: result.deleted,
          errors: result.errors, usedLlm, deletedSnapshot: snapshot,
        },
      });
      return { canonicalId: canonical.id, deleted: result.deleted, errors: result.errors };
    } catch (err: any) {
      this.repository.updateCleanupCandidate(candidateId, {
        status: 'failed',
        expectedStatus: 'applying',
        resolution: { error: err?.message ?? String(err), canonicalId: canonical.id, deletedSnapshot: snapshot },
      });
      throw err;
    }
  }

  /**
   * Decline a candidate. Only a pending one can be dismissed: dismissing an
   * applied candidate would erase it from the report's removal tally and hide
   * that entries were in fact deleted.
   */
  dismissCleanupCandidate(candidateId: string): void {
    const candidate = this.repository.getCleanupCandidate(candidateId);
    if (!candidate) throw new Error('Cleanup candidate not found');
    if (!this.repository.updateCleanupCandidate(candidateId, {
      status: 'dismissed', expectedStatus: 'pending',
    })) {
      throw new Error('Cleanup candidate is not pending (already applied or dismissed)');
    }
  }

  /** Seal a report, tallying what was actually removed while it was open. */
  closeCleanupReport(reportId: string, extraStats: Record<string, unknown> = {}) {
    const report = this.repository.getCleanupReportById(reportId);
    if (!report) throw new Error('Cleanup report not found');
    const candidates = this.repository.listCleanupCandidates(reportId);
    let removed = 0;
    for (const c of candidates) {
      if (c.status !== 'applied' || !c.resolution) continue;
      try { removed += JSON.parse(c.resolution).deleted ?? 0; } catch { /* ignore */ }
    }
    const stats = { ...JSON.parse(report.stats || '{}'), ...extraStats, removed, closedAt: new Date().toISOString() };
    this.repository.closeCleanupReport(reportId, stats);
    return { removed };
  }

  /** The unreadDays the report was generated with — never the live setting. */
  private reportUnreadDays(reportId: string): number {
    const report = this.repository.getCleanupReportById(reportId);
    if (!report) return CLEANUP_UNREAD_DAYS;
    try {
      const stats = JSON.parse(report.stats || '{}');
      return typeof stats.unreadDays === 'number' ? stats.unreadDays : CLEANUP_UNREAD_DAYS;
    } catch {
      return CLEANUP_UNREAD_DAYS;
    }
  }

  /** (Re)populate the FTS5 index if it's empty but entries exist. Returns rows indexed. */
  backfillFtsIfNeeded(): number {
    return this.repository.backfillFtsIfNeeded();
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

  async countByAgent(opts: { from?: string; to?: string } = {}) {
    return this.repository.countByAgent(opts);
  }

  async countByPlatform(opts: { from?: string; to?: string } = {}) {
    return this.repository.countByPlatform(opts);
  }

  // ─── Plans (separate entity) ────────────────────────────────

  async createPlan(input: CreatePlanInput & { tasks?: { description: string; priority?: string }[]; skipDedup?: boolean }): Promise<Plan & { deduplicated?: boolean; deduplicatedAction?: string; dedupSkipped?: boolean; nearestSimilarity?: number; nearestPlanId?: string; hint?: string; lineageWarning?: string }> {
    const { tasks, skipDedup, ...planInput } = input;
    const embedding = await this.embeddingProvider.embed(`${input.title} ${input.content}`);

    // ─── Lineage: resolve the parent before anything else. ───
    // A plan created without a parent is the ORIGINAL of a new chain. An
    // unresolvable parent never fails the call — an agent mid-effort would lose
    // its plan over a stale id — it creates a root and says so in the response.
    let parentPlanId: string | null = planInput.parentPlanId ?? null;
    let rootPlanId: string | null = null;
    let lineageWarning: string | undefined;
    if (parentPlanId) {
      // One policy, one place: anything that does not resolve to a real plan —
      // a malformed id an agent invented, or one that has since been deleted —
      // downgrades to a root with a warning. Creating a plan must never fail
      // over its lineage; an agent mid-effort would lose the whole plan.
      const derivedRoot = deriveRoot(parentPlanId, this.repository);
      if (derivedRoot === null) {
        lineageWarning = `parentPlanId "${parentPlanId}" does not exist — this plan was created as a new ORIGINAL (root) instead.`;
        parentPlanId = null;
      } else {
        rootPlanId = derivedRoot;
      }
    }

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
        const linkNote = this.linkMergedPlan(existingRow.id, parentPlanId);
        // Re-read whenever a parent was requested: linkMergedPlan writes the
        // lineage columns in place, so the row captured above is stale exactly
        // when the link SUCCEEDED (linkNote undefined). The draft branch below
        // re-reads unconditionally for the same reason.
        if (parentPlanId) { activeRow = this.repository.getPlanById(existingRow.id) ?? activeRow; }
        const plan = this.toPlan(activeRow);
        return { ...plan, deduplicated: true, deduplicatedAction: 'tasks_added_to_active_plan', lineageWarning: linkNote ?? lineageWarning };
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
        const linkNote = this.linkMergedPlan(existingRow.id, parentPlanId);
        const updated = this.repository.getPlanById(existingRow.id);
        const plan = this.toPlan(updated);
        return { ...plan, deduplicated: true, deduplicatedAction: 'draft_plan_updated', lineageWarning: linkNote ?? lineageWarning };
      }
      // Active but below the active-merge bar → keep separate; create a new plan.
    }

    // No (close enough) duplicate — create normally.
    const row = this.repository.createPlan({ ...planInput, parentPlanId, rootPlanId, embedding });
    const plan = this.toPlan(row);

    if (tasks && tasks.length > 0) {
      try {
        for (let i = 0; i < tasks.length; i++) {
          this.repository.createPlanTask({ planId: plan.id, description: tasks[i].description, priority: tasks[i].priority, position: i });
        }
      } catch (err) {
        this.repository.deletePlanRow(plan.id);
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
        lineageWarning,
      };
    }

    return { ...plan, lineageWarning };
  }

  /**
   * Dedup merged a new plan into an existing one, and the caller named a parent.
   * Adopt it only when doing so cannot close a cycle: the merge target must not
   * already have a parent, must not BE the parent, and the parent must not live
   * in the target's own subtree (dedup matches on similarity and happily picks a
   * descendant of the plan you were pointing at).
   * Returns a note when the link was skipped, so the agent is not left believing
   * a chain exists that does not.
   */
  private linkMergedPlan(targetId: string, parentPlanId: string | null): string | undefined {
    if (!parentPlanId) return undefined;
    const target = this.repository.getPlanById(targetId);
    if (!target) return undefined;

    if (targetId === parentPlanId) {
      return `Merged into plan "${targetId}", which is the parentPlanId you passed — no lineage link was added.`;
    }
    if (target.parent_plan_id) {
      return target.parent_plan_id === parentPlanId
        ? undefined
        : `Merged into plan "${targetId}", which already belongs to another chain (parent "${target.parent_plan_id}") — its lineage was left unchanged.`;
    }
    if (isDescendant(parentPlanId, targetId, this.repository)) {
      return `Merged into plan "${targetId}", which is an ancestor of the parentPlanId you passed — linking would close a cycle, so lineage was left unchanged.`;
    }

    const rootPlanId = deriveRoot(parentPlanId, this.repository);
    if (rootPlanId === null) return undefined;
    this.repository.setPlanLineage(targetId, parentPlanId, rootPlanId);
    // Everything already hanging off the merge target moves to the new chain.
    const descendants = collectDescendants(targetId, this.repository);
    if (descendants.length) this.repository.setSubtreeRoot(descendants, rootPlanId);
    return undefined;
  }

  getPlanById(id: string): Plan | null {
    const row = this.repository.getPlanById(id);
    return row ? this.toPlan(row) : null;
  }

  updatePlan(id: string, updates: UpdatePlanInput): Plan | null {
    // Lineage is validated HERE, not at the tool layer: the MCP server, the SDK
    // and the dashboard's PUT route all converge on this method, and only the
    // PUT route runs a zod schema. This is the one choke point they share.
    const { parentPlanId, rootPlanId: _ignoredRoot, ...rest } = updates;
    // `null` is the explicit UNLINK signal, but a bare `undefined` is not: a
    // caller that spreads an options object (or an MCP client that materializes
    // absent optional keys) would otherwise silently detach the plan and re-root
    // its entire subtree on a plain title/status update. Only a present, defined
    // value — or an explicit null — counts as a relink request.
    const relinking = Object.prototype.hasOwnProperty.call(updates, 'parentPlanId') && parentPlanId !== undefined;

    // Validate the relink BEFORE writing `rest`: the two are separate statements,
    // so a rejection raised afterwards would leave the status/content edit
    // committed while the caller sees only an error. Skipped when the plan does
    // not exist — that case must still answer null, not throw.
    if (relinking && this.repository.getPlanById(id)) {
      this.validateRelink(id, parentPlanId ?? null);
    }

    const row = this.repository.updatePlan(id, rest as Record<string, unknown>);
    if (!row) return null;

    if (relinking) {
      this.relinkPlan(id, parentPlanId ?? null);
    }

    // Guard: when plan is completed, auto-complete all incomplete tasks
    if (updates.status === 'completed') {
      const tasks = this.repository.listPlanTasks(id);
      for (const t of tasks) {
        if ((t as any).status !== 'completed') {
          this.repository.updatePlanTask((t as any).id, { status: 'completed' });
        }
      }
    }

    return this.toPlan(relinking ? (this.repository.getPlanById(id) ?? row) : row);
  }

  /**
   * Reject the two ways a re-parent can corrupt the graph — parenting a plan to
   * itself, or to one of its own descendants — because a cycle here would
   * bound-truncate every later read. Returns the root the plan should cache.
   * Pure validation: callable before any write has happened.
   */
  private validateRelink(id: string, parentPlanId: string | null): string | null {
    if (parentPlanId === id) {
      throw new Error('A plan cannot be its own parent.');
    }
    if (!parentPlanId) return null;
    if (!this.repository.getPlanById(parentPlanId)) {
      throw new Error(`parentPlanId "${parentPlanId}" does not exist.`);
    }
    if (isDescendant(parentPlanId, id, this.repository)) {
      throw new Error(`parentPlanId "${parentPlanId}" is a descendant of plan "${id}" — linking them would create a cycle.`);
    }
    return deriveRoot(parentPlanId, this.repository);
  }

  /**
   * Re-parent a plan after the fact (or unlink it with `parentPlanId = null`),
   * then move its whole subtree onto the new root. Re-validates: it is also
   * reachable from paths that did not pre-validate.
   */
  private relinkPlan(id: string, parentPlanId: string | null): void {
    const newRoot = this.validateRelink(id, parentPlanId);

    // Descendants are found by walking parent links, not by the cached root: the
    // plans below a mid-chain plan cache the CHAIN's root, so a root query would
    // return nothing and their lineage would silently stay behind.
    const descendants = collectDescendants(id, this.repository);

    // One transaction, and the cycle check runs again inside it: two MCP server
    // processes can otherwise both pass the check and then write a cycle.
    // Unlinking makes this plan the root of what hangs below it.
    this.repository.relinkPlanWithSubtree(id, parentPlanId, newRoot, descendants, () => {
      this.validateRelink(id, parentPlanId);
    });
  }

  /**
   * The whole chain a plan belongs to, root first. Accepts any member: the root
   * is resolved before the chain is read, so passing a leaf returns the full
   * chain rather than its own subtree.
   */
  getPlanChain(planId: string): PlanChain | null {
    const row = this.repository.getPlanById(planId);
    if (!row) return null;

    // root_plan_id is a cache and can drift (an interrupted cascade, a foreign
    // import). Falling back to a bounded parent walk keeps the chain readable.
    let rootId: string = row.root_plan_id ?? planId;
    let walkTruncated = false;
    if (!row.root_plan_id && row.parent_plan_id) {
      const walk = walkAncestors(planId, this.repository);
      rootId = walk.last ?? planId;
      walkTruncated = walk.truncated;
    }

    const rows = this.repository.getPlanChainRows(rootId, PLAN_CHAIN_MAX_ENTRIES) as ChainRow[];

    // The chain query matches on the cached root, so a plan whose root has
    // drifted would be missing from its own chain. Pull the ancestor path in by
    // id and merge it, rather than answering with a chain that omits the very
    // plan that was asked about.
    if (!rows.some((r) => r.id === planId)) {
      const seen = new Set(rows.map((r) => r.id));
      const walk = walkAncestors(planId, this.repository);
      walkTruncated = walkTruncated || walk.truncated;
      for (const ancestorId of walk.ancestors) {
        if (seen.has(ancestorId)) continue;
        const ancestorRow = this.repository.getPlanById(ancestorId);
        if (ancestorRow) { rows.push(ancestorRow as ChainRow); seen.add(ancestorId); }
      }
    }

    const { chain, truncated } = buildChain(rows, rootId, planId);
    // A walk that hit the depth cap or a cycle means the answer is partial even
    // when the chain itself fit — otherwise a cyclic chain reports truncated:false.
    return { rootPlanId: rootId, chain, truncated: truncated || walkTruncated };
  }

  deletePlan(id: string): boolean {
    const row = this.repository.getPlanById(id);
    if (!row) return false;

    // Repair the lineage around the hole this leaves: children move up to the
    // deleted plan's own parent. Deleting a root instead promotes each direct
    // child to root of its own subtree, so nothing keeps caching a dead id.
    // A parent that no longer exists is treated as no parent: re-parenting the
    // children onto a dead id would just move the dangling reference down.
    const rawParentId: string | null = row.parent_plan_id ?? null;
    const parentId = rawParentId && this.repository.getPlanById(rawParentId) ? rawParentId : null;
    const rootRewrites = parentId ? [] : recomputeSubtreeRoot(id, this.repository);
    const childRoot = parentId ? (row.root_plan_id ?? parentId) : null;

    return this.repository.deletePlanWithLineageRepair(id, parentId, childRoot, rootRewrites);
  }

  listAllPlans(): Plan[] {
    const rows = this.repository.listAllPlans();
    return rows.map((r) => this.toPlan(r));
  }

  listPlans(limit = 20, status?: string, scope?: string, offset = 0): Plan[] {
    const rows = this.repository.listPlans(limit, status, scope, offset);
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
        // Lineage is instance-local: ids are regenerated on import, so a parent
        // or root from the exporting machine either dangles or — worse — collides
        // with a real local plan and grafts foreign content into a live chain.
        const { tasks, parentPlanId: _importedParent, rootPlanId: _importedRoot, ...planInput } = plan as typeof plan & { rootPlanId?: string | null };
        const embedding = await this.embeddingProvider.embed(planInput.tags.join(' '));
        const row = this.repository.createPlan({ ...planInput, parentPlanId: null, rootPlanId: null, embedding });
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

  deletePlanTask(id: string): { deleted: boolean; planId: string; planStatus: string; progress: string; autoActions: string[] } {
    // Capture the parent plan BEFORE deleting — afterwards the task row is gone.
    const planId = this.repository.getTaskPlanId(id) ?? '';
    const deleted = this.repository.deletePlanTask(id);
    if (!deleted) {
      return { deleted: false, planId: '', planStatus: 'unknown', progress: '0/0 completed', autoActions: [] };
    }

    const autoActions: string[] = [];
    if (planId) {
      // Auto-complete the plan when removing the task leaves all remaining tasks done.
      // Guard: only when ≥1 task remains (do NOT complete an emptied plan) and the plan is active.
      const remaining = this.repository.listPlanTasks(planId);
      const incomplete = this.repository.countIncompleteTasks(planId);
      const plan = this.repository.getPlanById(planId);
      if (remaining.length > 0 && incomplete === 0 && plan?.status === 'active') {
        this.repository.updatePlan(planId, { status: 'completed' });
        autoActions.push('Plan auto-completed — all remaining tasks done');
      }
    }

    const currentPlan = planId ? this.repository.getPlanById(planId) : null;
    const allTasks = planId ? this.repository.listPlanTasks(planId) : [];
    const completedCount = allTasks.filter((t: any) => t.status === 'completed').length;
    const progress = `${completedCount}/${allTasks.length} completed`;

    return {
      deleted: true,
      planId,
      planStatus: currentPlan?.status ?? 'unknown',
      progress,
      autoActions,
    };
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

  getPlansByDay(days: number = 15) {
    return this.repository.getPlansByDay(days);
  }

  reconcileOperationsDaily() {
    return this.repository.reconcileOperationsDaily();
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
      agentId: row.agentId ?? row.agent_id ?? null,
      platform: row.platform ?? null,
      lastReadAt: row.lastReadAt ?? row.last_read_at
        ? new Date(row.lastReadAt ?? row.last_read_at)
        : null,
      readCount: row.readCount ?? row.read_count ?? 0,
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
      agentId: row.agent_id ?? row.agentId ?? null,
      platform: row.platform ?? null,
      parentPlanId: row.parent_plan_id ?? row.parentPlanId ?? null,
      rootPlanId: row.root_plan_id ?? row.rootPlanId ?? null,
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
