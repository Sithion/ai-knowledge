import { PLAN_CHAIN_MAX_DEPTH, PLAN_CHAIN_MAX_ENTRIES } from '@cognistore/shared';
import type { PlanChainEntry, KnowledgeStatus } from '@cognistore/shared';

/**
 * Plan lineage primitives.
 *
 * Plans form chains: a plan created without a reference is the ORIGINAL (root)
 * and carries `parent_plan_id = NULL, root_plan_id = NULL`; every later plan in
 * the same effort points at its parent and caches the chain's root.
 *
 * There is no foreign key (SQLite cannot add one via ALTER TABLE) and several
 * paths write these columns — the HTTP PUT route, import, concurrent MCP server
 * processes. So the data may contain dangling parents, cycles and stale roots,
 * and better-sqlite3 is synchronous: one unbounded walk would hang the sidecar
 * and every MCP server sharing the database. Every traversal here is therefore
 * bounded by a visited set AND a depth cap, and degrades to a truncated answer
 * instead of looping. Write-time validation is a convenience, never the guard.
 */

/** The minimum a row needs for lineage traversal. */
export interface LineageRow {
  id: string;
  parent_plan_id?: string | null;
  root_plan_id?: string | null;
}

/** Row lookup, satisfied by KnowledgeRepository.getPlanById. */
export interface LineageReader {
  getPlanById(id: string): LineageRow | null;
}

export interface AncestorWalk {
  /** Ids from the starting plan upward, nearest first. */
  ancestors: string[];
  /** The last id reached — the effective root when the walk completed cleanly. */
  last: string | null;
  /** True when the walk hit the depth cap or revisited an id (a cycle). */
  truncated: boolean;
}

/**
 * Walk from `startId` up through parent pointers. `startId` itself is included.
 * Stops at a plan with no parent, at a missing parent (dangling), at the depth
 * cap, or the moment an id repeats.
 */
export function walkAncestors(
  startId: string,
  reader: LineageReader,
  maxDepth: number = PLAN_CHAIN_MAX_DEPTH
): AncestorWalk {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = startId;
  let truncated = false;

  while (currentId) {
    if (visited.has(currentId)) { truncated = true; break; }
    if (ancestors.length >= maxDepth) { truncated = true; break; }
    visited.add(currentId);
    ancestors.push(currentId);

    const row = reader.getPlanById(currentId);
    if (!row) break;               // dangling parent — the chain simply ends here
    currentId = row.parent_plan_id ?? null;
  }

  return { ancestors, last: ancestors.length ? ancestors[ancestors.length - 1] : null, truncated };
}

/**
 * The root a NEW child of `parentId` should cache: the parent's own root, or the
 * parent itself when the parent is a root. Falls back to a bounded ancestor walk
 * when `root_plan_id` has drifted (NULL while a parent is set).
 * Returns null when the parent does not exist.
 */
export function deriveRoot(parentId: string, reader: LineageReader): string | null {
  const parent = reader.getPlanById(parentId);
  if (!parent) return null;
  if (parent.root_plan_id) return parent.root_plan_id;
  if (!parent.parent_plan_id) return parentId;    // parent IS the root
  return walkAncestors(parentId, reader).last ?? parentId;
}

/**
 * Is `candidateId` inside the subtree under `ancestorId`? Walking upward from the
 * candidate is O(depth) and needs no children index. Used to reject re-parenting
 * a plan under its own descendant, which would close a cycle.
 */
export function isDescendant(candidateId: string, ancestorId: string, reader: LineageReader): boolean {
  if (candidateId === ancestorId) return true;
  return walkAncestors(candidateId, reader).ancestors.includes(ancestorId);
}

/**
 * Chain titles are shown to agents and may come from a subagent that read
 * untrusted input. Control characters are stripped here (a data-integrity guard
 * every consumer needs); the length cap is display policy and belongs to the
 * consumer — the MCP tool truncates for its token budget, the dashboard
 * ellipsises in CSS.
 */
function sanitizeTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  return String(title ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface ChainRow extends LineageRow {
  id: string;
  title: string;
  status: string;
  scope: string;
  created_at: string;
}

/**
 * Order a chain's rows for display: root first, then breadth-first by depth with
 * ties broken by creation time. Rows whose parent is not present in the set
 * (dangling or truncated away) are appended rather than dropped — a chain that
 * silently loses members is worse than one that admits it is imperfect.
 */
export function buildChain(rows: ChainRow[], rootId: string, currentId: string): { chain: PlanChainEntry[]; truncated: boolean } {
  const byParent = new Map<string | null, ChainRow[]>();
  const rootRow = rows.find((r) => r.id === rootId) ?? null;

  for (const row of rows) {
    if (row.id === rootId) continue;
    const key = row.parent_plan_id ?? null;
    const bucket = byParent.get(key);
    if (bucket) bucket.push(row); else byParent.set(key, [row]);
  }

  const toEntry = (row: ChainRow, depth: number): PlanChainEntry => ({
    id: row.id,
    title: sanitizeTitle(row.title),
    status: row.status as KnowledgeStatus,
    scope: row.scope,
    parentPlanId: row.parent_plan_id ?? null,
    depth,
    isCurrent: row.id === currentId,
  });

  const chain: PlanChainEntry[] = [];
  const placed = new Set<string>();
  let truncated = rows.length >= PLAN_CHAIN_MAX_ENTRIES;

  if (rootRow) {
    chain.push(toEntry(rootRow, 0));
    placed.add(rootRow.id);
  }

  let frontier = rootRow ? [rootRow.id] : [];
  let depth = 1;
  while (frontier.length && depth <= PLAN_CHAIN_MAX_DEPTH) {
    const next: string[] = [];
    for (const parentId of frontier) {
      for (const child of byParent.get(parentId) ?? []) {
        if (placed.has(child.id)) continue;      // cycle guard
        chain.push(toEntry(child, depth));
        placed.add(child.id);
        next.push(child.id);
      }
    }
    if (!next.length) break;
    frontier = next;
    depth++;
  }
  if (depth > PLAN_CHAIN_MAX_DEPTH) truncated = true;

  for (const row of rows) {
    if (placed.has(row.id)) continue;
    chain.push(toEntry(row, 1));                 // detached from the root inside this set
    placed.add(row.id);
    truncated = true;
  }

  return { chain, truncated };
}

/** Children lookup, satisfied by KnowledgeRepository.getChildPlans. */
export interface ChildReader {
  getChildPlans(parentId: string): { id: string }[];
}

/**
 * Every plan below `planId`, found by walking parent links downward.
 *
 * Deliberately NOT a `root_plan_id` query: the descendants of a mid-chain plan
 * cache the chain's ROOT, not that plan, so a root-based query would find none of
 * them — and repairs are exactly when the cached root is the thing being changed
 * or is already wrong. Parent links are the authority; the cache is not.
 */
export function collectDescendants(planId: string, reader: ChildReader): string[] {
  const descendants: string[] = [];
  const visited = new Set<string>([planId]);
  let frontier = [planId];
  let depth = 0;

  while (frontier.length && depth < PLAN_CHAIN_MAX_DEPTH && descendants.length < PLAN_CHAIN_MAX_ENTRIES) {
    const next: string[] = [];
    for (const parentId of frontier) {
      for (const child of reader.getChildPlans(parentId)) {
        if (visited.has(child.id)) continue;      // cycle guard
        visited.add(child.id);
        descendants.push(child.id);
        next.push(child.id);
        if (descendants.length >= PLAN_CHAIN_MAX_ENTRIES) break;
      }
    }
    frontier = next;
    depth++;
  }
  return descendants;
}

/**
 * The lineage rewrites needed when `removedId` is deleted: each direct child
 * becomes the root of its own chain (NULL root), and everything below that child
 * caches the child as its new root.
 */
export function recomputeSubtreeRoot(removedId: string, reader: ChildReader): { ids: string[]; rootPlanId: string | null }[] {
  const rewrites: { ids: string[]; rootPlanId: string | null }[] = [];
  for (const child of reader.getChildPlans(removedId)) {
    rewrites.push({ ids: [child.id], rootPlanId: null });
    const descendants = collectDescendants(child.id, reader);
    if (descendants.length) rewrites.push({ ids: descendants, rootPlanId: child.id });
  }
  return rewrites;
}
