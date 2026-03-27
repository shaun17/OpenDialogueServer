/**
 * Security 模块单元测试
 * 覆盖：HMAC 签名、频率限制、消息结构校验
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimiter } from '../src/security/rate-limiter.js';
import { validateMessageStructure, castMessage } from '../src/security/validator.js';

// ─── HMAC 测试（依赖 Web Crypto，用 Node 原生 crypto 模拟）────────────────────
// hmac.ts 使用 globalThis.crypto，Node 18+ 已内置，直接导入即可
import { signMessage, verifySignature, randomHex } from '../src/security/hmac.js';

const SECRET = 'test-secret-key';

function makeMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aabbccdd11223344',
    from: 'agent-a',
    to: 'agent-b',
    content: 'hello',
    timestamp: Date.now(),
    nonce: randomHex(16),
    ...overrides,
  };
}

// ─── HMAC ─────────────────────────────────────────────────────────────────────

describe('HMAC', () => {
  it('生成签名后验证应通过', async () => {
    const msg = makeMsg();
    const sig = await signMessage(msg, SECRET);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBe(64); // SHA-256 hex = 64 chars

    const ok = await verifySignature({ ...msg, signature: sig }, SECRET);
    expect(ok).toBe(true);
  });

  it('签名错误应返回 false', async () => {
    const msg = makeMsg();
    const ok = await verifySignature({ ...msg, signature: 'deadbeef'.repeat(8) }, SECRET);
    expect(ok).toBe(false);
  });

  it('任意字段被篡改后签名失效', async () => {
    const msg = makeMsg();
    const sig = await signMessage(msg, SECRET);

    // 篡改 content
    const ok = await verifySignature({ ...msg, content: '恶意内容', signature: sig }, SECRET);
    expect(ok).toBe(false);
  });

  it('不同 secret 下签名不通过', async () => {
    const msg = makeMsg();
    const sig = await signMessage(msg, SECRET);
    const ok = await verifySignature({ ...msg, signature: sig }, 'wrong-secret');
    expect(ok).toBe(false);
  });

  it('randomHex 长度正确且每次不同', () => {
    const a = randomHex(16);
    const b = randomHex(16);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(a).not.toBe(b);
  });
});

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(5); // 每分钟最多 5 条
  });

  it('在限额内应允许通过', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('agent-a')).toBe(true);
    }
  });

  it('超出限额应返回 false', () => {
    for (let i = 0; i < 5; i++) limiter.check('agent-a');
    expect(limiter.check('agent-a')).toBe(false);
  });

  it('不同 agentId 互不影响', () => {
    for (let i = 0; i < 5; i++) limiter.check('agent-a');
    // agent-b 未达限额
    expect(limiter.check('agent-b')).toBe(true);
  });

  it('remove 后计数归零', () => {
    for (let i = 0; i < 5; i++) limiter.check('agent-a');
    expect(limiter.check('agent-a')).toBe(false);
    limiter.remove('agent-a');
    expect(limiter.check('agent-a')).toBe(true);
  });

  it('count 返回当前窗口内的消息数', () => {
    limiter.check('agent-a');
    limiter.check('agent-a');
    expect(limiter.count('agent-a')).toBe(2);
  });
});

// ─── Message Validator ────────────────────────────────────────────────────────

describe('validateMessageStructure', () => {
  const MAX_BYTES = 65536;

  function validRaw(overrides: Record<string, unknown> = {}) {
    return {
      id: 'aabbccdd11223344',
      from: 'agent-a',
      to: 'agent-b',
      type: 'text',
      content: 'hello world',
      timestamp: Date.now(),
      nonce: 'aabbccddeeff00112233445566778899',
      signature: 'a'.repeat(64),
      ...overrides,
    };
  }

  it('合法消息应通过校验', () => {
    const result = validateMessageStructure(validRaw(), MAX_BYTES);
    expect(result.ok).toBe(true);
  });

  it('缺少必填字段应失败', () => {
    const raw = validRaw();
    delete (raw as Record<string, unknown>)['signature'];
    const result = validateMessageStructure(raw, MAX_BYTES);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; code: string }).code).toBe('INVALID_CONTENT');
  });

  it('不允许的消息类型应失败', () => {
    const result = validateMessageStructure(validRaw({ type: 'exec' }), MAX_BYTES);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; code: string }).code).toBe('INVALID_MESSAGE_TYPE');
  });

  it('时间戳超出 5 分钟应失败', () => {
    const staleTs = Date.now() - 6 * 60 * 1000;
    const result = validateMessageStructure(validRaw({ timestamp: staleTs }), MAX_BYTES);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; code: string }).code).toBe('TIMESTAMP_EXPIRED');
  });

  it('内容超出大小限制应失败', () => {
    const bigContent = 'x'.repeat(100_000);
    const result = validateMessageStructure(validRaw({ content: bigContent }), MAX_BYTES);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; code: string }).code).toBe('MESSAGE_TOO_LARGE');
  });

  it('包含控制字符应失败', () => {
    const result = validateMessageStructure(validRaw({ content: 'hello\x00world' }), MAX_BYTES);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; code: string }).code).toBe('INVALID_CONTENT');
  });

  it('包含 Unicode 方向控制字符应失败（隐形注入攻击）', () => {
    const result = validateMessageStructure(validRaw({ content: 'hello\u202eworld' }), MAX_BYTES);
    expect(result.ok).toBe(false);
  });

  it('type=end 应通过校验', () => {
    const result = validateMessageStructure(validRaw({ type: 'end' }), MAX_BYTES);
    expect(result.ok).toBe(true);
  });

  it('非对象输入应失败', () => {
    expect(validateMessageStructure(null, MAX_BYTES).ok).toBe(false);
    expect(validateMessageStructure('string', MAX_BYTES).ok).toBe(false);
    expect(validateMessageStructure([], MAX_BYTES).ok).toBe(false);
  });

  it('castMessage 正确转型', () => {
    const raw = validRaw({ conversation_id: 'conv-123', max_turns: 10 });
    const msg = castMessage(raw);
    expect(msg.id).toBe(raw.id);
    expect(msg.conversation_id).toBe('conv-123');
    expect(msg.max_turns).toBe(10);
  });
});
