/**
 * OpenDialogueServer — Cloudflare Worker 入口
 *
 * 路由分发：
 *   GET  /connect                        → WebSocket 升级 → AgentHub DO
 *   POST /api/agent/register             → Agent 注册
 *   GET  /api/agent/:id                  → Agent 查询（含在线状态）
 *   PATCH /api/agent/:id/card            → 更新 Agent Card
 *   POST /api/agent/:id/block            → 添加黑名单
 *   DELETE /api/agent/:id/block          → 移除黑名单
 *   POST /api/message                    → HTTP 发消息（补充接口）
 *   GET  /api/conversation/:id/history   → 会话历史查询
 */

export { AgentHub } from './agent-hub.js';

import {
  handleAgentRegister,
  handleAgentGet,
  handleAgentUpdate,
  handleAddBlock,
  handleRemoveBlock,
} from './routes/agent.js';
import { handleHttpMessage } from './routes/message.js';
import { handleConversationHistory } from './routes/conversation.js';
import type { Env } from './types.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-agent-id, x-signature, x-timestamp, x-nonce',
        },
      });
    }

    // ── 获取 AgentHub Durable Object 单例 ───────────────────────────────────
    const hubId = env.AGENT_HUB.idFromName('global');
    const hubDO = env.AGENT_HUB.get(hubId);

    try {
      // ── WebSocket 连接升级 ─────────────────────────────────────────────────
      if (path === '/connect' && request.headers.get('Upgrade') === 'websocket') {
        return hubDO.fetch(request);
      }

      // ── REST API 路由 ──────────────────────────────────────────────────────

      // POST /api/agent/register
      if (method === 'POST' && path === '/api/agent/register') {
        return handleAgentRegister(request, env);
      }

      // GET /api/agent/:id
      const agentGetMatch = path.match(/^\/api\/agent\/([^/]+)$/);
      if (method === 'GET' && agentGetMatch) {
        return handleAgentGet(agentGetMatch[1]!, env, hubDO);
      }

      // PATCH /api/agent/:id/card
      const agentUpdateMatch = path.match(/^\/api\/agent\/([^/]+)\/card$/);
      if (method === 'PATCH' && agentUpdateMatch) {
        return handleAgentUpdate(agentUpdateMatch[1]!, request, env);
      }

      // POST /api/agent/:id/block
      const blockAddMatch = path.match(/^\/api\/agent\/([^/]+)\/block$/);
      if (method === 'POST' && blockAddMatch) {
        return handleAddBlock(blockAddMatch[1]!, request, env);
      }

      // DELETE /api/agent/:id/block
      const blockRemoveMatch = path.match(/^\/api\/agent\/([^/]+)\/block$/);
      if (method === 'DELETE' && blockRemoveMatch) {
        return handleRemoveBlock(blockRemoveMatch[1]!, request, env);
      }

      // POST /api/message
      if (method === 'POST' && path === '/api/message') {
        return handleHttpMessage(request, env, hubDO);
      }

      // GET /api/conversation/:id/history
      const convMatch = path.match(/^\/api\/conversation\/([^/]+)\/history$/);
      if (method === 'GET' && convMatch) {
        return handleConversationHistory(convMatch[1]!, request, env);
      }

      return new Response('Not Found', { status: 404 });

    } catch (e) {
      console.error('Worker 未处理异常:', e);
      return Response.json({ error: '服务器内部错误' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
