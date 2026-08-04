import { z } from 'zod';
import { KnowledgeType, KnowledgeStatus, TaskStatus, TaskPriority } from '../types/knowledge.js';
import { DEFAULT_SIMILARITY_THRESHOLD, DEFAULT_SEARCH_LIMIT } from '../constants/defaults.js';

export const knowledgeTypeSchema = z.nativeEnum(KnowledgeType);
export const knowledgeStatusSchema = z.nativeEnum(KnowledgeStatus);
export const taskStatusSchema = z.nativeEnum(TaskStatus);
export const taskPrioritySchema = z.nativeEnum(TaskPriority);

const scopeSchema = z.string().regex(
  /^(global|workspace:[a-zA-Z0-9._-]+)$/,
  'Scope must be "global" or "workspace:<project-name>" (alphanumeric, dots, hyphens, underscores)'
);

// ─── Knowledge ────────────────────────────────────────────────

export const createKnowledgeSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  content: z.string().min(1, 'Content is required'),
  tags: z.array(z.string().min(1)).min(1, 'At least one tag is required'),
  type: knowledgeTypeSchema,
  scope: scopeSchema,
  source: z.string().min(1, 'Source is required'),
  confidenceScore: z.number().min(0).max(1).optional().default(1.0),
  expiresAt: z.date().nullable().optional().default(null),
  relatedIds: z.array(z.string().uuid()).nullable().optional().default(null),
  agentId: z.string().max(64).nullable().optional().default(null),
  platform: z.string().max(64).nullable().optional().default(null),
});

export const updateKnowledgeSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).min(1).optional(),
  type: knowledgeTypeSchema.optional(),
  scope: scopeSchema.optional(),
  source: z.string().min(1).optional(),
  confidenceScore: z.number().min(0).max(1).optional(),
  expiresAt: z.date().nullable().optional(),
  relatedIds: z.array(z.string().uuid()).nullable().optional(),
  agentId: z.string().max(64).nullable().optional(),
  platform: z.string().max(64).nullable().optional(),
});

export const searchOptionsSchema = z.object({
  tags: z.array(z.string()).optional(),
  type: knowledgeTypeSchema.optional(),
  scope: scopeSchema.optional(),
  limit: z.number().int().min(1).max(100).optional().default(DEFAULT_SEARCH_LIMIT),
  threshold: z.number().min(0).max(1).optional().default(DEFAULT_SIMILARITY_THRESHOLD),
  includePlanContext: z.boolean().optional().default(false),
  queryText: z.string().optional(),
  // Must be declared here as well as on SearchOptions: this schema is a plain
  // z.object, so any key it does not know is silently STRIPPED at the SDK
  // boundary — an undeclared trackRead would vanish before reaching the service.
  trackRead: z.boolean().optional(),
});

// ─── Plans ────────────────────────────────────────────────────

export const createPlanSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  content: z.string().min(1, 'Content is required'),
  tags: z.array(z.string().min(1)).min(1, 'At least one tag is required'),
  scope: scopeSchema,
  source: z.string().min(1, 'Source is required'),
  status: knowledgeStatusSchema.optional().default(KnowledgeStatus.DRAFT),
  planFilePath: z.string().min(1).nullable().optional(),
  agentId: z.string().max(64).nullable().optional(),
  platform: z.string().max(64).nullable().optional(),
  tasks: z.array(z.object({
    description: z.string().min(1),
    priority: z.enum(['low', 'medium', 'high']).optional(),
  })).optional(),
});

export const updatePlanSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).min(1).optional(),
  scope: scopeSchema.optional(),
  status: knowledgeStatusSchema.optional(),
  source: z.string().min(1).optional(),
  planFilePath: z.string().min(1).nullable().optional(),
  agentId: z.string().max(64).nullable().optional(),
  platform: z.string().max(64).nullable().optional(),
});

// ─── Plan Tasks ───────────────────────────────────────────────

export const createPlanTaskSchema = z.object({
  planId: z.string().min(1),
  description: z.string().min(1, 'Description is required'),
  status: taskStatusSchema.optional().default(TaskStatus.PENDING),
  priority: taskPrioritySchema.optional().default(TaskPriority.MEDIUM),
  notes: z.string().nullable().optional().default(null),
  position: z.number().int().min(0).optional(),
});

export const updatePlanTaskSchema = z.object({
  description: z.string().min(1).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  notes: z.string().nullable().optional(),
  position: z.number().int().min(0).optional(),
});

// ─── Tags ─────────────────────────────────────────────────────

/** Batch tag merge (POST /api/tags/merge-batch). Bounded: 1..50 merges per call. */
export const mergeTagsBatchSchema = z.object({
  merges: z.array(z.object({
    from: z.string().min(1, 'from is required'),
    to: z.string().min(1, 'to is required'),
  })).min(1, 'at least one merge is required').max(50, 'at most 50 merges per batch'),
});

// ─── Import ───────────────────────────────────────────────────

const MAX_IMPORT_ITEMS = 50_000;

/**
 * Tolerant of the JSON export shape (expiresAt is a string, not a Date; scope
 * isn't re-regex'd) but bounds field lengths and STRIPS unknown keys (z.object
 * default). `type` allows every KnowledgeType including 'system' — the import
 * endpoint rewrites system→pattern as a second guard so privileged system
 * entries can't be imported.
 */
const importKnowledgeEntrySchema = z.object({
  title: z.string().max(2_000).optional(),
  content: z.string().min(1).max(500_000),
  tags: z.array(z.string().max(200)).max(200).optional().default([]),
  type: knowledgeTypeSchema,
  scope: z.string().min(1).max(300),
  source: z.string().max(300).optional(),
  confidenceScore: z.number().min(0).max(1).optional(),
  expiresAt: z.string().max(64).nullable().optional(),
  relatedIds: z.array(z.string().max(64)).nullable().optional(),
  agentId: z.string().max(200).nullable().optional(),
  platform: z.string().max(200).nullable().optional(),
});

/** Body of POST /api/import. Knowledge entries are strictly shaped+bounded;
 *  plans are passed through (importPlans needs their full shape) but bounded. */
export const importSchema = z.object({
  include: z.array(z.string().max(50)).max(10).optional().default([]),
  knowledge: z.array(importKnowledgeEntrySchema).max(MAX_IMPORT_ITEMS).optional(),
  plans: z.array(z.record(z.unknown())).max(MAX_IMPORT_ITEMS).optional(),
});
