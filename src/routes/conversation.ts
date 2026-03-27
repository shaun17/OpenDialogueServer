/**
 * 会话历史查询路由
 */

import { getConversation, getConvMessages } from '../db/queries.js';
import type { Env } from '../types.js';

export async function handleConversationHistory(
  conversationId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const lastParam = url.searchParams.get('last');
  const last = lastParam ? parseInt(lastParam) : undefined;

  const conv = await getConversation(env.DB, conversationId);
  if (!conv) {
    return Response.json({ error: '会话不存在' }, { status: 404 });
  }

  const messages = await getConvMessages(env.DB, conversationId, last);

  return Response.json({
    conversation: conv,
    messages,
    total: messages.length,
  });
}
