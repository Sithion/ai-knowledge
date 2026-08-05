import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const knowledgeTypeEnum = ['decision', 'pattern', 'fix', 'constraint', 'gotcha', 'system'] as const;

export const knowledgeEntries = sqliteTable(
  'knowledge_entries',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text('title').notNull().default(''),
    content: text('content').notNull(),
    tags: text('tags', { mode: 'json' }).notNull().$type<string[]>().default([]),
    type: text('type').notNull(),
    scope: text('scope').notNull(),
    source: text('source').notNull(),
    version: integer('version').notNull().default(1),
    expiresAt: text('expires_at'),
    confidenceScore: real('confidence_score').notNull().default(1.0),
    relatedIds: text('related_ids', { mode: 'json' }).$type<string[] | null>(),
    agentId: text('agent_id'),
    platform: text('platform'),
    // Retention signal for the cleanup cycle. Written by markRead() only —
    // never by update(), so it can never be confused with an edit.
    lastReadAt: text('last_read_at'),
    readCount: integer('read_count').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_type').on(table.type),
    index('idx_scope').on(table.scope),
    index('idx_knowledge_platform').on(table.platform),
  ]
);
