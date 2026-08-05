-- v2.4.1: plan-to-plan lineage (parent/root chains).
-- The version number is deliberately ahead of the app version (2.4.0): migration
-- versions are independent of app versions. The runner sorts .sql files by semver
-- and applies every unapplied one, and 2.4.0 already shipped on this branch, so a
-- new schema change inside the 2.4.0 release needs the next migration number.
-- Do not renumber this to match the app.
--
-- The STATEMENTS here must stay identical to EMBEDDED_MIGRATIONS['2.4.1'] in
-- migrate.ts (comments may differ): the sidecar runs this file, the bundled MCP
-- server runs the embedded copy. Enforced by the migration-parity test.
--
-- PARSER CONTRACT: the runner strips only whole lines whose trimmed text starts
-- with two dashes, then splits the rest on the semicolon character. Never put a
-- semicolon inside a comment or a string literal, and never append a trailing
-- comment to a statement line.

-- Lineage convention: a ROOT plan has BOTH columns NULL ("NULL means I am the
-- root"). That keeps every pre-existing row valid with no backfill. root_plan_id
-- is denormalized so a whole chain is one indexed lookup; the trade-off is that
-- the service layer maintains it on create, re-parent, delete and import.
-- There is no foreign key: SQLite cannot add one via ALTER TABLE, so parents may
-- dangle and cycles may exist in data. Every traversal is bounded accordingly.
ALTER TABLE plans ADD COLUMN parent_plan_id TEXT;
ALTER TABLE plans ADD COLUMN root_plan_id TEXT;

CREATE INDEX IF NOT EXISTS idx_plans_parent_plan_id ON plans(parent_plan_id);
CREATE INDEX IF NOT EXISTS idx_plans_root_plan_id ON plans(root_plan_id);
