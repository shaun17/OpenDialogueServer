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
  const agentSecret = randomHex(32); // 每个 Agent 独立的连接签名密钥，仅此处返回一次

  // 生成 8 位数字 agent_id，PRIMARY KEY 唯一，碰撞时最多重试 5 次
  let card: AgentCard | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const agent_id = String(Math.floor(10_000_000 + Math.random() * 90_000_000));
    const candidate: AgentCard = {
      agent_id,
      name:         body.name,
      version:      body.version ?? '1.0.0',
      capabilities: body.capabilities ?? ['text'],
      description:  body.description,
      created_at:   now,
      updated_at:   now,
    };
    try {
      await insertAgent(env.DB, candidate, agentSecret);
      card = candidate;
      break;
    } catch (e: any) {
      if (attempt === 4 || !String(e?.message).includes('UNIQUE')) {
        console.error('Agent 注册失败:', e);
        return Response.json({ error: '注册失败，请重试' }, { status: 500 });
      }
    }
  }
  if (!card) return Response.json({ error: '注册失败，请重试' }, { status: 500 });

  // agent_secret 仅在注册响应中返回一次，请妥善保存
  return Response.json({ agent_id: card.agent_id, agent_secret: agentSecret, card }, { status: 201 });
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
