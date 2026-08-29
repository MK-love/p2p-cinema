// test/frontend/room.test.js

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateRoomCode, RoomClient } from '../../frontend/js/room.js'

describe('generateRoomCode', () => {
  it('returns a 6-character code', () => {
    const code = generateRoomCode()
    expect(code).toHaveLength(6)
  })

  it('uses only safe characters (no 0/O/1/I/L)', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateRoomCode()
      expect(code).toMatch(/^[A-HJ-KMNP-Z2-9]{6}$/)
    }
  })

  it('generates different codes', () => {
    const codes = new Set()
    for (let i = 0; i < 50; i++) codes.add(generateRoomCode())
    expect(codes.size).toBeGreaterThan(40)
  })
})

describe('RoomClient', () => {
  const mockFetch = vi.fn()
  global.fetch = mockFetch
  const client = new RoomClient('http://localhost:8787')

  beforeEach(() => { mockFetch.mockReset() })

  it('createRoom calls POST /api/room', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ roomCode: 'ABC234', peerId: 'host-123' })
    })
    const result = await client.createRoom('host-123')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8787/api/room',
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.roomCode).toBe('ABC234')
  })

  it('joinRoom calls GET /api/room/:code', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ hostId: 'host-123', participants: ['host-123'] })
    })
    const result = await client.joinRoom('ABC234')
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8787/api/room/ABC234')
    expect(result.hostId).toBe('host-123')
  })

  it('joinRoom throws on invalid code', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Room not found' })
    })
    await expect(client.joinRoom('INVALID')).rejects.toThrow('Room not found')
  })

  it('leaveRoom calls DELETE /api/room/:code', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    })
    await client.leaveRoom('ABC234', 'host-123')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8787/api/room/ABC234',
      expect.objectContaining({ method: 'DELETE' })
    )
  })
})
