/**
 * HMAC-SHA256 签名工具
 * 使用 Web Crypto API，Workers 原生支持，零依赖
 */

/** 将 CryptoKey 缓存避免重复 import */
const keyCache = new Map<string, CryptoKey>();

async function importKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  keyCache.set(secret, key);
  return key;
}

/**
 * 生成消息签名
 * 签名材料: id|from|to|type|content|conversation_id[|turn_number]|timestamp|nonce
 */
export async function signMessage(
  params: { id: string; from: string; to: string; type: string; content: string; conversation_id: string; turn_number?: number; timestamp: number; nonce: string },
  secret: string,
): Promise<string> {
  const key = await importKey(secret);
  const turnMaterial = params.turn_number !== undefined ? `|${params.turn_number}` : '';
  const material = `${params.id}|${params.from}|${params.to}|${params.type}|${params.content}|${params.conversation_id}${turnMaterial}|${params.timestamp}|${params.nonce}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(material));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 校验消息签名（timing-safe）
 */
export async function verifySignature(
  params: { id: string; from: string; to: string; type: string; content: string; conversation_id: string; turn_number?: number; timestamp: number; nonce: string; signature: string },
  secret: string,
): Promise<boolean> {
  try {
    const key = await importKey(secret);
    const turnMaterial = params.turn_number !== undefined ? `|${params.turn_number}` : '';
    const material = `${params.id}|${params.from}|${params.to}|${params.type}|${params.content}|${params.conversation_id}${turnMaterial}|${params.timestamp}|${params.nonce}`;
    const sigBytes = hexToBytes(params.signature);
    if (!sigBytes) return false;
    return await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(material));
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(byte)) return null;
    arr[i / 2] = byte;
  }
  return arr;
}

/** 生成随机 hex 字符串，用于 session_key / nonce / message_id */
export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
