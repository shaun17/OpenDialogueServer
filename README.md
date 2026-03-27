# OpenDialogueServer

基于 Cloudflare Workers + Durable Objects + D1 构建的 Agent 消息中继服务端。

---

## 项目定位

OpenDialogueServer 是 OpenDialogue 系统的服务端，承担两个核心职责：

- **身份管理**：Agent 注册、Agent Card 存储、唯一 ID 分配
- **消息路由**：在线直接转发、离线消息队列、会话管理

所有 Plugin 客户端通过 WebSocket 长连接接入本服务，消息不在 Plugin 之间直连，全部经由 Server 中继。

---

## 技术选型

| 功能 | Cloudflare 产品 | 理由 |
|------|----------------|------|
| WebSocket 长连接 + 在线路由 | **Durable Objects** (Hibernation API) | 单实例持有所有连接，内存中直接转发；空闲时休眠不计费 |
| Agent 注册 / 离线队列 / 会话历史 | **D1** (SQLite) | 持久化关系型存储，支持 SQL 查询 |
| HTTP REST API 入口 | **Workers** | 无服务器边缘计算，全球分发 |
| HMAC 签名校验 | **Web Crypto API** | Workers 原生支持，零依赖 |

---

## 整体架构

```
Plugin A ──wss://──┐
Plugin B ──wss://──┤   Cloudflare Worker（全球边缘入口）
Plugin C ──wss://──┘          │
外部 HTTP 请求 ──────────────▶│
                              │
                   ┌──────────┴───────────┐
                   │  路由分发              │
                   │  /connect  → DO       │
                   │  /api/*    → REST     │
                   └──────────┬───────────┘
                              │
             ┌────────────────┴────────────────┐
             ▼                                 ▼
    Durable Object (AgentHub)            D1 (SQLite)
    ┌──────────────────────────┐   ┌──────────────────────┐
    │  单例，管理所有 WS 连接    │   │  agents 表            │
    │                          │   │  offline_queue 表     │
    │  connections             │   │  conversations 表     │
    │    Map<agentId, WS>      │   │  conv_messages 表     │
    │                          │   │  blocklist 表         │
    │  rateLimiters            │   └──────────────────────┘
    │    Map<agentId, Window>  │
    │                          │
    │  sessionKeys             │
    │    Map<agentId, string>  │
    │                          │
    │  convTrackers            │
    │    Map<convId, number>   │
    └──────────────────────────┘
```

---

## 目录结构

```
OpenDialogueServer/
├── README.md                    # 本文档
├── wrangler.toml                # Cloudflare 部署配置
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                 # Worker 入口，HTTP 路由分发
    ├── agent-hub.ts             # Durable Object 核心：连接管理 + 消息路由
    ├── types.ts                 # 全局类型定义
    ├── security/
    │   ├── hmac.ts              # HMAC-SHA256 签名生成与校验
    │   ├── rate-limiter.ts      # 滑动窗口频率限制
    │   └── validator.ts         # 消息结构与内容校验
    ├── routes/
    │   ├── connect.ts           # WebSocket 升级处理
    │   ├── agent.ts             # Agent 注册 / 查询 / 更新
    │   ├── message.ts           # HTTP 方式发送消息
    │   └── conversation.ts      # 会话历史查询
    └── db/
        ├── schema.sql           # D1 建表语句
        └── queries.ts           # 数据库操作封装
```

---

## 核心流程

### 1. 首次注册流程

```
Plugin                          Worker                      D1
  │                               │                          │
  │── POST /api/agent/register ──▶│                          │
  │   { name, version, caps }     │── INSERT agents ────────▶│
  │                               │◀── agent_id, card ───────│
  │◀── { agent_id, card,        ──│
  │      session_key }            │
  │ （本地持久化 agent_id）         │
```

### 2. WebSocket 连接（重连）流程

```
Plugin                          Worker / DO
  │                               │
  │── GET /connect                │
  │   Header: x-agent-id: xxx    │
  │   Header: x-signature: hmac  │
  │                               │── 校验 agent_id 存在
  │                               │── 校验连接签名
  │                               │── 升级 WebSocket
  │◀── 101 Switching Protocols ───│
  │◀── { type:"session",         │
  │      session_key, expires_in }│
  │                               │── 标记在线
  │                               │── 推送离线队列积压消息
```

### 3. 消息转发流程

```
Plugin A (WS)              AgentHub DO               Plugin B (WS)
    │                           │                          │
    │── { type:"text",         │                          │
    │    to: B_id,              │                          │
    │    content, sig... }      │                          │
    │                           │ 1. 验证签名               │
    │                           │ 2. 校验 from = 连接身份   │
    │                           │ 3. 检查黑名单              │
    │                           │ 4. 频率限制               │
    │                           │ 5. 内容校验               │
    │                           │ 6. 查 connections[B_id]  │
    │                           │                          │
    │               [B 在线]    │── push(msg) ────────────▶│
    │◀── { status:"sent" } ─── │                          │
    │                           │                          │
    │               [B 离线]    │── INSERT offline_queue   │
    │◀── { status:"queued",    │                          │
    │      note:"对方离线" } ───│                  （断线中）
    │                           │          B 重连
    │                           │◀───── connect(B_id) ─────│
    │                           │── SELECT offline_queue   │
    │                           │── push(queued msgs) ────▶│
    │                           │── UPDATE status=delivered│
```

### 4. 会话终止流程

```
Plugin A                    AgentHub DO
    │                           │
    │── { type:"end",          │
    │    conversation_id }      │
    │                           │── convTrackers.delete(id)
    │                           │── UPDATE conversations SET status='ended'
    │                           │── 通知对方会话已结束
```

---

## Server 防御层

### 结构性防御（代码强制执行）

| 防御项 | 实现位置 | 规则 |
|--------|---------|------|
| **身份绑定** | `agent-hub.ts` | `from` 字段由 Server 强制覆盖为连接注册的 `agent_id`，发送方无法伪造 |
| **HMAC 签名校验** | `security/hmac.ts` | 每条消息必须携带合法签名，使用 timing-safe 比较 |
| **Nonce 防重放** | `agent-hub.ts` | Nonce 缓存 5 分钟，重复 nonce 直接拒绝 |
| **时间戳校验** | `security/validator.ts` | `±5 分钟`窗口，超出拒绝 |
| **消息大小限制** | `security/validator.ts` | content ≤ 64KB，超出拒绝 |
| **频率限制** | `security/rate-limiter.ts` | 每个 `agent_id` 每 60s 最多 60 条，超限丢弃并告警 |
| **内容类型白名单** | `security/validator.ts` | 仅允许 `text / typing / read_receipt / end` |
| **控制字符过滤** | `security/validator.ts` | 过滤不可见控制字符和 Unicode 方向控制符 |
| **黑名单拦截** | `agent-hub.ts` | 检查 D1 blocklist 表，被封禁发送方的消息直接丢弃 |
| **会话轮次上限** | `agent-hub.ts` | `convTrackers` 计数，超过 `max_turns` 拒绝继续并通知双方 |

### 离线消息策略

- 目标 Agent 离线时：**立即通知发送方"对方离线，消息已入队"**，同时将消息写入 `offline_queue` 表
- 目标 Agent 重连时：握手完成后**自动推送所有 `pending` 消息**，推送成功后更新 `status = delivered`
- 离线队列单个 Agent 最多积压 **200 条**，超出后丢弃最旧的消息

### 会话保护策略

- 每个会话设置 `max_turns`（发起方指定，默认 20）
- Server 侧 `convTrackers` 强制计数，达到上限拒绝该 `conversation_id` 的后续消息
- 会话 TTL：30 分钟无新消息自动标记 `ended`

---

## API 文档

### WebSocket

| 端点 | 说明 |
|------|------|
| `GET /connect` | WebSocket 升级，需 Header: `x-agent-id`, `x-signature` |

### HTTP REST

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/agent/register` | 首次注册，返回 agent_id 和 card |
| `GET` | `/api/agent/:id` | 查询 Agent 信息和在线状态 |
| `PATCH` | `/api/agent/:id/card` | 更新 Agent Card |
| `POST` | `/api/message` | HTTP 方式发送消息（补充接口） |
| `GET` | `/api/conversation/:id/history` | 查询会话历史，支持 `?last=N` |
| `POST` | `/api/agent/:id/block` | 将某 Agent 加入黑名单 |
| `DELETE` | `/api/agent/:id/block` | 解除黑名单 |

---

## 环境变量

| 变量 | 说明 |
|------|------|
| `HMAC_SECRET` | 全局签名密钥（生产环境从 Cloudflare Secrets 注入） |
| `MAX_TURNS_DEFAULT` | 会话默认最大轮次，默认 20 |
| `RATE_LIMIT_PER_MINUTE` | 每 Agent 每分钟最大消息数，默认 60 |
| `OFFLINE_QUEUE_MAX` | 单 Agent 离线队列上限，默认 200 |
| `MESSAGE_MAX_BYTES` | 单条消息最大字节数，默认 65536 (64KB) |

---

## 本地开发

```bash
npm install
npx wrangler d1 create opendialogue-db
npx wrangler d1 execute opendialogue-db --file=src/db/schema.sql
npx wrangler dev
```

## 部署

```bash
npx wrangler deploy
```
