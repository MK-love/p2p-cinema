// frontend/js/signal.js — 信令客户端（HTTP 轮询）

const POLL_INTERVAL = 500
const POLL_TIMEOUT = 30000

export class SignalClient {
  constructor(apiBase, roomCode, peerId) {
    this.apiBase = apiBase
    this.roomCode = roomCode
    this.peerId = peerId
    this.lastTs = 0
    this.running = false
    this.timerId = null
    this.startTime = 0
    this.messageCallbacks = []
    this.timeoutCallbacks = []
  }

  onMessage(callback) {
    this.messageCallbacks.push(callback)
  }

  onTimeout(callback) {
    this.timeoutCallbacks.push(callback)
  }

  async send(to, type, data) {
    await fetch(`${this.apiBase}/api/signal/${this.roomCode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.peerId, to, type, data })
    })
  }

  start() {
    this.running = true
    this.startTime = Date.now()
    this.poll()
  }

  stop() {
    this.running = false
    if (this.timerId) {
      clearTimeout(this.timerId)
      this.timerId = null
    }
  }

  async poll() {
    if (!this.running) return

    if (Date.now() - this.startTime > POLL_TIMEOUT) {
      this.timeoutCallbacks.forEach(cb => cb())
      this.stop()
      return
    }

    try {
      const res = await fetch(`${this.apiBase}/api/signal/${this.roomCode}?since=${this.lastTs}`)
      if (res.ok) {
        const { messages } = await res.json()
        for (const msg of messages) {
          if (msg.to === this.peerId) {
            this.messageCallbacks.forEach(cb => cb(msg))
          }
          if (msg.ts > this.lastTs) this.lastTs = msg.ts
        }
      }
    } catch (e) {
      // 网络错误，继续重试
    }

    if (this.running) {
      this.timerId = setTimeout(() => this.poll(), POLL_INTERVAL)
    }
  }
}
