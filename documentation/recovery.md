# Recovery

Manual repair procedures for a knowledge base that ended up in a bad state. These are **offline tools**:
they run against `~/.cognistore/knowledge.db` directly, with the app closed.

## Repairing the embedding index

**Script:** `scripts/repair-embeddings.mjs`

Symptom: search returns nothing, or far fewer results than the knowledge base contains, while the entries
themselves are still listed in the dashboard. That means rows exist in `knowledge_entries` / `plans` but
their vectors are missing from the `knowledge_embeddings` / `plans_embeddings` sqlite-vec tables (see
[Database](./database.md#knowledge_embeddings-virtual-table)).

Versions **2.5.0 and 2.5.1** could produce exactly this: the upgrade's integrity check dropped both vector
tables before rebuilding them, and the sidecar crashed on every launch, so a rebuild interrupted mid-flight
left the index empty. Both causes are fixed in 2.5.2 — see [PATCH-NOTES](../PATCH-NOTES.md) — and 2.5.2's
upgrade backfills what is missing on its own. This script is for repairing a database that is already in
that state, or for repairing one without launching the app.

### Usage

```bash
pnpm --filter @cognistore/sdk build      # the script imports the built SDK
node scripts/repair-embeddings.mjs --dry-run
node scripts/repair-embeddings.mjs
```

`--dry-run` reports how many entries and plans are missing an embedding and exits without writing.

The script runs the same incremental backfill the app runs (`KnowledgeSDK.embedMissing()`): it embeds only
the ids that are actually missing a vector, upserts them one at a time, and **never drops a table**. It is
resumable — a failed id simply stays in the missing set, so re-running retries it. Exit code is `1` when
anything remains unembedded.

Output is counts only (`coverage before` / per-phase progress / `coverage after`); entry titles and content
are never printed.

### Requirements and refusals

Ollama must be reachable — the script re-embeds through the same provider the app uses.

It refuses to run, with exit code `1`, when:

| Condition | Why |
|---|---|
| The database path is outside `~/.cognistore/` | Guards against pointing the repair at an arbitrary file |
| No database exists at that path | Nothing to repair |
| A CogniStore sidecar process is still running (**macOS only** — the check matches the `.app` bundle path and does not yet recognize the Linux packaging) | Two writers on one SQLite file. **Quit CogniStore from the tray before running this on any platform**, whether or not the check can see it |
| `packages/sdk/dist` is not built | The script imports the built SDK, not source |

| Env var | Default | Purpose |
|---|---|---|
| `SQLITE_PATH` | `~/.cognistore/knowledge.db` | Database to repair (must stay under `~/.cognistore/`) |
| `OLLAMA_HOST` | `http://localhost:11434` | Pinned unless explicitly set — an ambient value pointing elsewhere is not trusted |

## If your index was ever empty: duplicate entries

Deduplication in CogniStore is embedding-based — `addKnowledge` and `createPlan` decide whether to update
an existing entry or create a new one by running a vector similarity search first. While the index was
empty (see above), that search always came back empty too, so every write that should have updated an
existing entry created a duplicate instead.

Repairing the index (via this script or 2.5.2's automatic backfill) restores dedup for new writes and
makes search work again — it does **not** merge duplicates that were already created while the index was
down. There is currently no automated merge; if two entries look like near-duplicates from around the time
your index was broken, that is expected, and reviewing/merging them by hand (or via the dashboard's
existing merge tools, where they apply) is the only remedy today. A report-only duplicate audit is planned
for a later release.

## Related

- [Database](./database.md) — schema, sqlite-vec tables, embedding strategy
- [API Reference — Upgrade](./api-reference.md#upgrade) — the `integrity` step that backfills automatically
