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
  agentId: z.string().nullable().optional().default(null),
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
  agentId: z.string().nullable().optional(),
});

export const searchOptionsSchema = z.object({
  tags: z.array(z.string()).optional(),
  type: knowledgeTypeSchema.optional(),
  scope: scopeSchema.optional(),
  limit: z.number().int().min(1).max(100).optional().default(DEFAULT_SEARCH_LIMIT),
  threshold: z.number().min(0).max(1).optional().default(DEFAULT_SIMILARITY_THRESHOLD),
  includePlanContext: z.boolean().optional().default(false),
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
