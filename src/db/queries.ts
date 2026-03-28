/**
 * D1 数据库操作封装
 * 所有 SQL 操作集中在此，避免 SQL 散落各处
 */

import type { AgentCard, Conversation, OfflineQueueItem } from '../types.js';

// ─── Agent ──────────────────────────────────────────────────────────────────

export async function insertAgent(db: D1Database, card: AgentCard, agentSecret: string): Promise<void> {
  await db.prepare(
    `INSERT INTO agents (agent_id, name, version, capabilities, description, agent_secret, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    card.agent_id,
    card.name,
    card.version,
    JSON.stringify(card.capabilities),
    card.description ?? null,
    agentSecret,
    card.created_at,
    card.updated_at,
  ).run();
}

export async function getAgentSecret(db: D1Database, agentId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT agent_secret FROM agents WHERE agent_id = ?`
  ).bind(agentId).first<{ agent_secret: string }>();
  return row?.agent_secret ?? null;
}

export async function getAgent(db: D1Database, agentId: string): Promise<AgentCard | null> {
  const row = await db.prepare(
    `SELECT * FROM agents WHERE agent_id = ?`
  ).bind(agentId).first<Record<string, unknown>>();

  if (!row) return null;
  return rowToCard(row);
}

export async function updateAgentCard(
  db: D1Database,
  agentId: string,
  patch: Partial<Pick<AgentCard, 'name' | 'version' | 'capabilities' | 'description'>>,
  updatedAt: number,
): Promise<void> {
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [updatedAt];

  if (patch.name !== undefined)         { sets.push('name = ?');         values.push(patch.name); }
  if (patch.version !== undefined)      { sets.push('version = ?');      values.push(patch.version); }
  if (patch.capabilities !== undefined) { sets.push('capabilities = ?'); values.push(JSON.stringify(patch.capabilities)); }
  if (patch.description !== undefined)  { sets.push('description = ?');  values.push(patch.description); }

  values.push(agentId);
  await db.prepare(
    `UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ?`
  ).bind(...values).run();
}

function rowToCard(row: Record<string, unknown>): AgentCard {
  return {
    agent_id:     row['agent_id'] as string,
    name:         row['name'] as string,
    version:      row['version'] as string,
    capabilities: JSON.parse(row['capabilities'] as string) as string[],
    description:  row['description'] as string | undefined,
    created_at:   row['created_at'] as number,
    updated_at:   row['updated_at'] as number,
  };
}

// ─── 离线消息队列 ─────────────────────────────────────────────────────────────

export async function enqueueOfflineMessage(
  db: D1Database,
  item: Omit<OfflineQueueItem, 'id' | 'status' | 'created_at' | 'delivered_at'>,
  maxQueue: number,
): Promise<void> {
  // 超出上限时删除最旧的消息
  const countRow = await db.prepare(
    `SELECT COUNT(*) as cnt FROM offline_queue WHERE to_agent_id = ? AND status = 'pending'`
  ).bind(item.to_agent_id).first<{ cnt: number }>();

  if (countRow && countRow.cnt >= maxQueue) {
    await db.prepare(
      `DELETE FROM offline_queue WHERE id = (
         SELECT id FROM offline_queue WHERE to_agent_id = ? AND status = 'pending'
         ORDER BY created_at ASC LIMIT 1
       )`
    ).bind(item.to_agent_id).run();
  }

  await db.prepare(
    `INSERT INTO offline_queue
       (conversation_id, from_agent_id, to_agent_id, message_id, type, content,
        timestamp, nonce, signature, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(
    item.conversation_id ?? null,
    item.from_agent_id,
    item.to_agent_id,
    item.message_id,
    item.type,
    item.content,
    item.timestamp,
    item.nonce,
    item.signature,
    Date.now(),
  ).run();
}

export async function getPendingMessages(
  db: D1Database,
  agentId: string,
): Promise<OfflineQueueItem[]> {
  const rows = await db.prepare(
    `SELECT * FROM offline_queue WHERE to_agent_id = ? AND status = 'pending' ORDER BY created_at ASC`
  ).bind(agentId).all<Record<string, unknown>>();

  return (rows.results ?? []).map(r => ({
    id:               r['id'] as number,
    conversation_id:  r['conversation_id'] as string | undefined,
    from_agent_id:    r['from_agent_id'] as string,
    to_agent_id:      r['to_agent_id'] as string,
    message_id:       r['message_id'] as string,
    type:             r['type'] as string,
    content:          r['content'] as string,
    timestamp:        r['timestamp'] as number,
    nonce:            r['nonce'] as string,
    signature:        r['signature'] as string,
    status:           r['status'] as 'pending',
    created_at:       r['created_at'] as number,
  }));
}

export async function markMessagesDelivered(
  db: D1Database,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  await db.prepare(
    `UPDATE offline_queue SET status = 'delivered', delivered_at = ? WHERE id IN (${placeholders})`
  ).bind(Date.now(), ...ids).run();
}

// ─── 会话 ────────────────────────────────────────────────────────────────────

export async function upsertConversation(
  db: D1Database,
  conv: Omit<Conversation, 'current_turn' | 'status' | 'updated_at'>,
): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO conversations
       (conversation_id, initiator_id, participant_id, max_turns, current_turn, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 'active', ?, ?)
     ON CONFLICT(conversation_id) DO NOTHING`
  ).bind(
    conv.conversation_id,
    conv.initiator_id,
    conv.participant_id,
    conv.max_turns,
    conv.created_at,
    now,
  ).run();
}

export async function incrementTurn(
  db: D1Database,
  conversationId: string,
): Promise<Conversation | null> {
  const now = Date.now();
  await db.prepare(
    `UPDATE conversations SET current_turn = current_turn + 1, updated_at = ? WHERE conversation_id = ?`
  ).bind(now, conversationId).run();

  return getConversation(db, conversationId);
}

export async function getConversation(
  db: D1Database,
  conversationId: string,
): Promise<Conversation | null> {
  const row = await db.prepare(
    `SELECT * FROM conversations WHERE conversation_id = ?`
  ).bind(conversationId).first<Record<string, unknown>>();

  if (!row) return null;
  return {
    conversation_id: row['conversation_id'] as string,
    initiator_id:    row['initiator_id'] as string,
    participant_id:  row['participant_id'] as string,
    max_turns:       row['max_turns'] as number,
    current_turn:    row['current_turn'] as number,
    status:          row['status'] as Conversation['status'],
    created_at:      row['created_at'] as number,
    updated_at:      row['updated_at'] as number,
  };
}

export async function endConversation(
  db: D1Database,
  conversationId: string,
): Promise<void> {
  await db.prepare(
    `UPDATE conversations SET status = 'ended', updated_at = ? WHERE conversation_id = ?`
  ).bind(Date.now(), conversationId).run();
}

export async function insertConvMessage(
  db: D1Database,
  params: { conversation_id: string; turn_number: number; from_agent_id: string; type: string; content: string; timestamp: number },
): Promise<void> {
  await db.prepare(
    `INSERT INTO conv_messages (conversation_id, turn_number, from_agent_id, type, content, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    params.conversation_id,
    params.turn_number,
    params.from_agent_id,
    params.type,
    params.content,
    params.timestamp,
  ).run();
}

export async function getConvMessages(
  db: D1Database,
  conversationId: string,
  last?: number,
): Promise<{ turn_number: number; from_agent_id: string; type: string; content: string; timestamp: number }[]> {
  const sql = last
    ? `SELECT * FROM (SELECT * FROM conv_messages WHERE conversation_id = ? ORDER BY turn_number DESC LIMIT ?) ORDER BY turn_number ASC`
    : `SELECT * FROM conv_messages WHERE conversation_id = ? ORDER BY turn_number ASC`;

  const rows = last
    ? await db.prepare(sql).bind(conversationId, last).all<Record<string, unknown>>()
    : await db.prepare(sql).bind(conversationId).all<Record<string, unknown>>();

  return (rows.results ?? []).map(r => ({
    turn_number:    r['turn_number'] as number,
    from_agent_id:  r['from_agent_id'] as string,
    type:           r['type'] as string,
    content:        r['content'] as string,
    timestamp:      r['timestamp'] as number,
  }));
}

// ─── 黑名单 ──────────────────────────────────────────────────────────────────

export async function isBlocked(
  db: D1Database,
  blockerId: string,
  blockedId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM blocklist WHERE blocker_id = ? AND blocked_id = ?`
  ).bind(blockerId, blockedId).first();
  return row !== null;
}

export async function addBlock(
  db: D1Database,
  blockerId: string,
  blockedId: string,
  reason?: string,
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO blocklist (blocker_id, blocked_id, reason, created_at) VALUES (?, ?, ?, ?)`
  ).bind(blockerId, blockedId, reason ?? null, Date.now()).run();
}

export async function removeBlock(
  db: D1Database,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM blocklist WHERE blocker_id = ? AND blocked_id = ?`
  ).bind(blockerId, blockedId).run();
}

export async function getBlocklist(
  db: D1Database,
  agentId: string,
): Promise<{ blocked_id: string; reason: string | null; created_at: number }[]> {
  const rows = await db.prepare(
    `SELECT blocked_id, reason, created_at FROM blocklist WHERE blocker_id = ? ORDER BY created_at DESC`
  ).bind(agentId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(r => ({
    blocked_id: r['blocked_id'] as string,
    reason:     r['reason'] as string | null,
    created_at: r['created_at'] as number,
  }));
}

// ─── 白名单 ──────────────────────────────────────────────────────────────────

export async function isAllowlistEnabled(
  db: D1Database,
  agentId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT allowlist_enabled FROM agents WHERE agent_id = ?`
  ).bind(agentId).first<{ allowlist_enabled: number }>();
  return row?.allowlist_enabled === 1;
}

export async function setAllowlistEnabled(
  db: D1Database,
  agentId: string,
  enabled: boolean,
): Promise<void> {
  await db.prepare(
    `UPDATE agents SET allowlist_enabled = ?, updated_at = ? WHERE agent_id = ?`
  ).bind(enabled ? 1 : 0, Date.now(), agentId).run();
}

export async function isAllowed(
  db: D1Database,
  agentId: string,
  allowedId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM allowlist WHERE agent_id = ? AND allowed_id = ?`
  ).bind(agentId, allowedId).first();
  return row !== null;
}

export async function addAllow(
  db: D1Database,
  agentId: string,
  allowedId: string,
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO allowlist (agent_id, allowed_id, created_at) VALUES (?, ?, ?)`
  ).bind(agentId, allowedId, Date.now()).run();
}

export async function removeAllow(
  db: D1Database,
  agentId: string,
  allowedId: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM allowlist WHERE agent_id = ? AND allowed_id = ?`
  ).bind(agentId, allowedId).run();
}

export async function getAllowlist(
  db: D1Database,
  agentId: string,
): Promise<{ allowed_id: string; created_at: number }[]> {
  const rows = await db.prepare(
    `SELECT allowed_id, created_at FROM allowlist WHERE agent_id = ? ORDER BY created_at DESC`
  ).bind(agentId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(r => ({
    allowed_id: r['allowed_id'] as string,
    created_at: r['created_at'] as number,
  }));
}
