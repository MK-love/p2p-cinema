# P2P Cinema 部署指南

本文档详细说明如何将 P2P Cinema 从零部署到 Cloudflare 免费层，并通过 GitHub Actions 实现自动部署。

## 前置条件

- [GitHub](https://github.com) 账号
- [Cloudflare](https://dash.cloudflare.com) 账号（免费即可）
- 本地已安装 Node.js >= 18

## 部署架构

```
GitHub 仓库
  ├── frontend/  → Cloudflare Pages (Git 集成自动部署)
  └── worker/    → Cloudflare Workers (GitHub Actions 自动部署)

最终域名:
  前端: https://p2p-cinema.pages.dev
  后端: https://p2p-cinema-api.<your-subdomain>.workers.dev
```

## 步骤一：创建 Cloudflare KV Namespace

P2P 信令交换依赖 Cloudflare KV 存储房间状态和信令消息。

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单 → **Workers & Pages** → **KV**
3. 点击 **Create Namespace**，创建两个 namespace：

   | Namespace 名称 | 用途 |
   |----------------|------|
   | `p2p-cinema-rooms` | 存储房间状态（房主 ID、创建时间、参与者） |
   | `p2p-cinema-signals` | 存储信令消息（WebRTC SDP/ICE 交换） |

4. 创建后，每个 namespace 会有一个 **ID**（格式如 `a1b2c3d4...`），记录这两个 ID

   > 在 namespace 列表页可看到 ID，或点击进入详情页复制

## 步骤二：获取 Cloudflare API Token 和 Account ID

部署需要两个凭证，GitHub Actions 会使用它们。

### API Token

1. Cloudflare Dashboard → 右上角头像 → **My Profile** → **API Tokens**
2. 点击 **Create Token**
3. 选择 **Edit Cloudflare Workers** 模板，或手动创建 Custom Token，确保包含以下权限：
   - **Account** - Workers Scripts - Edit
   - **Account** - Workers KV Storage - Edit
   - **Account** - Cloudflare Pages - Edit
4. 创建后**立即复制 Token**（只显示一次）

### Account ID

1. Cloudflare Dashboard → 任意域名或 **Workers & Pages** 页面
2. 右侧边栏 **API** 区域可看到 **Account ID**
3. 复制保存

## 步骤三：推送代码到 GitHub

```bash
cd p2p-cinema
git init
git remote add origin https://github.com/<你的用户名>/p2p-cinema.git
git branch -M main
git push -u origin main
```

## 步骤四：配置 KV Namespace ID

编辑 [worker/wrangler.toml](worker/wrangler.toml)，将两个 `id` 替换为步骤一获得的真实 KV ID：

```toml
[[kv_namespaces]]
binding = "ROOMS"
id = "替换为 p2p-cinema-rooms 的真实 ID"

[[kv_namespaces]]
binding = "SIGNALS"
id = "替换为 p2p-cinema-signals 的真实 ID"
```

提交并推送到 GitHub：

```bash
git add worker/wrangler.toml
git commit -m "config: set real KV namespace IDs"
git push
```

## 步骤五：配置 GitHub Secrets

在 GitHub 仓库中配置 Cloudflare 凭证，供 GitHub Actions 使用。

1. GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions**
2. 点击 **New repository secret**，添加两个：

   | Secret 名称 | 值 |
   |-------------|-----|
   | `CLOUDFLARE_API_TOKEN` | 步骤二获取的 API Token |
   | `CLOUDFLARE_ACCOUNT_ID` | 步骤二获取的 Account ID |

## 步骤六：配置前端 API 地址

编辑 [frontend/js/app.js](frontend/js/app.js) 第 11 行，将占位符替换为你的 Worker 子域名：

```javascript
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://p2p-cinema-api.<your-subdomain>.workers.dev'
```

> `<your-subdomain>` 是你的 Cloudflare 账号子域名，在 Dashboard → Workers & Pages 中可以看到已部署的 Worker 地址。

提交并推送：

```bash
git add frontend/js/app.js
git commit -m "config: set production API base URL"
git push
```

## 步骤七：首次部署

推送到 `main` 分支后，GitHub Actions 会自动触发部署。

### 方式 A：GitHub Actions 自动部署（推荐）

push 到 `main` 后，GitHub 仓库 → **Actions** 标签页可以看到部署流程：

- **deploy-pages** job：部署前端到 Cloudflare Pages
- **deploy-worker** job：先运行 `npm test`，测试通过后部署 Worker

两个 job 并行执行，各自完成后即可访问。

### 方式 B：手动验证部署

如果 GitHub Actions 尚未配置或需要手动验证，可以本地部署：

```bash
# 本地安装依赖
npm install

# 部署 Worker（需要 wrangler 登录）
npx wrangler login
npx wrangler deploy --config worker/wrangler.toml

# 前端在 Cloudflare Dashboard 手动创建 Pages 项目
# 连接 GitHub 仓库，构建输出目录填 frontend
```

## 步骤八：验证部署

1. **Worker 验证**：

   ```bash
   curl -X POST https://p2p-cinema-api.<your-subdomain>.workers.dev/api/room \
     -H "Content-Type: application/json" \
     -d '{"peerId":"test-peer"}'
   ```

   预期返回：

   ```json
   {"roomCode":"K4JJYH","peerId":"test-peer"}
   ```

2. **前端验证**：

   打开 `https://p2p-cinema.pages.dev`，点击"创建房间"，确认能看到邀请码和房间界面。

3. **P2P 连接验证**：

   - 在浏览器 A 创建房间，复制邀请码
   - 在浏览器 B（或隐身窗口）输入邀请码加入
   - 房主点击"开始共享屏幕"，确认加入者能看到画面
   - 测试聊天、音量、全屏等功能

## 本地开发

```bash
# 安装依赖
npm install

# 终端 1：启动 Worker（端口 8787）
npm run dev:worker

# 终端 2：启动前端静态服务（端口 3000）
cd frontend && npx serve -l 3000

# 运行测试
npm test

# 测试监听模式
npm run test:watch
```

打开 `http://localhost:3000` 即可本地使用。本地环境下 API 自动指向 `http://localhost:8787`。

> **注意**：`getDisplayMedia`（屏幕共享）和 WebRTC 需要安全上下文。`localhost` 是安全上下文，可正常使用。生产环境的 HTTPS 也是安全上下文。

## API 接口文档

### POST /api/room — 创建房间

```http
POST /api/room
Content-Type: application/json

{"peerId": "peer-abc123"}
```

响应 `201`：

```json
{"roomCode": "K4JJYH", "peerId": "peer-abc123"}
```

### GET /api/room/:code — 查询房间

```http
GET /api/room/K4JJYH
```

响应 `200`：

```json
{"hostId": "peer-abc123", "participants": ["peer-abc123"]}
```

房间不存在或过期时响应 `404`：

```json
{"error": "Room not found or expired"}
```

### DELETE /api/room/:code — 删除房间（仅房主）

```http
DELETE /api/room/K4JJYH
Content-Type: application/json

{"peerId": "peer-abc123"}
```

房主删除响应 `200`：`{"ok": true}`

非房主删除响应 `403`：`{"error": "Only host can delete room"}`

### POST /api/signal/:code — 发送信令消息

```http
POST /api/signal/K4JJYH
Content-Type: application/json

{"from": "peer-abc", "to": "peer-xyz", "type": "offer", "data": "<SDP JSON>"}
```

`type` 可选值：`offer` | `answer` | `ice` | `join`

响应 `200`：`{"ok": true}`

### GET /api/signal/:code?since=timestamp — 轮询信令

```http
GET /api/signal/K4JJYH?since=1695000000000
```

响应 `200`：

```json
{
  "messages": [
    {"from": "peer-abc", "to": "peer-xyz", "type": "offer", "data": "...", "ts": 1695000001234}
  ]
}
```

所有响应包含 CORS 头：`Access-Control-Allow-Origin: *`

## 配置参数参考

### Worker 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_SIGNAL_MESSAGES` | 100 | 每个房间信令消息上限，超出后自动截断 |
| `ROOM_TTL` | 3600 秒 | 房间数据 KV 过期时间 |
| `SIGNAL_TTL` | 600 秒 | 信令消息 KV 过期时间 |

修改位置：[worker/src/index.js](worker/src/index.js) 第 9-11 行

### STUN 服务器

使用 Google 免费 STUN 服务器：

- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`

修改位置：[frontend/js/webrtc.js](frontend/js/webrtc.js) 第 3-6 行

## 成本估算

| 资源 | 免费额度 | 预估日用量 | 是否够用 |
|------|---------|-----------|---------|
| Cloudflare Pages | 无限请求 | 低 | ✅ |
| Cloudflare Workers | 100K 请求/天 | ~1K（50 房间 × 20 请求） | ✅ |
| KV 读取 | 100K/天 | ~1.5K（50 × 30 轮询） | ✅ |
| KV 写入 | 1K/天 | ~750（50 × 15 写入） | ✅ |
| STUN 服务器 | 免费 | - | ✅ |
| **总计** | | | **0 元/月** |

## 常见问题

### Q: 屏幕共享对方看不到画面？

**A:** 检查以下几点：
1. 确认双方都使用了 HTTPS 或 localhost（WebRTC 需要安全上下文）
2. 房主是否在有人加入**之后**才开始共享屏幕（P2P 连接需要先建立）
3. 浏览器是否授予了屏幕共享权限
4. 如果在严格 NAT 环境下（如公司网络），可能需要 TURN 服务器（V1 未提供）

### Q: 加入者输入邀请码后提示"Room not found"？

**A:** 可能原因：
1. 邀请码输入错误（注意大写，已排除易混淆字符 0/O/1/I/L）
2. 房间已过期（TTL 1 小时）
3. 房主已解散房间

### Q: 画面卡顿或掉帧？

**A:** 检查以下几点：
1. 房主网络上行带宽是否足够（建议 3Mbps 以上）
2. 房主屏幕分辨率过高时可降低共享分辨率
3. 代码已配置 `degradationPreference: 'maintain-framerate'`（优先保持帧率）

### Q: 本地开发时 Worker 启动失败？

**A:** 确保：
1. 已执行 `npm install`（wrangler 在 devDependencies 中）
2. `worker/wrangler.toml` 中的 KV ID 已替换为真实值（或 `npx wrangler kv:namespace create` 本地创建）
3. 运行 `npm run dev:worker` 而非直接 `wrangler dev`

### Q: GitHub Actions 部署失败？

**A:** 检查以下几点：
1. 确认已配置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 两个 Secret
2. API Token 是否包含 Workers、KV、Pages 三项权限
3. `worker/wrangler.toml` 中的 KV ID 是否已替换为真实值
4. 在 Actions 日志中查看具体错误信息

### Q: 如何自定义域名？

**A:**
- **Pages**：Cloudflare Dashboard → Pages 项目 → Custom domains → 添加域名（需域名在 Cloudflare DNS 管理）
- **Workers**：Cloudflare Dashboard → Workers → 对应 Worker → Triggers → Custom Domains

两者均免费。

## 文件结构

```
p2p-cinema/
├── .github/workflows/
│   └── deploy.yml              # GitHub Actions 自动部署
├── frontend/                   # 前端（Cloudflare Pages 部署）
│   ├── _headers                # Cloudflare Pages 安全头
│   ├── index.html              # 单页应用入口
│   ├── css/style.css           # 全部样式
│   └── js/
│       ├── app.js              # 主应用入口（UI 管理 + 模块协调）
│       ├── room.js             # 房间管理（创建/加入/邀请码）
│       ├── signal.js           # 信令客户端（HTTP 轮询）
│       ├── webrtc.js           # WebRTC 封装（P2P mesh + DataChannel）
│       └── sync.js             # 同步播放控制（播放/暂停/进度/聊天）
├── worker/                     # 后端（Cloudflare Worker）
│   ├── wrangler.toml           # Worker 配置 + KV 绑定
│   └── src/index.js            # 信令 API（房间管理 + 信令交换 + CORS）
├── test/                       # 测试
│   ├── frontend/
│   │   ├── room.test.js        # 房间管理测试
│   │   └── sync.test.js        # 同步控制测试
│   └── worker/
│       └── index.test.js       # Worker API 测试
├── package.json
├── vitest.config.js
├── README.md
└── DEPLOYMENT.md               # 本文档
```

## 技术架构

### 数据流

```
用户 A (房主)                     用户 B (加入者)
    │                                 │
    ├── POST /api/room ──→ KV ──→ 创建房间
    ├── 获得邀请码                     │
    │                                 │
    │   (分享邀请码给 B)               │
    │                                 │
    │                                 ├── GET /api/room/:code ──→ KV
    │                                 ├── 获得房主 peerId
    │                                 ├── POST /api/signal (join 通知) ──→ KV
    │                                 │
    ├── GET /api/signal (轮询) ──→ KV │
    ├── 收到 join 通知                 │
    ├── 创建 WebRTC Offer              │
    ├── POST /api/signal (offer) ──→ KV
    │                                 ├── GET /api/signal ──→ KV
    │                                 ├── 收到 Offer
    │                                 ├── 创建 Answer
    │                                 ├── POST /api/signal (answer) ──→ KV
    ├── GET /api/signal ──→ KV        │
    ├── 收到 Answer                    │
    ├── ICE 候选交换 (通过 KV 轮询)    │
    │                                 │
    ╞═════════ P2P 连接建立 ═════════╡
    │                                 │
    ├── MediaStream ──RTP──→──────────├── ontrack → video.play()
    ├── DataChannel ←════════════════┤── DataChannel (双向)
    │                                 │
    ├── 停止轮询                       ├── 停止轮询
```

### WebRTC 连接流程

1. 房主创建房间，获得 6 位邀请码
2. 加入者输入邀请码，从 KV 获取房主 peerId
3. 加入者通过 KV 发送 `join` 信令通知房主
4. 房主轮询到 `join`，发起 WebRTC Offer（创建 RTCPeerConnection）
5. 加入者收到 Offer，创建 Answer 返回
6. 双方交换 ICE 候选（通过 KV 轮询）
7. P2P 连接建立，停止轮询
8. 房主共享屏幕 → MediaStream 通过 RTP 传输
9. DataChannel 建立双向数据通道（同步播放控制 + 聊天）

### 房间状态生命周期

```
创建房间 → KV 写入 room:{code} (TTL 1h)
         → KV 写入 signal:{code} = [] (TTL 10min)

信令交换 → 每次 POST /api/signal 刷新 SIGNALS TTL
         → 消息超过 100 条自动截断

P2P 建立 → 停止轮询，纯 P2P 通信

房间结束 → 房主 DELETE /api/room → 删除 room + signal
         → 或 TTL 自动过期
```
