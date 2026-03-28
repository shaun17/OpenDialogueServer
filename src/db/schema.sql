-- OpenDialogue D1 Schema
-- 执行: wrangler d1 execute opendialogue-db --file=src/db/schema.sql

-- Agent 注册表
CREATE TABLE IF NOT EXISTS agents (
  agent_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL DEFAULT '1.0.0',
  capabilities  TEXT NOT NULL DEFAULT '["text"]',  -- JSON array
  description   TEXT,
  agent_secret  TEXT NOT NULL DEFAULT '',           -- 每个 Agent 独立的连接签名密钥（仅注册时返回一次）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 离线消息队列
CREATE TABLE IF NOT EXISTS offline_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  from_agent_id   TEXT NOT NULL,
  to_agent_id     TEXT NOT NULL,
  message_id      TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL DEFAULT 'text',
  content         TEXT NOT NULL,
  timestamp       INTEGER NOT NULL,
  nonce           TEXT NOT NULL,
  signature       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | expired
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_offline_queue_to_agent
  ON offline_queue (to_agent_id, status);

CREATE INDEX IF NOT EXISTS idx_offline_queue_created
  ON offline_queue (created_at);

-- 会话表
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  initiator_id    TEXT NOT NULL,
  participant_id  TEXT NOT NULL,
  max_turns       INTEGER NOT NULL DEFAULT 20,
  current_turn    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | ended | expired
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_initiator
  ON conversations (initiator_id);

CREATE INDEX IF NOT EXISTS idx_conversations_participant
  ON conversations (participant_id);

-- 会话消息历史
CREATE TABLE IF NOT EXISTS conv_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  turn_number     INTEGER NOT NULL,
  from_agent_id   TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'text',
  content         TEXT NOT NULL,
  timestamp       INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_id
  ON conv_messages (conversation_id, turn_number);

-- 黑名单表（双向：A block B 后，A 不收 B 的消息）
CREATE TABLE IF NOT EXISTS blocklist (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id    TEXT NOT NULL,   -- 执行屏蔽的一方
  blocked_id    TEXT NOT NULL,   -- 被屏蔽的一方
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocklist_blocker
  ON blocklist (blocker_id, blocked_id);

-- 白名单表（开启后，只接受名单内 agent 的消息）
CREATE TABLE IF NOT EXISTS allowlist (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL,     -- 设置白名单的一方
  allowed_id    TEXT NOT NULL,     -- 被允许发送消息的一方
  created_at    INTEGER NOT NULL,
  UNIQUE (agent_id, allowed_id)
);

CREATE INDEX IF NOT EXISTS idx_allowlist_agent
  ON allowlist (agent_id, allowed_id);

-- agents 表追加白名单开关（已有表用 ALTER TABLE）
-- allowlist_enabled 默认 0 (false)，设为 1 时启用白名单过滤
