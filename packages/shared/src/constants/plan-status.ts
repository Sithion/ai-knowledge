import { KnowledgeStatus } from '../types/knowledge.js';

/**
 * The plan status vocabulary — single source of truth.
 *
 * Built from the `KnowledgeStatus` enum on purpose — a literal copy here would be
 * a second definition in the very package that already owns the vocabulary, and
 * the two would drift silently. The tuple only fixes the ORDER (which is also the
 * order the dashboard renders the filter chips in).
 *
 * Naming caveat: `knowledge_entries` has no `status` column, so `KnowledgeStatus`
 * is really the PLAN status enum under an inherited name. Renaming it is
 * workspace-confined but touches ~40 call sites, so it is recorded rather than done.
 *
 * Must stay in sync with the `CHECK(status IN (...))` constraint on the `plans`
 * table, which exists in TWO places: packages/core/src/db/migrate.ts and
 * packages/core/src/db/migrations/0.9.0.sql. `sdk-plans.test.ts` asserts the match.
 *
 * Everything that validates or filters a plan status imports this: the MCP tool
 * schemas, the `/api/plans` route, the repository's IN-clause guard, and the
 * dashboard's filter chips.
 *
 * This module is reachable via the `@cognistore/shared/constants` subpath, which
 * the browser bundle imports. Keep its transitive imports free of runtime
 * dependencies (today: types only) or zod lands in the frontend bundle.
 */
export const PLAN_STATUS_VALUES = [
  KnowledgeStatus.DRAFT,
  KnowledgeStatus.ACTIVE,
  KnowledgeStatus.COMPLETED,
  KnowledgeStatus.ARCHIVED,
] as const;

export type PlanStatus = (typeof PLAN_STATUS_VALUES)[number];

export const isPlanStatus = (v: unknown): v is PlanStatus =>
  typeof v === 'string' && (PLAN_STATUS_VALUES as readonly string[]).includes(v);
