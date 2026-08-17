#!/usr/bin/env node
// Standalone, offline repair for a knowledge base whose embedding index has
// fallen behind or been wiped (see PATCH-NOTES v2.5.2 and
// documentation/recovery.md). Runs the same incremental, resumable backfill
// the 2.5.2 upgrade runs inline (KnowledgeSDK.embedMissing()) — it never
// drops a table and only touches ids that are missing an embedding.
//
// Deliberately built over @cognistore/sdk, not @cognistore/core directly:
// the SDK is the only supported path to knowledge data (see
// documentation/architecture.md), so this script inherits the embedding
// provider wiring and the dimension probe gate for free.
//
// Usage:
//   node scripts/repair-embeddings.mjs [--dry-run]
//
// Env:
//   SQLITE_PATH   Path to knowledge.db. Default: ~/.cognistore/knowledge.db
//   OLLAMA_HOST   Pinned to http://localhost:11434 unless explicitly set —
//                 this script never trusts an ambient OLLAMA_HOST pointing
//                 somewhere else.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const cognistoreDir = resolve(homedir(), '.cognistore');
const dbPath = resolve(process.env.SQLITE_PATH ?? resolve(cognistoreDir, 'knowledge.db'));

if (!dbPath.startsWith(cognistoreDir + '/') && dbPath !== resolve(cognistoreDir, 'knowledge.db')) {
  console.error(`[repair-embeddings] refusing to run: DB path ${dbPath} is not under ${cognistoreDir}`);
  process.exit(1);
}

if (!existsSync(dbPath)) {
  console.error(`[repair-embeddings] refusing to run: no database at ${dbPath}`);
  process.exit(1);
}

// Best-effort competing-writer check (the real guard is F2's advisory lock,
// not yet landed — this refuses the obvious case: the desktop app running).
try {
  const out = execSync(
    `pgrep -fl '/Applications/CogniStore.app/Contents/Resources/dist-server/index.js' || true`,
    { encoding: 'utf8' }
  ).trim();
  if (out) {
    console.error('[repair-embeddings] refusing to run: a CogniStore sidecar is still running:');
    console.error(out);
    console.error('Quit CogniStore from the tray first.');
    process.exit(1);
  }
} catch {
  // pgrep not available on this platform — proceed; the DB-level lock (once
  // present) is the authoritative guard.
}

process.env.SQLITE_PATH = dbPath;
process.env.OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

// NEVER inherit an ambient EMBEDDING_DIMENSIONS. sdk.initialize() calls the
// private detectAndMigrateDimensions(), which DROPs BOTH vec tables and
// re-embeds from scratch whenever the configured dimension disagrees with the
// one already stored — so a stray `export EMBEDDING_DIMENSIONS=768` in the
// operator's shell would make this repair tool destroy the index it was run to
// repair, before it embedded a single row. Deleting the var pins the SDK to
// DEFAULT_EMBEDDING_DIMENSIONS (@cognistore/shared), which is exactly what the
// packaged app passes the sidecar, so this is a no-op for every real install.
delete process.env.EMBEDDING_DIMENSIONS;

const sdkEntry = resolve(__dirname, '..', 'packages', 'sdk', 'dist', 'index.js');
if (!existsSync(sdkEntry)) {
  console.error(`[repair-embeddings] refusing to run: SDK is not built (expected ${sdkEntry}). Run "pnpm --filter @cognistore/sdk build" first.`);
  process.exit(1);
}
const { KnowledgeSDK } = await import(sdkEntry);

const sdk = new KnowledgeSDK();
await sdk.initialize();

const before = await sdk.embeddingCoverage();
console.log(
  `[repair-embeddings] coverage before: entries ${before.entryEmbeddings}/${before.entries}, ` +
  `plans ${before.planEmbeddings}/${before.plans}`
);

if (before.missingEntries === 0 && before.missingPlans === 0) {
  console.log('[repair-embeddings] nothing to do — coverage is already complete.');
  await sdk.close();
  process.exit(0);
}

if (dryRun) {
  console.log(
    `[repair-embeddings] --dry-run: would embed ${before.missingEntries} entries and ` +
    `${before.missingPlans} plans. Exiting without writing.`
  );
  await sdk.close();
  process.exit(0);
}

const total = before.missingEntries + before.missingPlans;
const result = await sdk.embedMissing({
  onProgress: ({ phase, done, total: phaseTotal, failed }) => {
    process.stdout.write(`\r[repair-embeddings] ${phase}: ${done}/${phaseTotal} (${failed} failed)   `);
  },
});
process.stdout.write('\n');

const after = await sdk.embeddingCoverage();
console.log(
  `[repair-embeddings] coverage after: entries ${after.entryEmbeddings}/${after.entries}, ` +
  `plans ${after.planEmbeddings}/${after.plans}`
);
console.log(`[repair-embeddings] embedded ${result.embedded}, failed ${result.failed}, remaining ${result.remaining} (of ${total} attempted)`);

await sdk.close();

if (result.remaining > 0) {
  console.error('[repair-embeddings] some embeddings could not be repaired — re-run this script; failed ids stay in the missing set and will be retried.');
  process.exit(1);
}
