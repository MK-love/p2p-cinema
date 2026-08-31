// worker/src/index.js — Cloudflare Worker 信令服务

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

const MAX_SIGNAL_MESSAGES = 100
const ROOM_TTL = 3600
const SIGNAL_TTL = 600

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  })
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

async function handleRoom(request, env, method, pathParts) {
  // pathParts = ['api', 'room', code?] — .filter(Boolean) 后无空字符串前缀
  // POST /api/room — 创建房间
  if (method === 'POST' && pathParts[1] === 'room' && !pathParts[2]) {
    const body = await request.json()
    if (!validatePeerId(body.peerId)) {
      return jsonResponse({ error: 'Invalid peerId' }, 400)
    }
    // C2: 检查房间码碰撞，最多重试 5 次；全部碰撞则失败，绝不覆盖已有房间
    let roomCode
    let collision = true
    for (let i = 0; i < 5; i++) {
      roomCode = generateRoomCode()
      const existing = await env.ROOMS.get(roomCode)
      if (!existing) { collision = false; break }
    }
    if (collision) {
      return jsonResponse({ error: 'Room code collision, please retry' }, 503)
    }
    const room = {
      hostId: body.peerId,
      createdAt: Date.now(),
      participants: [body.peerId]
    }
    await env.ROOMS.put(roomCode, JSON.stringify(room), { expirationTtl: ROOM_TTL })
    await env.SIGNALS.put(roomCode, JSON.stringify([]), { expirationTtl: SIGNAL_TTL })
    return jsonResponse({ roomCode, peerId: body.peerId }, 201)
  }

  // GET /api/room/:code — 查询房间
  if (method === 'GET' && pathParts[1] === 'room' && pathParts[2]) {
    const code = pathParts[2]
    const data = await env.ROOMS.get(code)
    if (!data) return jsonResponse({ error: 'Room not found or expired' }, 404)
    const room = JSON.parse(data)
    return jsonResponse({ hostId: room.hostId, participants: room.participants })
  }

  // DELETE /api/room/:code — 删除房间（C3: 仅房主可删除）
  if (method === 'DELETE' && pathParts[1] === 'room' && pathParts[2]) {
    const code = pathParts[2]
    const data = await env.ROOMS.get(code)
    if (!data) return jsonResponse({ error: 'Room not found or expired' }, 404)
    const room = JSON.parse(data)
    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400)
    }
    if (!validatePeerId(body.peerId)) {
      return jsonResponse({ error: 'Invalid peerId' }, 400)
    }
    if (body.peerId !== room.hostId) {
      return jsonResponse({ error: 'Only host can delete room' }, 403)
    }
    await env.ROOMS.delete(code)
    await env.SIGNALS.delete(code)
    return jsonResponse({ ok: true })
  }

  return jsonResponse({ error: 'Not found' }, 404)
}

async function handleSignal(request, env, method, code) {
  // 验证房间存在
  const roomData = await env.ROOMS.get(code)
  if (!roomData) return jsonResponse({ error: 'Room not found' }, 404)

  // POST /api/signal/:code — 发送信令消息
  if (method === 'POST') {
    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400)
    }
    // 输入校验：拒绝垃圾消息入库，避免污染轮询端
    if (!validatePeerId(body.from) || !validatePeerId(body.to) ||
        typeof body.type !== 'string' || body.type.length === 0) {
      return jsonResponse({ error: 'Invalid signal payload' }, 400)
    }
    const signalsRaw = await env.SIGNALS.get(code)
    const signals = signalsRaw ? JSON.parse(signalsRaw) : []
    signals.push({
      from: body.from,
      to: body.to,
      type: body.type,
      data: body.data,
      ts: Date.now()
    })
    // I4: 限制消息数量，防止无限增长
    if (signals.length > MAX_SIGNAL_MESSAGES) {
      signals.splice(0, signals.length - MAX_SIGNAL_MESSAGES)
    }
    await env.SIGNALS.put(code, JSON.stringify(signals), { expirationTtl: SIGNAL_TTL })
    return jsonResponse({ ok: true })
  }

  // GET /api/signal/:code?since=ts — 轮询信令消息
  if (method === 'GET') {
    const url = new URL(request.url)
    const since = parseInt(url.searchParams.get('since') || '0', 10)
    const signalsRaw = await env.SIGNALS.get(code)
    const signals = signalsRaw ? JSON.parse(signalsRaw) : []
    const messages = signals.filter(s => s.ts > since)
    return jsonResponse({ messages })
  }

  return jsonResponse({ error: 'Not found' }, 404)
}

export default {
  async fetch(request, env) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    const pathParts = url.pathname.split('/').filter(Boolean)

    // /api/room...
    if (pathParts[0] === 'api' && pathParts[1] === 'room') {
      return handleRoom(request, env, request.method, pathParts)
    }

    // /api/signal/:code
    if (pathParts[0] === 'api' && pathParts[1] === 'signal' && pathParts[2]) {
      return handleSignal(request, env, request.method, pathParts[2])
    }

    return jsonResponse({ error: 'Not found' }, 404)
  }
}
