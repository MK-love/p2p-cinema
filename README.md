# P2P Cinema

P2P 在线观影网站，部署在 Cloudflare 免费层，零成本运行。

## 功能

- 创建私人房间 + 6 位邀请码
- 屏幕共享观影（WebRTC P2P）
- URL 直链同步播放（DataChannel 同步控制）
- 实时聊天

## 技术栈

- 前端：纯 HTML/CSS/JS (ES modules)，无框架
- 后端：Cloudflare Workers + KV
- 部署：Cloudflare Pages + GitHub Actions

## 本地开发

```bash
# 安装依赖
npm install

# 启动 Worker（终端 1）
npm run dev:worker

# 启动前端静态服务（终端 2）
cd frontend && npx serve -l 3000

# 运行测试
npm test
```

打开 `http://localhost:3000` 即可使用。

## 部署

### 前端 (Cloudflare Pages)

1. 在 Cloudflare Dashboard 创建 Pages 项目
2. 连接 GitHub 仓库
3. 构建输出目录: `frontend`
4. 部署后获得 `https://p2p-cinema.pages.dev`

### Worker (Cloudflare Workers)

1. 在 Cloudflare Dashboard 创建 KV Namespace:
   - `p2p-cinema-rooms`
   - `p2p-cinema-signals`
2. 将 KV ID 填入 `worker/wrangler.toml`
3. GitHub Actions 自动部署（需配置 Secrets）

### GitHub Secrets

在仓库 Settings -> Secrets and variables -> Actions 中添加：

- `CLOUDFLARE_API_TOKEN` - Cloudflare API Token（需 Workers 和 Pages 权限）
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare Account ID

### 配置 API 地址

在前端 `js/app.js` 中，将生产环境的 Worker 地址替换为你的实际地址：

```javascript
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://p2p-cinema-api.<your-account>.workers.dev'
```

## 成本

| 资源 | 免费额度 | 预估用量 |
|------|---------|---------|
| Pages | 无限请求 | 低 |
| Workers | 100K 请求/天 | ~1K |
| KV 读取 | 100K/天 | ~1.5K |
| KV 写入 | 1K/天 | ~750 |
| **总计** | | **0 元/月** |
