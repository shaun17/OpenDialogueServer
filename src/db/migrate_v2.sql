-- Migration v2: 为现有 agents 表添加 agent_secret 列
-- 执行: wrangler d1 execute opendialogue-db --local --file=src/db/migrate_v2.sql
-- 生产: wrangler d1 execute opendialogue-db --remote --file=src/db/migrate_v2.sql

ALTER TABLE agents ADD COLUMN agent_secret TEXT NOT NULL DEFAULT '';
