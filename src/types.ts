// ─── 环境变量 & Bindings ────────────────────────────────────────────────────

export interface Env {
  AGENT_HUB: DurableObjectNamespace;
  DB: D1Database;
  HMAC_SECRET: string;
  MAX_TURNS_DEFAULT: string;
  RATE_LIMIT_PER_MINUTE: string;
  OFFLINE_QUEUE_MAX: string;
  MESSAGE_MAX_BYTES: string;
}

// ─── Agent ──────────────────────────────────────────────────────────────────

export interface AgentCard {
  agent_id: string;
  name: string;
  version: string;
  capabilities: string[];
  description?: string;
  created_at: number;
  updated_at: number;
}

export interface AgentStatus {
  agent_id: string;
  online: boolean;
  card: AgentCard;
}

// ─── 消息 ────────────────────────────────────────────────────────────────────

export type MessageType = 'text' | 'typing' | 'read_receipt' | 'end';

/** Plugin → Server 发来的原始消息 */
export interface IncomingMessage {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  content: string;
  timestamp: number;
  nonce: string;
  signature: string;
  conversation_id: string;
  turn_number?: number; // 发送方本轮轮次，Server 校验与内部计数一致
  max_turns?: number;   // 仅在创建新会话时携带
}

/** Server → Plugin 投递的消息（from 由 Server 覆写，保证不可伪造） */
export interface DeliveredMessage extends IncomingMessage {
  delivered_at: number;
}

// ─── WebSocket 控制消息 ───────────────────────────────────────────────────────

export interface SessionMessage {
  type: 'session';
  session_key: string;
  expires_in: number;   // 秒
}

export interface StatusMessage {
  type: 'status';
  status: 'sent' | 'queued' | 'rejected';
  message_id: string;
  note?: string;
}

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export interface PingMessage  { type: 'ping' }
export interface PongMessage  { type: 'pong' }
export interface EndedMessage {
  type: 'conversation_ended';
  conversation_id: string;
  reason: 'max_turns' | 'ttl' | 'participant_ended';
}

export type ServerMessage =
  | SessionMessage
  | StatusMessage
  | ErrorMessage
  | PingMessage
  | PongMessage
  | EndedMessage
  | DeliveredMessage;

// ─── 错误码 ──────────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'INVALID_SIGNATURE'
  | 'REPLAY_ATTACK'
  | 'TIMESTAMP_EXPIRED'
  | 'RATE_LIMITED'
  | 'MESSAGE_TOO_LARGE'
  | 'INVALID_MESSAGE_TYPE'
  | 'INVALID_CONTENT'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_BLOCKED'
  | 'CONVERSATION_ENDED'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR';

// ─── 会话 ────────────────────────────────────────────────────────────────────

export interface Conversation {
  conversation_id: string;
  initiator_id: string;
  participant_id: string;
  max_turns: number;
  current_turn: number;
  status: 'active' | 'ended' | 'expired';
  created_at: number;
  updated_at: number;
}

// ─── 离线队列 ────────────────────────────────────────────────────────────────

export interface OfflineQueueItem {
  id: number;
  conversation_id?: string;
  from_agent_id: string;
  to_agent_id: string;
  message_id: string;
  type: string;
  content: string;
  timestamp: number;
  nonce: string;
  signature: string;
  status: 'pending' | 'delivered' | 'expired';
  created_at: number;
  delivered_at?: number;
}

// ─── DO 内部状态 ──────────────────────────────────────────────────────────────

/** DO 内存中维护的单个 Agent 连接信息 */
export interface ConnectedAgent {
  ws: WebSocket;
  agentId: string;
  sessionKey: string;
  connectedAt: number;
}

/** 频率限制滑动窗口 */
export interface RateWindow {
  timestamps: number[];
}
