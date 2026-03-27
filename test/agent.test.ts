/**
 * Agent 注册 / 查询 / 黑名单 集成测试
 * 使用 wrangler unstable_dev 启动真实 Workers 运行时
 *
 * 运行前需先初始化本地 D1：npm run db:init
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

// ─── Agent 注册 ───────────────────────────────────────────────────────────────

describe('POST /api/agent/register', () => {
  it('注册成功返回 201 和 agent_id', async () => {
    const resp = await worker.fetch('/api/agent/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-agent', capabilities: ['text'] }),
    });
    expect(resp.status).toBe(201);
    const body = await resp.json() as { agent_id: string; card: unknown };
    expect(typeof body.agent_id).toBe('string');
    expect(body.agent_id.length).toBeGreaterThan(0);
    expect(body.card).toBeDefined();
  });

  it('缺少 name 字段返回 400', async () => {
    const resp = await worker.fetch('/api/agent/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: ['text'] }),
    });
    expect(resp.status).toBe(400);
  });

  it('非 JSON body 返回 400', async () => {
    const resp = await worker.fetch('/api/agent/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(resp.status).toBe(400);
  });

  it('同名 Agent 可以重复注册（生成不同 id）', async () => {
    const register = () => worker.fetch('/api/agent/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'duplicate-agent' }),
    });
    const [r1, r2] = await Promise.all([register(), register()]);
    const b1 = await r1.json() as { agent_id: string };
    const b2 = await r2.json() as { agent_id: string };
    expect(b1.agent_id).not.toBe(b2.agent_id);
  });
});

// ─── Agent 查询 ───────────────────────────────────────────────────────────────

describe('GET /api/agent/:id', () => {
  let agentId: string;

  beforeAll(async () => {
    const resp = await worker.fetch('/api/agent/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'query-test-agent', version: '2.0.0', capabilities: ['text', 'file'] }),
    });
    const body = await resp.json() as { agent_id: string };
    agentId = body.agent_id;
  });

  it('查询已注册的 Agent 返回 card 和在线状态', async () => {
    const resp = await worker.fetch(`/api/agent/${agentId}`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { card: { name: string; version: string; capabilities: string[] }; online: boolean };
    expect(body.card.name).toBe('query-test-agent');
    expect(body.card.version).toBe('2.0.0');
    expect(body.card.capabilities).toContain('text');
    expect(typeof body.online).toBe('boolean');
    expect(body.online).toBe(false); // 刚注册未连接
  });

  it('查询不存在的 Agent 返回 404', async () => {
    const resp = await worker.fetch('/api/agent/nonexistent-id-xyz');
    expect(resp.status).toBe(404);
  });
});

// ─── Agent Card 更新 ──────────────────────────────────────────────────────────

describe('PATCH /api/agent/:id/card', () => {
  let agentId: string;

  beforeAll(async () => {
    const resp = await worker.fetch('/api/agent/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'update-test-agent' }),
    });
    const body = await resp.json() as { agent_id: string };
    agentId = body.agent_id;
  });

  it('更新 name 和 description 后可查询到新值', async () => {
    const patchResp = await worker.fetch(`/api/agent/${agentId}/card`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'updated-name', description: '新的描述' }),
    });
    expect(patchResp.status).toBe(200);

    const getResp = await worker.fetch(`/api/agent/${agentId}`);
    const body = await getResp.json() as { card: { name: string; description: string } };
    expect(body.card.name).toBe('updated-name');
    expect(body.card.description).toBe('新的描述');
  });
});

// ─── 黑名单 ───────────────────────────────────────────────────────────────────

describe('黑名单管理', () => {
  let blockerId: string;
  let blockedId: string;

  beforeAll(async () => {
    const [r1, r2] = await Promise.all([
      worker.fetch('/api/agent/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'blocker-agent' }),
      }),
      worker.fetch('/api/agent/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'blocked-agent' }),
      }),
    ]);
    blockerId = ((await r1.json()) as { agent_id: string }).agent_id;
    blockedId = ((await r2.json()) as { agent_id: string }).agent_id;
  });

  it('添加黑名单返回 ok', async () => {
    const resp = await worker.fetch(`/api/agent/${blockerId}/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked_id: blockedId, reason: '测试屏蔽' }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('移除黑名单返回 ok', async () => {
    const resp = await worker.fetch(`/api/agent/${blockerId}/block`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked_id: blockedId }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('缺少 blocked_id 返回 400', async () => {
    const resp = await worker.fetch(`/api/agent/${blockerId}/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });
});
