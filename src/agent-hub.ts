/**
 * AgentHub Durable Object
 *
 * 单例，持有所有 Plugin 的 WebSocket 长连接。
 * 负责：连接管理、消息路由、频率限制、Nonce 防重放、会话轮次追踪。
 */

import { RateLimiter } from './security/rate-limiter.js';
import { verifySignature, signMessage, randomHex } from './security/hmac.js';
import { validateMessageStructure, castMessage } from './security/validator.js';
import {
  getAgent, enqueueOfflineMessage, getPendingMessages, markMessagesDelivered,
  upsertConversation, incrementTurn, endConversation, insertConvMessage,
  isBlocked,
} from './db/queries.js';
import type {
  Env, ConnectedAgent, IncomingMessage,
  DeliveredMessage, StatusMessage, ErrorMessage, EndedMessage, ServerMessage,
} from './types.js';

const NONCE_TTL_MS = 5 * 60 * 1000;         // 5 分钟
const SESSION_EXPIRES_IN = 3600;             // 秒
const HEARTBEAT_INTERVAL_MS = 30_000;        // 30 秒
const CONV_TTL_MS = 30 * 60 * 1000;         // 30 分钟

export class AgentHub implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  // 在线连接表：agentId → 连接信息
  private connections = new Map<string, ConnectedAgent>();

  // 频率限制器
  private rateLimiter: RateLimiter;

  // Nonce 缓存（防重放）：nonce → 过期时间戳
  private nonceCache = new Map<string, number>();

  // 会话轮次追踪：conversationId → { current, max, lastActivity }
  private convTrackers = new Map<string, { current: number; max: number; lastActivity: number }>();

  // 心跳定时器
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.rateLimiter = new RateLimiter(parseInt(env.RATE_LIMIT_PER_MINUTE ?? '60'));
    this.startHeartbeat();
    this.startConvTTLCleaner();
  }

  // ─── Durable Object 入口 ──────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket 升级
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleConnect(request);
    }

    // 内部 HTTP API（来自 Worker 路由层）
    switch (url.pathname) {
      case '/internal/online':  return this.handleOnlineCheck(url);
      case '/internal/send':    return this.handleHttpSend(request);
      default:                  return new Response('Not found', { status: 404 });
    }
  }

  // ─── WebSocket 连接处理 ───────────────────────────────────────────────────

  private async handleConnect(request: Request): Promise<Response> {
    const agentId = request.headers.get('x-agent-id');
    if (!agentId) {
      return new Response('缺少 x-agent-id', { status: 400 });
    }

    // 校验 Agent 是否已注册
    const card = await getAgent(this.env.DB, agentId);
    if (!card) {
      return new Response('Agent 未注册', { status: 401 });
    }

    // 校验连接签名（防止伪造连接请求）
    const connSig = request.headers.get('x-signature');
    const connTs  = request.headers.get('x-timestamp');
    const connNonce = request.headers.get('x-nonce');
    if (!connSig || !connTs || !connNonce) {
      return new Response('缺少连接签名', { status: 401 });
    }
    const sigValid = await verifySignature({
      id: agentId, from: agentId, to: 'server',
      content: 'connect', timestamp: parseInt(connTs),
      nonce: connNonce, signature: connSig,
    }, this.env.HMAC_SECRET);
    if (!sigValid) {
      return new Response('连接签名无效', { status: 401 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);

    const sessionKey = randomHex(32);
    const conn: ConnectedAgent = { ws: server, agentId, sessionKey, connectedAt: Date.now() };
    this.connections.set(agentId, conn);

    // 发送握手 session 消息
    this.send(server, { type: 'session', session_key: sessionKey, expires_in: SESSION_EXPIRES_IN });

    // 推送离线积压消息
    this.state.waitUntil(this.flushOfflineQueue(agentId, server, sessionKey));

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── WebSocket 消息处理 ───────────────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const conn = this.findConn(ws);
    if (!conn) return;

    if (message instanceof ArrayBuffer) return; // 不处理二进制

    let raw: unknown;
    try { raw = JSON.parse(message as string); }
    catch { return; }

    // 心跳 pong
    if (raw && typeof raw === 'object' && (raw as Record<string, unknown>)['type'] === 'ping') {
      this.send(ws, { type: 'pong' });
      return;
    }

    // ── 防御层：逐项校验 ──────────────────────────────────────────────────

    // 1. 结构 + 时间戳 + 类型 + 大小 + 控制字符
    const structResult = validateMessageStructure(raw, parseInt(this.env.MESSAGE_MAX_BYTES ?? '65536'));
    if (!structResult.ok) {
      this.sendError(ws, structResult.code as never, structResult.message);
      return;
    }

    const msg = castMessage(raw as Record<string, unknown>);

    // 2. 身份绑定：from 必须等于连接注册的 agentId（防止伪造发件人）
    if (msg.from !== conn.agentId) {
      this.sendError(ws, 'UNAUTHORIZED', '发送方身份与连接身份不符');
      return;
    }

    // 3. Nonce 防重放
    if (!this.checkNonce(msg.nonce)) {
      this.sendError(ws, 'REPLAY_ATTACK', 'Nonce 已被使用，疑似重放攻击');
      return;
    }

    // 4. HMAC 签名校验
    const sigOk = await verifySignature(msg, conn.sessionKey);
    if (!sigOk) {
      this.sendError(ws, 'INVALID_SIGNATURE', '消息签名验证失败');
      return;
    }

    // 5. 频率限制
    if (!this.rateLimiter.check(conn.agentId)) {
      this.sendError(ws, 'RATE_LIMITED', `超过频率限制，请稍后重试`);
      return;
    }

    // 6. 黑名单检查（目标方是否屏蔽了发送方）
    const blocked = await isBlocked(this.env.DB, msg.to, msg.from);
    if (blocked) {
      this.sendError(ws, 'AGENT_BLOCKED', '对方已将你加入黑名单');
      return;
    }

    // ── 消息类型路由 ──────────────────────────────────────────────────────

    if (msg.type === 'end') {
      await this.handleEndMessage(msg, ws);
      return;
    }

    await this.routeMessage(msg, ws, conn.sessionKey);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const conn = this.findConn(ws);
    if (!conn) return;
    this.connections.delete(conn.agentId);
    this.rateLimiter.remove(conn.agentId);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
    const conn = this.findConn(ws);
    if (conn) {
      this.connections.delete(conn.agentId);
      this.rateLimiter.remove(conn.agentId);
    }
  }

  // ─── 消息路由 ─────────────────────────────────────────────────────────────

  private async routeMessage(
    msg: IncomingMessage,
    senderWs: WebSocket,
    senderSessionKey: string,
  ): Promise<void> {
    const now = Date.now();

    // 会话管理
    if (msg.conversation_id) {
      const convResult = await this.trackConversation(msg, senderWs);
      if (!convResult.ok) return; // 已发送错误通知
    }

    // 存储会话消息
    if (msg.conversation_id) {
      const tracker = this.convTrackers.get(msg.conversation_id);
      this.state.waitUntil(
        insertConvMessage(this.env.DB, {
          conversation_id: msg.conversation_id,
          turn_number:     tracker?.current ?? 0,
          from_agent_id:   msg.from,
          type:            msg.type,
          content:         msg.content,
          timestamp:       msg.timestamp,
        })
      );
    }

    const targetConn = this.connections.get(msg.to);

    if (targetConn) {
      // 目标在线：直接转发
      const delivered: DeliveredMessage = { ...msg, delivered_at: now };
      this.send(targetConn.ws, delivered);
      this.sendStatus(senderWs, 'sent', msg.id);
    } else {
      // 目标离线：入队 + 通知发送方
      const maxQueue = parseInt(this.env.OFFLINE_QUEUE_MAX ?? '200');
      this.state.waitUntil(
        enqueueOfflineMessage(this.env.DB, {
          conversation_id: msg.conversation_id,
          from_agent_id:   msg.from,
          to_agent_id:     msg.to,
          message_id:      msg.id,
          type:            msg.type,
          content:         msg.content,
          timestamp:       msg.timestamp,
          nonce:           msg.nonce,
          signature:       msg.signature,
        }, maxQueue)
      );
      this.sendStatus(senderWs, 'queued', msg.id, '对方当前离线，消息已入队，上线后将自动送达');
    }
  }

  // ─── 会话轮次追踪 ─────────────────────────────────────────────────────────

  private async trackConversation(
    msg: IncomingMessage,
    senderWs: WebSocket,
  ): Promise<{ ok: boolean }> {
    const convId = msg.conversation_id!;
    const maxDefault = parseInt(this.env.MAX_TURNS_DEFAULT ?? '20');

    let tracker = this.convTrackers.get(convId);

    if (!tracker) {
      // 新会话：初始化追踪器并写入 D1
      const maxTurns = msg.max_turns ?? maxDefault;
      tracker = { current: 0, max: maxTurns, lastActivity: Date.now() };
      this.convTrackers.set(convId, tracker);
      await upsertConversation(this.env.DB, {
        conversation_id: convId,
        initiator_id:    msg.from,
        participant_id:  msg.to,
        max_turns:       maxTurns,
        created_at:      Date.now(),
      });
    }

    tracker.lastActivity = Date.now();
    tracker.current += 1;

    if (tracker.current > tracker.max) {
      // 超过轮次上限
      this.sendError(senderWs, 'CONVERSATION_ENDED', `会话已达到最大轮次 ${tracker.max}，请开启新会话`);
      this.state.waitUntil(endConversation(this.env.DB, convId));
      this.notifyConversationEnd(convId, msg.from, msg.to, 'max_turns');
      this.convTrackers.delete(convId);
      return { ok: false };
    }

    // 同步 D1（异步，不阻塞转发）
    this.state.waitUntil(incrementTurn(this.env.DB, convId));

    return { ok: true };
  }

  // ─── 会话结束消息处理 ─────────────────────────────────────────────────────

  private async handleEndMessage(msg: IncomingMessage, _ws: WebSocket): Promise<void> {
    if (!msg.conversation_id) return;
    const convId = msg.conversation_id;

    this.convTrackers.delete(convId);
    await endConversation(this.env.DB, convId);
    this.notifyConversationEnd(convId, msg.from, msg.to, 'participant_ended');
  }

  private notifyConversationEnd(
    convId: string,
    fromId: string,
    toId: string,
    reason: EndedMessage['reason'],
  ): void {
    const payload: EndedMessage = { type: 'conversation_ended', conversation_id: convId, reason };
    for (const agentId of [fromId, toId]) {
      const conn = this.connections.get(agentId);
      if (conn) this.send(conn.ws, payload);
    }
  }

  // ─── 离线队列推送 ─────────────────────────────────────────────────────────

  private async flushOfflineQueue(
    agentId: string,
    ws: WebSocket,
    _sessionKey: string,
  ): Promise<void> {
    const items = await getPendingMessages(this.env.DB, agentId);
    if (items.length === 0) return;

    const deliveredIds: number[] = [];
    for (const item of items) {
      const delivered: DeliveredMessage = {
        id:              item.message_id,
        from:            item.from_agent_id,
        to:              item.to_agent_id,
        type:            item.type as never,
        content:         item.content,
        timestamp:       item.timestamp,
        nonce:           item.nonce,
        signature:       item.signature,
        conversation_id: item.conversation_id,
        delivered_at:    Date.now(),
      };
      this.send(ws, delivered);
      deliveredIds.push(item.id);
    }

    await markMessagesDelivered(this.env.DB, deliveredIds);
  }

  // ─── 内部 HTTP 接口 ───────────────────────────────────────────────────────

  private handleOnlineCheck(url: URL): Response {
    const agentId = url.searchParams.get('agent_id');
    if (!agentId) return new Response('缺少 agent_id', { status: 400 });
    const online = this.connections.has(agentId);
    return Response.json({ agent_id: agentId, online });
  }

  private async handleHttpSend(request: Request): Promise<Response> {
    const body = await request.json<IncomingMessage>();
    const targetConn = this.connections.get(body.to);
    if (!targetConn) {
      return Response.json({ status: 'offline' }, { status: 202 });
    }
    const now = Date.now();
    // 为 HTTP 发送的消息补签名
    const sig = await signMessage(body, this.env.HMAC_SECRET);
    const delivered: DeliveredMessage = { ...body, signature: sig, delivered_at: now };
    this.send(targetConn.ws, delivered);
    return Response.json({ status: 'sent' });
  }

  // ─── 工具方法 ─────────────────────────────────────────────────────────────

  private send(ws: WebSocket, payload: ServerMessage): void {
    try { ws.send(JSON.stringify(payload)); } catch { /* 连接可能已断开 */ }
  }

  private sendStatus(ws: WebSocket, status: StatusMessage['status'], messageId: string, note?: string): void {
    this.send(ws, { type: 'status', status, message_id: messageId, ...(note ? { note } : {}) });
  }

  private sendError(ws: WebSocket, code: ErrorMessage['code'], message: string): void {
    this.send(ws, { type: 'error', code, message });
  }

  private findConn(ws: WebSocket): ConnectedAgent | undefined {
    for (const conn of this.connections.values()) {
      if (conn.ws === ws) return conn;
    }
    return undefined;
  }

  private checkNonce(nonce: string): boolean {
    const now = Date.now();
    this.cleanNonceCache(now);
    if (this.nonceCache.has(nonce)) return false;
    this.nonceCache.set(nonce, now + NONCE_TTL_MS);
    return true;
  }

  private cleanNonceCache(now: number): void {
    for (const [nonce, exp] of this.nonceCache) {
      if (exp < now) this.nonceCache.delete(nonce);
    }
  }

  // ─── 心跳 & 清理 ──────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.connections.values()) {
        try { conn.ws.send(JSON.stringify({ type: 'ping' })); }
        catch { this.connections.delete(conn.agentId); }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private startConvTTLCleaner(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [convId, tracker] of this.convTrackers) {
        if (now - tracker.lastActivity > CONV_TTL_MS) {
          this.state.waitUntil(endConversation(this.env.DB, convId));
          this.convTrackers.delete(convId);
        }
      }
    }, 60_000); // 每分钟扫描一次
  }
}
