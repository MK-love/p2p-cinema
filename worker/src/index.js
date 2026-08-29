// worker/src/index.js — Cloudflare Worker 信令服务

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

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

async function handleRoom(request, env, method, pathParts) {
  // POST /api/room — 创建房间
  if (method === 'POST' && pathParts[2] === 'room' && !pathParts[3]) {
    const body = await request.json()
    const roomCode = generateRoomCode()
    const room = {
      hostId: body.peerId,
      createdAt: Date.now(),
      participants: [body.peerId]
    }
    await env.ROOMS.put(roomCode, JSON.stringify(room), { expirationTtl: 3600 })
    await env.SIGNALS.put(roomCode, JSON.stringify([]), { expirationTtl: 300 })
    return jsonResponse({ roomCode, peerId: body.peerId }, 201)
  }

  // GET /api/room/:code — 查询房间
  if (method === 'GET' && pathParts[2] === 'room' && pathParts[3]) {
    const code = pathParts[3]
    const data = await env.ROOMS.get(code)
    if (!data) return jsonResponse({ error: 'Room not found or expired' }, 404)
    const room = JSON.parse(data)
    return jsonResponse({ hostId: room.hostId, participants: room.participants })
  }

  // DELETE /api/room/:code — 删除房间
  if (method === 'DELETE' && pathParts[2] === 'room' && pathParts[3]) {
    const code = pathParts[3]
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
    const body = await request.json()
    const signalsRaw = await env.SIGNALS.get(code)
    const signals = signalsRaw ? JSON.parse(signalsRaw) : []
    signals.push({
      from: body.from,
      to: body.to,
      type: body.type,
      data: body.data,
      ts: Date.now()
    })
    await env.SIGNALS.put(code, JSON.stringify(signals), { expirationTtl: 300 })
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
