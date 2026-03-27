/**
 * 消息结构与内容校验
 * Server 防御层：结构性安全的第一道关卡
 */

import type { IncomingMessage, MessageType } from '../types.js';

const ALLOWED_TYPES: MessageType[] = ['text', 'typing', 'read_receipt', 'end'];

/** 不可见控制字符 + Unicode 方向控制符 */
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\u200b-\u200d\ufeff\u202a-\u202e\u2066-\u2069]/;

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // ±5 分钟

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * 校验消息结构、时间戳、类型、大小、内容
 * 注意：签名校验和 nonce 防重放在 AgentHub 中处理（需要 session_key 和 nonce 缓存）
 */
export function validateMessageStructure(
  raw: unknown,
  maxBytes: number,
): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'INVALID_CONTENT', message: '消息必须是 JSON 对象' };
  }

  const msg = raw as Record<string, unknown>;

  // 1. 必填字段完整性
  const required = ['id', 'from', 'to', 'type', 'content', 'timestamp', 'nonce', 'signature', 'conversation_id'];
  for (const field of required) {
    if (msg[field] === undefined || msg[field] === null) {
      return { ok: false, code: 'INVALID_CONTENT', message: `缺少必填字段: ${field}` };
    }
  }

  // 2. 字段类型检查
  if (typeof msg['id'] !== 'string' || typeof msg['from'] !== 'string' ||
      typeof msg['to'] !== 'string' || typeof msg['type'] !== 'string' ||
      typeof msg['content'] !== 'string' || typeof msg['timestamp'] !== 'number' ||
      typeof msg['nonce'] !== 'string' || typeof msg['signature'] !== 'string' ||
      typeof msg['conversation_id'] !== 'string') {
    return { ok: false, code: 'INVALID_CONTENT', message: '字段类型错误' };
  }

  // 2a. turn_number 类型检查（可选）
  if (msg['turn_number'] !== undefined && (typeof msg['turn_number'] !== 'number' || !Number.isInteger(msg['turn_number']) || (msg['turn_number'] as number) <= 0)) {
    return { ok: false, code: 'INVALID_CONTENT', message: 'turn_number 必须是正整数' };
  }

  // 3. 消息类型白名单
  if (!ALLOWED_TYPES.includes(msg['type'] as MessageType)) {
    return { ok: false, code: 'INVALID_MESSAGE_TYPE', message: `不允许的消息类型: ${msg['type']}` };
  }

  // 4. 时间戳新鲜度
  const drift = Math.abs(Date.now() - (msg['timestamp'] as number));
  if (drift > TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, code: 'TIMESTAMP_EXPIRED', message: '消息时间戳超出有效范围' };
  }

  // 5. 消息大小（按字节估算，UTF-8 最多 4 字节/字符）
  const content = msg['content'] as string;
  const byteEstimate = content.length * 4;
  if (byteEstimate > maxBytes) {
    return { ok: false, code: 'MESSAGE_TOO_LARGE', message: `消息超过最大限制 ${maxBytes} 字节` };
  }

  // 6. 控制字符过滤
  if (CONTROL_CHAR_RE.test(content)) {
    return { ok: false, code: 'INVALID_CONTENT', message: '消息内容包含非法控制字符' };
  }

  return { ok: true };
}

/** 将已校验的 raw 对象转型为 IncomingMessage */
export function castMessage(raw: Record<string, unknown>): IncomingMessage {
  return {
    id: raw['id'] as string,
    from: raw['from'] as string,
    to: raw['to'] as string,
    type: raw['type'] as MessageType,
    content: raw['content'] as string,
    timestamp: raw['timestamp'] as number,
    nonce: raw['nonce'] as string,
    signature: raw['signature'] as string,
    conversation_id: raw['conversation_id'] as string,
    turn_number: typeof raw['turn_number'] === 'number' ? raw['turn_number'] : undefined,
    max_turns: typeof raw['max_turns'] === 'number' ? raw['max_turns'] : undefined,
  };
}
