// test/worker/index.test.js

import { describe, it, expect, beforeEach } from 'vitest'
import worker from '../../worker/src/index.js'

function createMockKV() {
  const store = new Map()
  return {
    get: async (key) => store.get(key) || null,
    put: async (key, value, options) => {
      store.set(key, value)
    },
    delete: async (key) => { store.delete(key) },
    list: async () => ({ keys: Array.from(store.keys()).map(name => ({ name })) })
  }
}

function createEnv() {
  return { ROOMS: createMockKV(), SIGNALS: createMockKV() }
}

function jsonRequest(method, path, body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
}

describe('Worker API', () => {
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
      // 模拟房间码恒碰撞：ROOMS.get 永远返回已存在的房间
      let putCount = 0
      env.ROOMS.get = async () => JSON.stringify({ hostId: 'someone-else', participants: ['someone-else'] })
      env.ROOMS.put = async () => { putCount++ }
      const res = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      expect(res.status).toBe(503)
      // 关键断言：绝不覆盖他人房间
      expect(putCount).toBe(0)
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

  describe('POST /api/signal/:code', () => {
    it('stores a signal message', async () => {
      const createRes = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      const { roomCode } = await createRes.json()
      const res = await worker.fetch(jsonRequest('POST', `/api/signal/${roomCode}`, {
        from: 'host-123', to: 'guest-456', type: 'offer', data: 'sdp-data'
      }), env)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
    })

    it('returns 404 for non-existent room', async () => {
      const res = await worker.fetch(jsonRequest('POST', '/api/signal/INVALID', {
        from: 'a', to: 'b', type: 'offer', data: 'x'
      }), env)
      expect(res.status).toBe(404)
    })

    it('returns 400 for invalid JSON body instead of crashing with 500', async () => {
      const createRes = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      const { roomCode } = await createRes.json()
      const req = new Request(`http://localhost/api/signal/${roomCode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json{{{'
      })
      const res = await worker.fetch(req, env)
      expect(res.status).toBe(400)
    })

    it('returns 400 for empty body', async () => {
      const createRes = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      const { roomCode } = await createRes.json()
      const req = new Request(`http://localhost/api/signal/${roomCode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      const res = await worker.fetch(req, env)
      expect(res.status).toBe(400)
    })

    it('returns 400 when required fields are missing and stores nothing', async () => {
      const createRes = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      const { roomCode } = await createRes.json()
      // 缺 to / type
      const res = await worker.fetch(jsonRequest('POST', `/api/signal/${roomCode}`, {
        from: 'host-123', data: 'x'
      }), env)
      expect(res.status).toBe(400)
      // 垃圾消息不应入库
      const pollRes = await worker.fetch(new Request(`http://localhost/api/signal/${roomCode}?since=0`), env)
      const { messages } = await pollRes.json()
      expect(messages).toHaveLength(0)
    })
  })

  describe('GET /api/signal/:code', () => {
    it('returns messages since timestamp', async () => {
      const createRes = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      const { roomCode } = await createRes.json()
      await worker.fetch(jsonRequest('POST', `/api/signal/${roomCode}`, {
        from: 'host-123', to: 'guest-456', type: 'offer', data: 'sdp-data'
      }), env)
      const res = await worker.fetch(new Request(`http://localhost/api/signal/${roomCode}?since=0`), env)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.messages).toHaveLength(1)
      expect(data.messages[0].type).toBe('offer')
    })

    it('caps signal messages at 100 entries', async () => {
      const createRes = await worker.fetch(jsonRequest('POST', '/api/room', { peerId: 'host-123' }), env)
      const { roomCode } = await createRes.json()
      // 写入 110 条信令
      for (let i = 0; i < 110; i++) {
        await worker.fetch(jsonRequest('POST', `/api/signal/${roomCode}`, {
          from: 'host-123', to: 'guest-456', type: 'ice', data: `ice-${i}`
        }), env)
      }
      const res = await worker.fetch(new Request(`http://localhost/api/signal/${roomCode}?since=0`), env)
      const data = await res.json()
      expect(data.messages).toHaveLength(100)
      // 验证保留了最后 100 条
      expect(data.messages[0].data).toBe('ice-10')
      expect(data.messages[99].data).toBe('ice-109')
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
})
