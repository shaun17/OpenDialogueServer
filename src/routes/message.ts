/**
 * HTTP 方式发送消息（补充接口，供外部系统或调试工具使用）
 * Plugin 之间的实时消息通过 WebSocket 发送，此接口为可选通道
 */

import { randomHex, signMessage } from '../security/hmac.js';
import { getAgent } from '../db/queries.js';
import type { Env, IncomingMessage } from '../types.js';

export async function handleHttpMessage(request: Request, env: Env, hubDO: DurableObjectStub): Promise<Response> {
  let body: {
    from?: string;
    to?: string;
    content?: string;
    type?: string;
    conversation_id?: string;
  };

  try { body = await request.json(); }
  catch { return Response.json({ error: '请求体必须是 JSON' }, { status: 400 }); }

  if (!body.from || !body.to || !body.content) {
    return Response.json({ error: '缺少必填字段: from, to, content' }, { status: 400 });
  }

  // 校验发送方 / 接收方是否已注册
  const [fromCard, toCard] = await Promise.all([
    getAgent(env.DB, body.from),
    getAgent(env.DB, body.to),
  ]);
  if (!fromCard) return Response.json({ error: '发送方 Agent 不存在' }, { status: 404 });
  if (!toCard)   return Response.json({ error: '接收方 Agent 不存在' }, { status: 404 });

  const now = Date.now();
  const msg: IncomingMessage = {
    id:              randomHex(8),
    from:            body.from,
    to:              body.to,
    type:            (body.type as never) ?? 'text',
    content:         body.content,
    timestamp:       now,
    nonce:           randomHex(16),
    signature:       '',
    conversation_id: body.conversation_id ?? '',
  };
  msg.signature = await signMessage(msg, env.HMAC_SECRET);

  // 转发给 DO 处理
  const resp = await hubDO.fetch(new Request('http://do/internal/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(msg),
  }));

  const result = await resp.json<{ status: string }>();
  return Response.json(result, { status: result.status === 'sent' ? 200 : 202 });
}
