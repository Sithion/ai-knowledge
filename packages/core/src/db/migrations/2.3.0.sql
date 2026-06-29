-- v2.3.0: provenance tracking — record which platform + agent created each entry/plan.
-- platform is auto-detected (MCP COGNISTORE_PLATFORM env / clientInfo); agent_id is caller-provided.
-- knowledge_entries.agent_id already exists (since 0.8.0); only platform is new there.
ALTER TABLE knowledge_entries ADD COLUMN platform TEXT;
ALTER TABLE plans ADD COLUMN agent_id TEXT;
ALTER TABLE plans ADD COLUMN platform TEXT;
CREATE INDEX IF NOT EXISTS idx_knowledge_platform ON knowledge_entries(platform);
CREATE INDEX IF NOT EXISTS idx_plans_platform ON plans(platform);
CREATE INDEX IF NOT EXISTS idx_plans_agent ON plans(agent_id);
