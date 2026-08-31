// worker/src/index.js — Cloudflare Worker + Durable Object 信令服务（v2，WebSocket）
//
// v2 架构（全免费套餐）：
//  - 房间状态与信令全部收敛进单个 Durable Object（SQLite 存储，免费套餐可用）
//  - 信令从 KV HTTP 轮询升级为 WebSocket 推送：DO 天然串行化（强一致，
//    无并发丢更新）、消息即时到达（无 500ms 轮询间隔）、零 KV 配额消耗
//  - KV 完全移除：部署不再需要手工创建 KV namespace 并回填 id（零配置）
//
// v1 → v2 动机：KV 是最终一致存储，跨节点传播可达 60s；"读-改-写"追加消息
// 存在并发丢更新；毫秒时间戳游标在同毫秒/时钟回拨时会永久丢消息（曾导致
// "同房间互看不到对方"）。DO 每房间单实例串行处理，从根上消除这类竞态。
//
// 对外 API（与 v1 兼容）：
//  POST   /api/room            创建房间 → { roomCode, peerId } 201
//  GET    /api/room/:code      查询房间 → { hostId, participants }
//  DELETE /api/room/:code      解散房间（仅房主）
//  GET    /api/signal/:code?peerId=...   WebSocket 升级（信令通道）
//
// WebSocket 消息格式（客户端 → 服务端）：{ from, to, type, data }
// 服务端按 to 精确转发（to: '*' 广播给其他人）；连接建立/断开时服务端自动
// 广播 join / peer-left，房主据此发起或回收 WebRTC 连接（断线自愈）。

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

const ROOM_TTL_MS = 60 * 60 * 1000 // 空房间 1 小时后由 alarm 清理
const CREATE_RETRIES = 5 // 房间码碰撞换码重试次数

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  })
}

function withCors(res) {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
  return new Response(res.body, { status: res.status, headers })
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

function validatePeerId(peerId) {
  return typeof peerId === 'string' && peerId.length > 0 && peerId.length <= 100
}

function serializeSignal(from, to, type, data) {
  return JSON.stringify({ from, to, type, data })
}

// ---------------------------------------------------------------------------
// Durable Object：单房间状态机（房间元数据 + WebSocket 信令交换）
// ---------------------------------------------------------------------------

export class RoomSignalDO {
  constructor(state, env) {
    this.state = state
    this.env = env
  }

  // WebSocket 休眠后重入时从 attachment 恢复该连接的 peerId
  #peerIdOf(ws) {
    try {
      const att = ws.deserializeAttachment?.()
      return att?.peerId ?? null
    } catch {
      return null
    }
  }

  async #room() {
    return this.state.storage.get('room')
  }

  async fetch(request) {
    const url = new URL(request.url)

    // WebSocket 升级以 Upgrade 头为准（Worker 原样透传，pathname 保持
    // /api/signal/:code；不依赖假路径 /ws，避免重写 URL 时丢弃握手头）
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      const peerId = url.searchParams.get('peerId') || ''
      if (!validatePeerId(peerId)) {
        return jsonResponse({ error: 'Invalid peerId' }, 400)
      }
      const room = await this.#room()
      if (!room) return jsonResponse({ error: 'Room not found or expired' }, 404)

      const pair = new WebSocketPair()
      const [client, server] = [pair[0], pair[1]]
      try {
        server.serializeAttachment?.({ peerId })
      } catch {}
      // Hibernation API：空闲期不占 CPU 时长（免费额度友好）
      this.state.acceptWebSocket(server)
      await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS)

      // 自动广播 join：房主收到后主动发起 WebRTC 连接；
      // 对端断线重连时同样触发 → 握手自愈（无需客户端补发 join）
      for (const other of this.state.getWebSockets()) {
        if (other === server) continue
        const to = this.#peerIdOf(other)
        if (!to) continue
        try {
          other.send(serializeSignal(peerId, to, 'join', peerId))
        } catch {}
      }
      // 101 是 null-body 状态：WebSocket 经 webSocket 选项携带（传 client 端；
      // server 端已 acceptWebSocket 交给休眠管理）。response 构造只接受 200-599，
      // 必须给出 webSocket 才能产出真正的 101 握手响应。
      return new Response(null, { status: 101, webSocket: client })
    }

    // 以下为部署时 Worker 内置转发的 REST 端点（无 Upgrade 头）

    // POST /create?code=XXX {peerId} — 创建房间；同码已存在 → 409 供上层换码重试
    if (url.pathname === '/create' && request.method === 'POST') {
      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400)
      }
      if (!validatePeerId(body.peerId)) {
        return jsonResponse({ error: 'Invalid peerId' }, 400)
      }
      if (await this.#room()) {
        return jsonResponse({ error: 'Room code collision' }, 409)
      }
      const room = {
        hostId: body.peerId,
        createdAt: Date.now(),
        participants: [body.peerId]
      }
      await this.state.storage.put('room', room)
      await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS)
      const roomCode = url.searchParams.get('code') || ''
      return jsonResponse({ roomCode, peerId: body.peerId }, 201)
    }

    // GET /info — 房间信息
    if (url.pathname === '/info' && request.method === 'GET') {
      const room = await this.#room()
      if (!room) return jsonResponse({ error: 'Room not found or expired' }, 404)
      return jsonResponse({ hostId: room.hostId, participants: room.participants })
    }

    // POST /delete {peerId} — 解散房间（仅房主）：通知所有人 → 关闭连接 → 清空存储
    if (url.pathname === '/delete' && request.method === 'POST') {
      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400)
      }
      const room = await this.#room()
      if (!room) return jsonResponse({ error: 'Room not found or expired' }, 404)
      if (!validatePeerId(body?.peerId) || body.peerId !== room.hostId) {
        return jsonResponse({ error: 'Only host can delete room' }, 403)
      }
      for (const ws of this.state.getWebSockets()) {
        const to = this.#peerIdOf(ws)
        if (!to) continue
        try {
          ws.send(serializeSignal(room.hostId, to, 'room-dissolved', null))
        } catch {}
      }
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.close(1000, 'room dissolved')
        } catch {}
      }
      await this.state.storage.deleteAll()
      return jsonResponse({ ok: true })
    }

    return jsonResponse({ error: 'Not found' }, 404)
  }

  // --- WebSocket Hibernation 处理器 ---

  async webSocketMessage(ws, message) {
    let msg
    try {
      msg = JSON.parse(message)
    } catch {
      return // 忽略无法解析的帧
    }
    if (!msg || typeof msg.to !== 'string' || typeof msg.type !== 'string' || msg.type.length === 0) {
      return
    }
    const from = this.#peerIdOf(ws) ?? (typeof msg.from === 'string' ? msg.from : '')
    if (!from) return
    await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS)

    const isBroadcast = msg.to === '*'
    for (const target of this.state.getWebSockets()) {
      if (target === ws) continue
      const targetId = this.#peerIdOf(target)
      if (!targetId) continue
      if (!isBroadcast && targetId !== msg.to) continue
      // 广播时逐目标填入真实 to，客户端按「msg.to === 自身 peerId」过滤即可通用
      const payload = serializeSignal(from, isBroadcast ? targetId : msg.to, msg.type, msg.data ?? null)
      try {
        target.send(payload)
      } catch {}
    }
  }

  async webSocketClose(ws) {
    const from = this.#peerIdOf(ws)
    if (!from) return
    // 即时广播 peer-left：比 DataChannel 通知与重连超时更快，房主可秒级移除成员
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue
      const to = this.#peerIdOf(other)
      if (!to) continue
      try {
        other.send(serializeSignal(from, to, 'peer-left', from))
      } catch {}
    }
  }

  async alarm() {
    // 空房间（无存活连接）到期清理；仍有观众在线则续期
    if (this.state.getWebSockets().length > 0) {
      await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS)
    } else {
      await this.state.storage.deleteAll()
    }
  }
}

// ---------------------------------------------------------------------------
// Worker 路由：/api/* → 转发到以房间码命名的 Durable Object
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)

    if (parts[0] !== 'api') {
      return jsonResponse({ error: 'Not found' }, 404)
    }

    // POST /api/room — 创建房间（碰撞换码重试，全部碰撞 → 503，绝不覆盖已有房间）
    if (parts[1] === 'room' && !parts[2] && request.method === 'POST') {
      const bodyText = await request.text() // body 只能读一次，重试复用文本
      for (let i = 0; i < CREATE_RETRIES; i++) {
        const code = generateRoomCode()
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code))
        const res = await stub.fetch(`https://do/create?code=${code}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyText
        })
        if (res.status !== 409) return withCors(res) // 201 或 400 直接透传
      }
      return jsonResponse({ error: 'Room code collision, please retry' }, 503)
    }

    // GET /api/room/:code | DELETE /api/room/:code — 查询 / 解散
    if (parts[1] === 'room' && parts[2] && (request.method === 'GET' || request.method === 'DELETE')) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(parts[2]))
      const init =
        request.method === 'GET'
          ? { method: 'GET' }
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }
      const res = await stub.fetch(`https://do/${request.method === 'GET' ? 'info' : 'delete'}`, init)
      return withCors(res)
    }

    // GET /api/signal/:code?peerId=... — WebSocket 升级：原样透传 request
    // （保留 Upgrade 握手头；DO 以 Upgrade 头路由，不再重写 URL）
    if (parts[1] === 'signal' && parts[2] && request.method === 'GET') {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(parts[2]))
      return stub.fetch(request)
    }

    return jsonResponse({ error: 'Not found' }, 404)
  }
}
