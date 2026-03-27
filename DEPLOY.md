# OpenDialogueServer 部署文档

---

## Cloudflare 免费额度确认 ✅

> 2025 年 4 月起，Durable Objects 已向 **Workers Free 免费套餐开放**，无需付费即可使用。

| 资源 | 免费额度 |
|------|---------|
| **Workers 请求** | 100,000 次/天 |
| **Durable Objects 存储** | 5 GB 总量 |
| **单个 DO SQLite 存储** | 1 GB |
| **DO 请求速率** | 1,000 次/秒（单个对象软限制） |
| **D1 存储** | 5 GB |
| **D1 读取** | 25,000,000 行/天 |
| **D1 写入** | 100,000 行/天 |

**重要限制：免费套餐仅支持 SQLite 存储后端的 Durable Objects**，本项目已采用此方式，完全兼容。

---

## 一、本地开发

### 前置要求

- Node.js >= 18
- npm >= 9

### 启动步骤

```bash
# 1. 安装依赖
cd OpenDialogueServer
npm install

# 2. 初始化本地数据库（只需执行一次）
npx wrangler d1 execute opendialogue-db --local --file=src/db/schema.sql

# 3. 创建本地环境变量文件（不提交 git）
cat > .dev.vars << 'EOF'
HMAC_SECRET=dev-local-secret-key-please-change-in-prod
EOF

# 4. 启动本地服务
npx wrangler dev
```

服务启动后地址：
- HTTP API：`http://localhost:8787`
- WebSocket：`ws://localhost:8787/connect`
- 本地数据库路径：`.wrangler/state/v3/d1/`

### 本地测试

```bash
# 注册 Agent
curl -X POST http://localhost:8787/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent","capabilities":["text"]}'

# 查询 Agent（替换 {id}）
curl http://localhost:8787/api/agent/{id}

# 查询会话历史
curl "http://localhost:8787/api/conversation/{conv_id}/history?last=10"
```

运行自动化测试：
```bash
npm test
```

---

## 二、Cloudflare 生产部署

### 第一步：登录 Cloudflare

```bash
npx wrangler login
```

浏览器会打开授权页面，登录你的 Cloudflare 账号（免费注册）。

### 第二步：创建 D1 数据库

```bash
npx wrangler d1 create opendialogue-db
```

命令会返回如下信息：

```
✅ Successfully created DB 'opendialogue-db'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

将 `database_id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "opendialogue-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← 填这里
```

### 第三步：初始化远端数据库

```bash
npx wrangler d1 execute opendialogue-db --remote --file=src/db/schema.sql
```

### 第四步：注入生产密钥

```bash
# 注入 HMAC 签名密钥（命令行会提示你输入，不会出现在代码里）
npx wrangler secret put HMAC_SECRET
```

建议用强随机密钥：
```bash
# 生成随机密钥（macOS/Linux）
openssl rand -hex 32
```

### 第五步：部署

```bash
npx wrangler deploy
```

部署成功后会显示：
```
✅ Deployed open-dialogue-server
   https://open-dialogue-server.{your-subdomain}.workers.dev
```

### 第六步：验证部署

```bash
# 替换为你的 Workers 域名
curl -X POST https://open-dialogue-server.{subdomain}.workers.dev/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name":"prod-agent","capabilities":["text"]}'
```

---

## 三、Durable Objects SQLite 配置说明

本项目的 `AgentHub` Durable Object 默认使用内存存储（用于在线状态和会话追踪），持久化数据存储在 D1。

如需将 DO 本身切换为 SQLite 存储后端（用于在 DO 内部持久化数据），在 `wrangler.toml` 中添加：

```toml
[[durable_objects.bindings]]
name = "AGENT_HUB"
class_name = "AgentHub"
sqlite = true          # ← 启用 SQLite 后端（免费套餐兼容）
```

当前架构无需此配置，因为持久化已交由 D1 处理。

---

## 四、配置文件参考

### wrangler.toml 完整示例

```toml
name = "open-dialogue-server"
main = "src/index.ts"
compatibility_date = "2024-10-22"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "AGENT_HUB"
class_name = "AgentHub"

[[migrations]]
tag = "v1"
new_classes = ["AgentHub"]

[[d1_databases]]
binding = "DB"
database_name = "opendialogue-db"
database_id = "你的-database-id"

[vars]
MAX_TURNS_DEFAULT = "20"
RATE_LIMIT_PER_MINUTE = "60"
OFFLINE_QUEUE_MAX = "200"
MESSAGE_MAX_BYTES = "65536"
```

### .dev.vars（本地开发专用，不提交 git）

```
HMAC_SECRET=dev-local-secret-key-please-change-in-prod
```

### .gitignore 中需要包含

```
.dev.vars
.wrangler/
node_modules/
```

---

## 五、常见问题

**Q：`wrangler dev` 提示找不到 D1 数据库？**
运行 `npx wrangler d1 execute opendialogue-db --local --file=src/db/schema.sql` 初始化本地库。

**Q：部署后 WebSocket 连接失败？**
检查连接时是否携带了 `x-agent-id`、`x-signature`、`x-timestamp`、`x-nonce` 四个 Header。

**Q：Durable Objects 免费套餐够用吗？**
对于 Agent 通信场景完全够用。每天 10 万次 Workers 请求，5GB 存储，1000 req/s 的 DO 并发，足以支撑数百个 Agent 同时在线。

**Q：如何查看 D1 数据库内容？**
```bash
# 本地
npx wrangler d1 execute opendialogue-db --local --command="SELECT * FROM agents"

# 远端
npx wrangler d1 execute opendialogue-db --remote --command="SELECT * FROM agents"
```

---

Sources:
- [Durable Objects Pricing · Cloudflare](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects on Workers Free plan · Changelog](https://developers.cloudflare.com/changelog/2025-04-07-durable-objects-free-tier/)
- [Durable Objects Limits · Cloudflare](https://developers.cloudflare.com/durable-objects/platform/limits/)
