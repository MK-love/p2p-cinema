// frontend/js/room.js — 房间管理模块

const SAFE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateRoomCode() {
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += SAFE_CHARS[Math.floor(Math.random() * SAFE_CHARS.length)]
  }
  return code
}

export class RoomClient {
  constructor(apiBase) {
    this.apiBase = apiBase
  }

  async createRoom(peerId) {
    const res = await fetch(`${this.apiBase}/api/room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId })
    })
    if (!res.ok) throw new Error('Failed to create room')
    return res.json()
  }

  async joinRoom(roomCode) {
    const res = await fetch(`${this.apiBase}/api/room/${roomCode}`)
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error || 'Failed to join room')
    }
    return res.json()
  }

  async leaveRoom(roomCode, peerId) {
    const res = await fetch(`${this.apiBase}/api/room/${roomCode}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId })
    })
    if (!res.ok) throw new Error('Failed to leave room')
    return res.json()
  }
}
