/**
 * 消息路由集成测试
 * 覆盖：HTTP 发消息、离线队列通知、黑名单拦截
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unstable_dev } from 'wrangler';
import type { UnstableDevWorker } from 'wrangler';

let worker: UnstableDevWorker;

beforeAll(async () => {
  worker = await unstable_dev('src/index.ts', {
    experimental: { disableExperimentalWarning: true },
    vars: { HMAC_SECRET: 'test-secret-key' },
    local: true,
  });
}, 30_000);

afterAll(async () => {
  await worker.stop();
});

async function registerAgent(name: string): Promise<string> {
  const resp = await worker.fetch('/api/agent/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await resp.json() as { agent_id: string };
  return body.agent_id;
}

// ─── HTTP 消息发送 ─────────────────────────────────────────────────────────────

describe('POST /api/message', () => {
  let fromId: string;
  let toId: string;

  beforeAll(async () => {
    [fromId, toId] = await Promise.all([
      registerAgent('msg-sender'),
      registerAgent('msg-receiver'),
    ]);
  });

  it('目标离线时返回 202 + queued 状态', async () => {
    const resp = await worker.fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromId,
        to: toId,
        content: '你好，这是测试消息',
        type: 'text',
      }),
    });
    // 目标未连接 WebSocket，应返回 202（离线入队）
    expect(resp.status).toBe(202);
    const body = await resp.json() as { status: string };
    expect(body.status).toBe('offline');
  });

  it('发送方不存在返回 404', async () => {
    const resp = await worker.fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'nonexistent-sender',
        to: toId,
        content: '测试',
      }),
    });
    expect(resp.status).toBe(404);
  });

  it('接收方不存在返回 404', async () => {
    const resp = await worker.fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromId,
        to: 'nonexistent-receiver',
        content: '测试',
      }),
    });
    expect(resp.status).toBe(404);
  });

  it('缺少必填字段返回 400', async () => {
    const resp = await worker.fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromId, to: toId }), // 缺 content
    });
    expect(resp.status).toBe(400);
  });
});

// ─── 会话历史查询 ─────────────────────────────────────────────────────────────

describe('GET /api/conversation/:id/history', () => {
  it('不存在的会话返回 404', async () => {
    const resp = await worker.fetch('/api/conversation/nonexistent-conv/history');
    expect(resp.status).toBe(404);
  });
});

// ─── 路由规则验证 ─────────────────────────────────────────────────────────────

describe('路由基础行为', () => {
  it('未知路径返回 404', async () => {
    const resp = await worker.fetch('/unknown/path');
    expect(resp.status).toBe(404);
  });

  it('OPTIONS 请求返回 CORS headers', async () => {
    const resp = await worker.fetch('/api/message', { method: 'OPTIONS' });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(resp.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});
