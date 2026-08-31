# P2P Cinema

P2P 在线观影网站，部署在 Cloudflare 免费层，零成本运行。**v2 架构（Durable Object + WebSocket 信令）零配置部署：不建 KV、不填 ID、单条命令上线。**

## 功能

- 创建私人房间 + 6 位邀请码邀请
- 昵称系统（自定义或自动生成）
- 屏幕共享观影（WebRTC P2P，画质清晰不掉帧）
- URL 直链同步播放（DataChannel 同步控制）
- 实时聊天 + 参与者列表（侧栏标签页）
- 房主解散房间 / 加入者退出房间；断线即时感知 + 自动重连自愈
- 视频工具栏：全屏、画中画、缩放模式、播放/暂停
- 音量控制（滑块 + 静音切换）

## 技术栈（v2）

- **前端**：纯 HTML/CSS/JS (ES modules)，无框架、无构建，由 Worker 静态资产服务（同域）
- **后端**：Cloudflare Workers + **Durable Object（SQLite 存储）**，**WebSocket 推送信令**
- **通信**：WebRTC P2P mesh + DataChannel；STUN + 免费 TURN（对称 NAT 兜底）
- **部署**：`wrangler deploy` 单命令 或 GitHub Actions 自动部署

### v1 → v2 变更

| 项 | v1 | v2 | 原因 |
|---|---|---|---|
| 信令 | KV + HTTP 500ms 轮询 | Durable Object + WebSocket | KV 最终一致（跨节点可达 60s）、读改写并发丢消息、毫秒游标同毫秒/回拨丢消息（曾致"同房间互看不到对方"）；DO 串行化彻底消除 |
| 存储 | 2 个 KV namespace | DO 内置 SQLite | 免费配额不再被轮询消耗（KV 写仅 1K/天）；部署免建 namespace 免填 ID |
| ICE | 仅 STUN | STUN + 免费 TURN | 对称 NAT/企业网下无 TURN 永远连不上 |

## 快速开始

### 本地开发

```bash
npm install
npm run dev        # http://localhost:8787 —— 前端 + API + DO 全在一个服务里
```

开两个浏览器窗口：一个"创建房间"，另一个输入邀请码加入即可联调。

> 旧版需要"两个终端分别起 Worker 和静态服务"，v2 的 wrangler dev 直接托管前端，无需第二个终端（localhost:3000 的旧方式也仍可用）。
> `getDisplayMedia`（屏幕共享）与 WebRTC 需要安全上下文：`localhost` 与生产 HTTPS 均满足。

### 免费部署（Cloudflare）

```bash
npx wrangler login   # 浏览器授权（免费账号即可）
npm run deploy       # → https://p2p-cinema-api.<你的子域>.workers.dev
```

无需创建 KV / D1 / 任何密钥；DO（SQLite 类）与静态资产均在 Workers 免费计划内，首次部署自动执行 DO 迁移。

自动部署（可选）：GitHub 仓库 Secrets 配置 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`，推送到 `main` 即自动测试并部署（见 [DEPLOYMENT.md](DEPLOYMENT.md)）。

### 测试

```bash
npm test
```

## 成本

| 资源 | 免费额度 | 预估用量 |
|------|---------|---------|
| Workers 请求 | 100K/天 | 页面 + REST + WS 升级，量级极小 |
| DO 请求 | 100K/天 | 信令消息（每对端握手约 30 条） |
| DO CPU 时长 | 13,000 GB-s/天 | 信令微秒级；WS 空闲走 hibernation 不计 |
| DO SQLite 存储 | 5 GB | 每房间 < 1 KB，空房 1 小时自动回收 |
| 静态资产 | 免费 | 前端几个文件 |
| 媒体流量 | **不限（不走 CF）** | P2P 直连；TURN 中继仅打洞失败时兜底 |
| **总计** | | **0 元/月** |

## 已知限制

- **中国大陆**：`*.workers.dev` 时通时断，建议绑定自有域名（Cloudflare 免费托管 DNS + Worker Custom Domains）；Google STUN 不可达已由 Cloudflare/小米 STUN 覆盖。
- **星型拓扑**：仅房主发起连接，多人观看时房主上行带宽是瓶颈；观看者之间聊天经房主 DataChannel 转发。
- **免费 TURN（Open Relay）为演示级公共服务**：不保证 SLA；生产建议自建 coturn 或用 Cloudflare Calls TURN。

## 项目结构

```
p2p-cinema/
├── frontend/               # 前端（Worker 静态资产同域部署）
│   ├── index.html          # 单页应用
│   ├── css/style.css       # 样式
│   └── js/
│       ├── app.js          # 主入口
│       ├── room.js         # 房间 REST 客户端
│       ├── signal.js       # WebSocket 信令客户端（队列 + 指数退避重连）
│       ├── webrtc.js       # WebRTC 封装（候选缓冲/glare 回滚/ICE restart）
│       └── sync.js         # 同步播放控制
├── worker/                 # 后端（Cloudflare Worker + Durable Object）
│   ├── wrangler.toml       # DO 绑定与迁移（SQLite 类，免费计划兼容）
│   └── src/index.js        # 路由 + RoomSignalDO（房间状态机 + WS 信令交换）
├── test/                   # vitest 单测（DO 为纯 mock，无需 workers 运行时）
├── .github/workflows/      # CI/CD（测试 + 部署）
├── README.md               # 本文档
└── DEPLOYMENT.md           # 部署指南 + API 文档
```

## 文档

- [DEPLOYMENT.md](DEPLOYMENT.md) — 完整部署指南（含 API 文档、故障排查、架构说明）
