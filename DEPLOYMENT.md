# P2P Cinema 部署指南（v2）

从零部署到 Cloudflare 免费层。v2 已完全移除 KV：房间状态与信令收敛进 Durable Object（SQLite 存储，免费计划支持），**无需创建任何 KV namespace、无需回填任何 ID、无需修改前端 API 地址**。

## 前置条件

- [Cloudflare](https://dash.cloudflare.com) 账号（免费即可）
- 本地已安装 Node.js >= 18

## 部署架构

```
GitHub 仓库 ──push main──→ GitHub Actions ──wrangler deploy──→ Cloudflare Worker
                                                             ├── 前端静态资产（同域服务）
                                                             └── Durable Object「RoomSignalDO」
                                                                 （房间状态 + WebSocket 信令）

最终域名: https://p2p-cinema-api.<your-subdomain>.workers.dev（前端与 API 同域）
```

## 方式 A：本地一键部署（最快）

```bash
npm install
npx wrangler login          # 浏览器授权
npm run deploy              # = wrangler deploy --config worker/wrangler.toml
```

首次部署自动创建 DO 迁移（`new_sqlite_classes`），之后每次部署为增量更新。

## 方式 B：GitHub Actions 自动部署

1. 获取凭证（只需这两个 Secret）：
   - **API Token**：Dashboard → My Profile → API Tokens → Create Token，选 **Edit Cloudflare Workers** 模板（无需 KV/Pages 权限）
   - **Account ID**：Dashboard → Workers & Pages 右侧边栏 API 区域
2. GitHub 仓库 → Settings → Secrets and variables → Actions，添加：

   | Secret 名称 | 值 |
   |-------------|-----|
   | `CLOUDFLARE_API_TOKEN` | 上一步的 Token |
   | `CLOUDFLARE_ACCOUNT_ID` | 上一步的 Account ID |

3. 推送到 `main` 分支：Actions 先跑 `npm test`，通过后自动 `wrangler deploy`。

## 验证部署

1. **REST 验证**：

   ```bash
   curl -X POST https://p2p-cinema-api.<your-subdomain>.workers.dev/api/room \
     -H "Content-Type: application/json" \
     -d '{"peerId":"test-peer"}'
   ```

   预期返回：

   ```json
   {"roomCode":"K4JJYH","peerId":"test-peer"}
   ```

2. **页面验证**：打开 Worker 域名，点击"创建房间"，确认能看到邀请码和房间界面。

3. **P2P 连接验证**：
   - 浏览器 A 创建房间，复制邀请码
   - 浏览器 B（或隐身窗口）输入邀请码加入 → 成员列表应立即显示双方
   - 房主点击"开始共享屏幕"，确认加入者能看到画面
   - 测试聊天、音量、全屏；关闭 B 标签页，确认 A 端秒级提示"已退出房间"（WS peer-left）

## 本地开发

```bash
npm install
npm run dev          # http://localhost:8787（前端 + API + DO 全本地模拟）
npm test             # 单测
npm run test:watch   # 监听模式
```

本地环境下前端与 API 同域（8787）；旧的双终端方式（frontend 目录 `npx serve -l 3000` + API 8787）依然兼容。

## API 接口文档

### POST /api/room — 创建房间

```http
POST /api/room
Content-Type: application/json

{"peerId": "peer-abc123"}
```

响应 `201`：`{"roomCode": "K4JJYH", "peerId": "peer-abc123"}`

### GET /api/room/:code — 查询房间

响应 `200`：`{"hostId": "peer-abc123", "participants": ["peer-abc123"]}`；不存在/过期 `404`。

### DELETE /api/room/:code — 解散房间（仅房主）

```http
DELETE /api/room/K4JJYH
Content-Type: application/json

{"peerId": "peer-abc123"}
```

房主 `200 {"ok": true}`；非房主 `403`；所有 WebSocket 连接会收到 `room-dissolved` 后被关闭。

### GET /api/signal/:code?peerId=... — WebSocket 信令通道

HTTP `101` 升级（房间不存在返回 `404`）。连接后：

- **服务端 → 客户端**（JSON 帧）：

  ```json
  {"from": "peer-abc", "to": "peer-xyz", "type": "offer|answer|ice|join|peer-left|room-dissolved", "data": "..."}
  ```

- **客户端 → 服务端**：`{"from": "...", "to": "<目标 peerId 或 *>", "type": "...", "data": "..."}`，服务端按 `to` 精确转发（`*` 广播给其他人），`from` 以连接身份（attachment）为准不可伪造。

- **服务端自动事件**：
  - 新连接建立 → 向房间其他人广播 `join`（房主收到后发起 WebRTC 连接；断线重连同样触发，实现自愈）
  - 连接断开 → 广播 `peer-left`（房主秒级移除成员）
  - 空房间 1 小时 → alarm 自动回收存储

所有 HTTP 响应包含 CORS 头：`Access-Control-Allow-Origin: *`

## 配置参数参考

| 参数 | 默认值 | 说明 | 位置 |
|------|--------|------|------|
| `ROOM_TTL_MS` | 3600000 | 空房间（无存活连接）回收时间；有连接时自动续期 | [worker/src/index.js](worker/src/index.js) |
| `CREATE_RETRIES` | 5 | 房间码碰撞换码重试次数 | 同上 |

### ICE 服务器（STUN + TURN）

- STUN（多路冗余，谁可达用谁）：`stun.cloudflare.com`、`stun.miwifi.com`、`stun.qq.com`（大陆可达）、`stun.l.google.com` ×2（境外）
- 静态 TURN 兜底（Open Relay 免费公共服务）：`turn:openrelay.metered.ca:80/443`（大陆可达性差，推荐按下节替换为 Cloudflare TURN）

修改位置：[frontend/js/webrtc.js](frontend/js/webrtc.js)。

### TURN 中继（强烈推荐）：Cloudflare Calls TURN 动态凭据

对称 NAT（蜂窝网络/部分家宽/企业网）下 STUN 打洞必然失败，必须有**可达的 TURN 中继**。内置的 Open Relay 在大陆基本超时，因此 v2 支持接入 **Cloudflare Calls TURN**（边缘覆盖好、免费额度内零成本）：前端进房时自动向 `/api/turn` 获取 1 小时时效的动态凭据。

1. Cloudflare Dashboard → **Realtime (Calls)** → TURN → 创建 TURN Key，记录 **Key ID**
2. 创建 API Token（权限：**Realtime (Calls) Edit**），记录 Token
3. 配置三个 Secret 并重新部署：

   ```bash
   npx wrangler secret put CF_ACCOUNT_ID        # Dashboard 右侧边栏 Account ID
   npx wrangler secret put CALLS_TURN_KEY_ID    # 第 1 步的 Key ID
   npx wrangler secret put CALLS_TURN_API_TOKEN # 第 2 步的 Token
   npm run deploy
   ```

4. 验证：`curl https://<你的域名>/api/turn` 返回 `{"enabled":true,"iceServers":{...}}` 即生效；未配置时返回 `{"enabled":false}`，前端自动回退静态 ICE，**不影响部署**。

> 凭据 TTL 1 小时，每次进房重新获取；TURN 流量按 Cloudflare Calls 计费（免费额度后 $0.05/GB），仅在 STUN 打洞失败时使用。

## 成本估算

| 资源 | 免费额度 | 预估日用量 | 是否够用 |
|------|---------|-----------|---------|
| Workers 请求 | 100K/天 | ~1K（50 房间 × 20 请求） | ✅ |
| DO 请求 | 100K/天 | ~2K（信令消息） | ✅ |
| DO CPU 时长 | 13,000 GB-s/天 | 微秒级信令处理 | ✅ |
| DO 存储 | 5 GB | < 100 KB | ✅ |
| 媒体流量 | 不经 Cloudflare | P2P 直连 | ✅ |
| **总计** | | | **0 元/月** |

## 常见问题

### Q: 屏幕共享对方看不到画面？

**A:** 检查以下几点：
1. 确认双方都使用了 HTTPS 或 localhost（WebRTC 需要安全上下文）
2. 房主是否在有人加入**之后**才开始共享屏幕（P2P 连接需要先建立）
3. 浏览器是否授予了屏幕共享权限
4. 严格 NAT（公司网/蜂窝对蜂窝）场景由 TURN 兜底（v2 已内置免费 TURN）；若 Open Relay 不可用，可替换为自有 TURN

### Q: 加入者输入邀请码后提示"Room not found"？

**A:** 可能原因：
1. 邀请码输入错误（注意大写，已排除易混淆字符 0/O/1/I/L）
2. 房间已过期（空房 1 小时回收；有观众在线会自动续期）
3. 房主已解散房间

### Q: 画面卡顿或掉帧？

**A:** 检查以下几点：
1. 房主网络上行带宽是否足够（建议 3Mbps 以上/每个观看者）
2. 房主屏幕分辨率过高时可降低共享分辨率
3. 代码已配置 `degradationPreference: 'maintain-framerate'`（优先保持帧率）

### Q: 观看者掉线了但成员列表还有 TA？

**A:** v2 不会：WebSocket 断开即广播 `peer-left`，房主秒级移除；另有 WebRTC 重连（ICE restart ×3）与 `peerFailed` 兜底。若仍出现，多为房主端浏览器休眠（标签页后台节流），切回标签页即恢复。

### Q: GitHub Actions 部署失败？

**A:** 检查以下几点：
1. 确认已配置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 两个 Secret
2. API Token 使用 **Edit Cloudflare Workers** 模板（v2 无需 KV/Pages 权限）
3. 在 Actions 日志中查看具体错误信息

### Q: 如何自定义域名（大陆访问更稳）？

**A:** Cloudflare Dashboard → Workers & Pages → 对应 Worker → Settings → Domains & Routes → Add Custom Domain（域名需托管在 Cloudflare DNS，免费）。前端与 API 同域，无需单独配置。

## 文件结构

```
p2p-cinema/
├── .github/workflows/
│   └── deploy.yml              # GitHub Actions 自动部署（测试 + wrangler deploy）
├── frontend/                   # 前端（Worker 静态资产同域部署）
│   ├── index.html              # 单页应用入口
│   ├── css/style.css           # 全部样式
│   └── js/
│       ├── app.js              # 主应用入口（UI 管理 + 模块协调）
│       ├── room.js             # 房间管理（创建/加入/邀请码）
│       ├── signal.js           # 信令客户端（WebSocket + 重连）
│       ├── webrtc.js           # WebRTC 封装（P2P mesh + DataChannel）
│       └── sync.js             # 同步播放控制（播放/暂停/进度/聊天）
├── worker/
│   ├── wrangler.toml           # Worker 配置 + DO 绑定与迁移
│   └── src/index.js            # 路由 + RoomSignalDO（房间状态机 + WS 信令）
├── test/                       # 测试（REST + DO 处理器 + 前端模块）
├── package.json
├── vitest.config.js
├── README.md
└── DEPLOYMENT.md               # 本文档
```

## 技术架构

### 数据流（v2，WebSocket 信令）

```
用户 A (房主)                          用户 B (加入者)
    │                                      │
    ├── POST /api/room ──→ DO ── 创建房间   │
    ├── 获得邀请码                          │
    │                                      │
    │      (分享邀请码给 B)                 │
    │                                      ├── GET /api/room/:code（校验房间）
    │                                      ├── WS /api/signal/:code 接入
    │◄────── DO 自动广播 join ──────────────┤
    ├── 收到 join → 创建 RTCPeerConnection  │
    ├── WS 发送 offer ──→ DO 转发 ─────────►│
    │◄───────────────── DO 转发 ◄── answer ─┤
    │◄──── 双向 ICE 候选经 DO 转发 ─────────►│
    ╞══════════ P2P 连接建立 ══════════════╡
    ├── MediaStream ──RTP──→───────────────►├── ontrack → video.play()
    ├── DataChannel ◄═══ 双向 ═════════════►┤（同步播放 + 聊天 + 成员广播）
```

### WebRTC 连接流程

1. 房主创建房间，获得 6 位邀请码
2. 加入者输入邀请码，REST 校验房间存在
3. 加入者建立 WebSocket → **服务端自动广播 join**（v1 需客户端手动发送）
4. 房主收到 join，发起 WebRTC Offer（若为重连则先回收旧连接）
5. 加入者收到 Offer，回 Answer
6. 双方经 DO 转发交换 ICE 候选
7. P2P 连接建立；任一端 WS 断开 → 服务端广播 peer-left → 秒级感知

### 房间状态生命周期

```
创建房间   → DO SQLite 写入 room（alarm 定时 1h）
信令交换   → WebSocket 实时转发（不落存储，无配额消耗）
连接活跃   → 每条消息/连接自动续期 alarm
房间结束   → 房主 DELETE → 广播 room-dissolved → 关闭 WS → 清空存储
           → 或空房 alarm 到期自动回收
```
