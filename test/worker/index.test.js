// test/worker/index.test.js — v2（Durable Object + WebSocket）架构测试
//
// 通过 mock DurableObjectState / Namespace 直接实例化 DO 类，
// 在纯 Node 环境覆盖 REST 路由与 WebSocket Hibernation 处理器逻辑
// （/ws 升级路径依赖 workerd 的 WebSocketPair 全局，仅在 wrangler dev 验证）。

import { describe, it, expect, beforeEach } from 'vitest'
import worker, { RoomSignalDO } from '../../worker/src/index.js'

// --- mock Durable Object 基础设施 ---

function createDOState() {
  const data = new Map()
  const accepted = []
  let alarmTime = null
  return {
    storage: {
      get: async (k) => (data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null),
      put: async (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))) },
      delete: async (k) => { data.delete(k) },
      deleteAll: async () => { data.clear() },
      setAlarm: async (t) => { alarmTime = t },
      getAlarm: async () => alarmTime
    },
    acceptWebSocket: (ws) => { accepted.push(ws) },
    getWebSockets: () => accepted.filter((ws) => !ws.closed),
    _data: data,
    _accepted: accepted,
    _alarm: () => alarmTime
  }
}

// 模拟经 hibernation 重入的 WebSocket：attachment 携带 peerId 身份
function makeSocket(peerId) {
  return {
    peerId,
    closed: false,
    sent: [],
    _att: null,
    serializeAttachment(value) { this._att = value },
    deserializeAttachment() { return this._att ?? { peerId: this.peerId } },
    send(data) { this.sent.push(data) },
    close() { this.closed = true }
  }
}

function createEnv() {
  const instances = new Map()
  return {
    ROOMS: {
      idFromName: (name) => ({ name }),
      // 真实 stub 支持 fetch(url, init) 签名；DO 实例只吃 Request —— 包一层适配
      get: (id) => {
        if (!instances.has(id.name)) {
          instances.set(id.name, new RoomSignalDO(createDOState(), {}))
        }
        const doInstance = instances.get(id.name)
        return {
          fetch: (input, init) =>
            doInstance.fetch(typeof input === 'string' ? new Request(input, init) : input)
        }
      },
      _instances: instances
    }
  }
}

function jsonRequest(method, path, body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
}

describe('Worker REST API', () => {
  let env
  beforeEach(() => { env = createEnv() })

  describe('CORS', () => {
    it('returns CORS headers on OPTIONS', async () => {
      const res = await worker.fetch(new Request('http://localhost/api/room', { method: 'OPTIONS' }), env)
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('returns CORS headers on all responses', async () => {
      const res = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })
  })

  describe('POST /api/room', () => {
    it('creates a room and returns roomCode + peerId', async () => {
      const res = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.roomCode).toHaveLength(6)
      expect(data.peerId).toBe('host-123')
    })

    it('returns 400 for missing peerId', async () => {
      const res = await worker.fetch(jsonRequest('POST', '/api/room', {}), env)
      expect(res.status).toBe(400)
    })

    it('returns 400 for empty peerId', async () => {
      const res = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: '' }), env)
      expect(res.status).toBe(400)
    })

    it('fails with 503 when all room code collision retries are exhausted, without overwriting existing rooms', async () => {
      // 模拟房间码恒碰撞：DO 恒返回 409
      let createAttempts = 0
      env.ROOMS.get = () => ({
        fetch: async () => {
          createAttempts++
          return new Response(JSON.stringify({ error: 'Room code collision' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' }
          })
        }
      })
      const res = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      expect(res.status).toBe(503)
      // 关键断言：换码重试 5 次后放弃，绝不覆盖已有房间
      expect(createAttempts).toBe(5)
    })
  })

  describe('GET /api/room/:code', () => {
    it('returns room info for valid code', async () => {
      const createRes = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      const { roomCode } = await createRes.json()
      const res = await worker.fetch(new Request(`http://localhost/api/room/${roomCode}`), env)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.hostId).toBe('host-123')
    })

    it('returns 404 for invalid code', async () => {
      const res = await worker.fetch(new Request('http://localhost/api/room/INVALID'), env)
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/room/:code', () => {
    it('deletes the room when host requests', async () => {
      const createRes = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      const { roomCode } = await createRes.json()
      const res = await worker.fetch(jsonRequest('DELETE', `/api/room/${roomCode}`, { peerId: 'host-123' }), env)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
      const getRes = await worker.fetch(new Request(`http://localhost/api/room/${roomCode}`), env)
      expect(getRes.status).toBe(404)
    })

    it('returns 403 when non-host tries to delete', async () => {
      const createRes = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      const { roomCode } = await createRes.json()
      const res = await worker.fetch(jsonRequest('DELETE', `/api/room/${roomCode}`, { peerId: 'guest-456' }), env)
      expect(res.status).toBe(403)
      // 验证房间仍然存在
      const getRes = await worker.fetch(new Request(`http://localhost/api/room/${roomCode}`), env)
      expect(getRes.status).toBe(200)
    })

    it('returns 404 for non-existent room', async () => {
      const res = await worker.fetch(jsonRequest('DELETE', '/api/room/INVALID', { peerId: 'host-123' }), env)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/turn — 动态 TURN 凭据', () => {
    it('未配置 TURN 密钥时返回 enabled:false（前端回退静态 ICE）', async () => {
      const res = await worker.fetch(new Request('http://localhost/api/turn'), env)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.enabled).toBe(false)
    })

    it('未配置时无需访问外部 API 即可快速响应', async () => {
      // env 中无任何 TURN 密钥 —— 不应抛错
      const res = await worker.fetch(new Request('http://localhost/api/turn'), env)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })
  })
})

describe('RoomSignalDO（单房间状态机）', () => {
  it('/create 同码房间返回 409（碰撞由上层换码重试）', async () => {
    const state = createDOState()
    const roomDO = new RoomSignalDO(state, {})
    const req = (code) => new Request(`https://do/create?code=${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'host-1' })
    })
    const first = await roomDO.fetch(req('ABC234'))
    const second = await roomDO.fetch(req('ABC234'))
    expect(first.status).toBe(201)
    expect(second.status).toBe(409)
  })

  it('解散房间：广播 room-dissolved、关闭连接、清空存储', async () => {
    const state = createDOState()
    const roomDO = new RoomSignalDO(state, {})
    await roomDO.fetch(new Request('https://do/create?code=ABC234', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'host-1' })
    }))
    const host = makeSocket('host-1')
    const guest = makeSocket('guest-2')
    host.serializeAttachment({ peerId: 'host-1' })
    guest.serializeAttachment({ peerId: 'guest-2' })
    state.acceptWebSocket(host)
    state.acceptWebSocket(guest)

    const res = await roomDO.fetch(new Request('https://do/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'host-1' })
    }))
    expect(res.status).toBe(200)
    expect(host.closed).toBe(true)
    expect(guest.closed).toBe(true)
    const notified = guest.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'room-dissolved')
    expect(notified).toBeTruthy()
    expect(notified.to).toBe('guest-2')
    expect(state._data.size).toBe(0)
  })

  it('webSocketMessage：按 to 精确转发，不回发给发送者', async () => {
    const state = createDOState()
    const roomDO = new RoomSignalDO(state, {})
    const a = makeSocket('A')
    const b = makeSocket('B')
    const c = makeSocket('C')
    state.acceptWebSocket(a)
    state.acceptWebSocket(b)
    state.acceptWebSocket(c)

    await roomDO.webSocketMessage(a, JSON.stringify({ from: 'A', to: 'B', type: 'offer', data: 'sdp' }))
    expect(b.sent).toHaveLength(1)
    expect(JSON.parse(b.sent[0])).toMatchObject({ from: 'A', to: 'B', type: 'offer', data: 'sdp' })
    expect(a.sent).toHaveLength(0)
    expect(c.sent).toHaveLength(0)
  })

  it('webSocketMessage：to "*" 广播给所有其他人（逐目标填真实 to，客户端可按 peerId 过滤）', async () => {
    const state = createDOState()
    const roomDO = new RoomSignalDO(state, {})
    const a = makeSocket('A')
    const b = makeSocket('B')
    const c = makeSocket('C')
    state.acceptWebSocket(a)
    state.acceptWebSocket(b)
    state.acceptWebSocket(c)

    await roomDO.webSocketMessage(a, JSON.stringify({ from: 'A', to: '*', type: 'chat', data: 'hi' }))
    expect(a.sent).toHaveLength(0)
    expect(b.sent).toHaveLength(1)
    expect(c.sent).toHaveLength(1)
    // 广播逐目标填 to，收到方无须识别 '*' 即可按「to===自身」过滤
    expect(JSON.parse(b.sent[0]).to).toBe('B')
    expect(JSON.parse(c.sent[0]).to).toBe('C')
  })

  it('webSocketMessage：忽略无法解析的帧与非法消息', async () => {
    const state = createDOState()
    const roomDO = new RoomSignalDO(state, {})
    const b = makeSocket('B')
    state.acceptWebSocket(b)

    await expect(roomDO.webSocketMessage(b, 'not-json{{{')).resolves.toBeUndefined()
    await expect(roomDO.webSocketMessage(b, JSON.stringify({ nonsense: true }))).resolves.toBeUndefined()
    expect(b.sent).toHaveLength(0)
  })

  it('webSocketClose：向其他人广播 peer-left（from 为断开者）', async () => {
    const state = createDOState()
    const roomDO = new RoomSignalDO(state, {})
    const host = makeSocket('host-1')
    const guest = makeSocket('guest-2')
    state.acceptWebSocket(host)
    state.acceptWebSocket(guest)

    guest.closed = true // 模拟连接关闭
    await roomDO.webSocketClose(guest)

    expect(host.sent).toHaveLength(1)
    const msg = JSON.parse(host.sent[0])
    expect(msg).toMatchObject({ from: 'guest-2', to: 'host-1', type: 'peer-left' })
  })

  it('alarm：无存活连接时清空房间（TTL 过期回收）', async () => {
    const state = createDOState()
    const roomDO = new RoomSignalDO(state, {})
    state.storage.put('room', { hostId: 'host-1', createdAt: Date.now(), participants: ['host-1'] })
    await roomDO.alarm()
    expect(state._data.size).toBe(0)
  })

  it('alarm：仍有观众在线时续期而非清理', async () => {
    const state = createDOState()
    const roomDO = new RoomSignalDO(state, {})
    state.storage.put('room', { hostId: 'host-1', createdAt: Date.now(), participants: ['host-1'] })
    state.acceptWebSocket(makeSocket('guest-2'))
    await roomDO.alarm()
    expect(state._data.size).toBe(1)
    // alarm 被重设为未来时间戳（续期），而非保持 null
    expect(state._alarm()).toBeGreaterThan(Date.now() - 1000)
  })
})
