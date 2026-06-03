import type Database from 'better-sqlite3';
import { DEFAULT_EMBEDDING_DIMENSIONS } from '@cognistore/shared';

const VIRTUAL_TABLE_NAME = 'knowledge_embeddings';

export function createEmbeddingsTable(sqlite: Database.Database, dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${VIRTUAL_TABLE_NAME} USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${dimensions}] distance_metric=cosine
    )
  `);
}

export function insertEmbedding(sqlite: Database.Database, id: string, embedding: number[]) {
  const stmt = sqlite.prepare(
    `INSERT INTO ${VIRTUAL_TABLE_NAME}(id, embedding) VALUES (?, ?)`
  );
  stmt.run(id, Buffer.from(new Float32Array(embedding).buffer));
}

export function updateEmbedding(sqlite: Database.Database, id: string, embedding: number[]) {
  const stmt = sqlite.prepare(
    `UPDATE ${VIRTUAL_TABLE_NAME} SET embedding = ? WHERE id = ?`
  );
  stmt.run(Buffer.from(new Float32Array(embedding).buffer), id);
}

export function deleteEmbedding(sqlite: Database.Database, id: string) {
  const stmt = sqlite.prepare(`DELETE FROM ${VIRTUAL_TABLE_NAME} WHERE id = ?`);
  stmt.run(id);
}

/**
 * Read a stored embedding back as a plain number[]. vec0 returns the vector as a
 * raw float32 blob, so decode the buffer rather than assuming JSON. Returns null
 * when the id has no embedding (e.g. fresh row before insert).
 */
export function getEmbeddingById(sqlite: Database.Database, id: string): number[] | null {
  const row = sqlite
    .prepare(`SELECT embedding FROM ${VIRTUAL_TABLE_NAME} WHERE id = ?`)
    .get(id) as { embedding?: Buffer | Uint8Array } | undefined;
  if (!row || row.embedding == null) return null;
  const buf = row.embedding as Buffer;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return Array.from(f32);
}

export interface KnnResult {
  id: string;
  distance: number;
}

export function searchKnn(
  sqlite: Database.Database,
  queryEmbedding: number[],
  k: number
): KnnResult[] {
  const stmt = sqlite.prepare(`
    SELECT id, distance
    FROM ${VIRTUAL_TABLE_NAME}
    WHERE embedding MATCH ?
      AND k = ?
  `);
  return stmt.all(
    Buffer.from(new Float32Array(queryEmbedding).buffer),
    k
  ) as KnnResult[];
}

// ─── Plans embeddings ────────────────────────────────────────

const PLANS_TABLE_NAME = 'plans_embeddings';

export function insertPlanEmbedding(sqlite: Database.Database, id: string, embedding: number[]) {
  sqlite.prepare(`INSERT INTO ${PLANS_TABLE_NAME}(id, embedding) VALUES (?, ?)`).run(
    id,
    Buffer.from(new Float32Array(embedding).buffer),
  );
}

export function updatePlanEmbedding(sqlite: Database.Database, id: string, embedding: number[]) {
  sqlite.prepare(`UPDATE ${PLANS_TABLE_NAME} SET embedding = ? WHERE id = ?`).run(
    Buffer.from(new Float32Array(embedding).buffer),
    id,
  );
}

export function deletePlanEmbedding(sqlite: Database.Database, id: string) {
  sqlite.prepare(`DELETE FROM ${PLANS_TABLE_NAME} WHERE id = ?`).run(id);
}

export function searchPlansKnn(
  sqlite: Database.Database,
  queryEmbedding: number[],
  k: number
): KnnResult[] {
  const stmt = sqlite.prepare(`
    SELECT id, distance
    FROM ${PLANS_TABLE_NAME}
    WHERE embedding MATCH ?
      AND k = ?
  `);
  return stmt.all(
    Buffer.from(new Float32Array(queryEmbedding).buffer),
    k
  ) as KnnResult[];
}
