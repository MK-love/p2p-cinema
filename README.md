# P2P Cinema

P2P 在线观影网站，部署在 Cloudflare 免费层，零成本运行。

## 功能

- 创建私人房间 + 6 位邀请码邀请
- 昵称系统（自定义或自动生成）
- 屏幕共享观影（WebRTC P2P，画质清晰不掉帧）
- URL 直链同步播放（DataChannel 同步控制）
- 实时聊天 + 参与者列表（侧栏标签页）
- 房主解散房间 / 加入者退出房间
- 视频工具栏：全屏、画中画、缩放模式、播放/暂停
- 音量控制（滑块 + 静音切换）

## 技术栈

- **前端**：纯 HTML/CSS/JS (ES modules)，无框架，部署在 Cloudflare Pages
- **后端**：Cloudflare Workers + KV，HTTP 轮询信令
- **通信**：WebRTC P2P mesh + DataChannel
- **部署**：GitHub Actions 自动部署到 Cloudflare

## 快速开始

### 本地开发

```bash
# 安装依赖
npm install

# 终端 1：启动 Worker（端口 8787）
npm run dev:worker

# 终端 2：启动前端静态服务（端口 3000）
cd frontend && npx serve -l 3000

# 运行测试
npm test
```

打开 `http://localhost:3000` 即可使用。

### 部署

完整的部署步骤请参考 [DEPLOYMENT.md](DEPLOYMENT.md)。

快速概要：

1. 创建 Cloudflare KV Namespace（`p2p-cinema-rooms` + `p2p-cinema-signals`）
2. 将 KV ID 填入 [worker/wrangler.toml](worker/wrangler.toml)
3. 将 [frontend/js/app.js](frontend/js/app.js) 第 11 行的 Worker 地址替换为你的实际地址
4. 在 GitHub 仓库 Secrets 中配置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`
5. 推送到 `main` 分支，GitHub Actions 自动部署

## 成本

| 资源 | 免费额度 | 预估用量 |
|------|---------|---------|
| Cloudflare Pages | 无限请求 | 低 |
| Cloudflare Workers | 100K 请求/天 | ~1K |
| KV 读取 | 100K/天 | ~1.5K |
| KV 写入 | 1K/天 | ~750 |
| STUN 服务器 | 免费 | - |
| **总计** | | **0 元/月** |

## 项目结构

```
p2p-cinema/
├── frontend/               # 前端（Cloudflare Pages）
│   ├── index.html          # 单页应用
│   ├── css/style.css       # 样式
│   └── js/
│       ├── app.js          # 主入口
│       ├── room.js         # 房间管理
│       ├── signal.js       # 信令客户端
│       ├── webrtc.js       # WebRTC 封装
│       └── sync.js         # 同步播放控制
├── worker/                 # 后端（Cloudflare Worker）
│   ├── wrangler.toml       # 配置
│   └── src/index.js        # 信令 API
├── test/                   # 测试（27 个）
├── .github/workflows/      # CI/CD
├── DEPLOYMENT.md           # 部署文档
└── README.md               # 本文档
```

## 文档

- [DEPLOYMENT.md](DEPLOYMENT.md) — 完整部署指南（含 API 文档、故障排查、架构说明）
