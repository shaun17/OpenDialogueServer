/**
 * Agent 注册 / 查询 / 更新 / 黑名单路由
 */

import { randomHex } from '../security/hmac.js';
import { insertAgent, getAgent, updateAgentCard, addBlock, removeBlock } from '../db/queries.js';
import type { Env, AgentCard } from '../types.js';

export async function handleAgentRegister(request: Request, env: Env): Promise<Response> {
  let body: { name?: string; version?: string; capabilities?: string[]; description?: string };
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求体必须是 JSON' }, { status: 400 }); }

  if (!body.name || typeof body.name !== 'string') {
    return Response.json({ error: '缺少 name 字段' }, { status: 400 });
  }

  const now = Date.now();
  const card: AgentCard = {
    agent_id:     randomHex(16),
    name:         body.name,
    version:      body.version ?? '1.0.0',
    capabilities: body.capabilities ?? ['text'],
    description:  body.description,
    created_at:   now,
    updated_at:   now,
  };

  try {
    await insertAgent(env.DB, card);
  } catch (e) {
    console.error('Agent 注册失败:', e);
    return Response.json({ error: '注册失败，请重试' }, { status: 500 });
  }

  return Response.json({ agent_id: card.agent_id, card }, { status: 201 });
}

export async function handleAgentGet(agentId: string, env: Env, hubDO: DurableObjectStub): Promise<Response> {
  const card = await getAgent(env.DB, agentId);
  if (!card) {
    return Response.json({ error: 'Agent 不存在' }, { status: 404 });
  }

  // 查询在线状态
  const onlineResp = await hubDO.fetch(
    new Request(`http://do/internal/online?agent_id=${encodeURIComponent(agentId)}`)
  );
  const { online } = await onlineResp.json<{ online: boolean }>();

  return Response.json({ card, online });
}

export async function handleAgentUpdate(agentId: string, request: Request, env: Env): Promise<Response> {
  const card = await getAgent(env.DB, agentId);
  if (!card) {
    return Response.json({ error: 'Agent 不存在' }, { status: 404 });
  }

  let body: { name?: string; version?: string; capabilities?: string[]; description?: string };
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求体必须是 JSON' }, { status: 400 }); }

  await updateAgentCard(env.DB, agentId, body, Date.now());
  return Response.json({ ok: true });
}

export async function handleAddBlock(
  blockerId: string, request: Request, env: Env,
): Promise<Response> {
  const { blocked_id, reason } = await request.json<{ blocked_id?: string; reason?: string }>();
  if (!blocked_id) {
    return Response.json({ error: '缺少 blocked_id' }, { status: 400 });
  }
  await addBlock(env.DB, blockerId, blocked_id, reason);
  return Response.json({ ok: true });
}

export async function handleRemoveBlock(
  blockerId: string, request: Request, env: Env,
): Promise<Response> {
  const { blocked_id } = await request.json<{ blocked_id?: string }>();
  if (!blocked_id) {
    return Response.json({ error: '缺少 blocked_id' }, { status: 400 });
  }
  await removeBlock(env.DB, blockerId, blocked_id);
  return Response.json({ ok: true });
}
