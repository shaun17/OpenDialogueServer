-- Migration: Add allowlist table and allowlist_enabled column to agents

CREATE TABLE IF NOT EXISTS allowlist (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL,
  allowed_id    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (agent_id, allowed_id)
);

CREATE INDEX IF NOT EXISTS idx_allowlist_agent
  ON allowlist (agent_id, allowed_id);

-- Add allowlist_enabled column (0 = off, 1 = on)
ALTER TABLE agents ADD COLUMN allowlist_enabled INTEGER NOT NULL DEFAULT 0;
