import { KnowledgeType } from '../types/knowledge.js';

export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
export const DEFAULT_EMBEDDING_DIMENSIONS = 256;
export const OLLAMA_NATIVE_DIMENSIONS = 768;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.3;
export const DEFAULT_SEARCH_LIMIT = 10;

// Plan dedup: only merge a new plan into an existing one when genuinely related.
// 0.5 was too low — same-project plans share vocabulary and falsely merged.
export const PLAN_DEDUP_THRESHOLD = 0.7;          // bar to update an existing DRAFT plan
export const PLAN_ACTIVE_MERGE_THRESHOLD = 0.8;   // higher bar to append into an ACTIVE plan

// Plan lineage: parent/root chains have no foreign key, so cycles can exist in
// data. Every traversal is bounded by these instead of trusting write-time checks.
export const PLAN_CHAIN_MAX_DEPTH = 64;           // ancestor walk / depth computation cap
export const PLAN_CHAIN_MAX_ENTRIES = 500;        // max plans returned for one chain

// Plan-augmented knowledge retrieval: also surface knowledge linked to plans whose
// embedding is similar to the query (input = consulted, output = produced).
export const PLAN_CONTEXT_THRESHOLD = 0.6;        // similar-plan match bar for retrieval
export const PLAN_CONTEXT_LIMIT = 3;              // top-N similar plans to mine
export const PLAN_CONTEXT_EXTRA = 5;              // max extra knowledge entries appended
export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_OLLAMA_PORT = 11434;
export const DEFAULT_SQLITE_PATH = '~/.cognistore/knowledge.db';

export const KNOWLEDGE_TYPES = Object.values(KnowledgeType);

