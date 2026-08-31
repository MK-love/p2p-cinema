// frontend/js/signal.js — 信令客户端（HTTP 轮询）

const POLL_INTERVAL = 500

export class SignalClient {
  constructor(apiBase, roomCode, peerId) {
    this.apiBase = apiBase
    this.roomCode = roomCode
    this.peerId = peerId
    this.lastTs = 0
    this.running = false
    this.timerId = null
    this.messageCallbacks = []
    this.timeoutCallbacks = []
    this.errorCallbacks = []
  }

  onMessage(callback) {
    this.messageCallbacks.push(callback)
  }

  onTimeout(callback) {
    this.timeoutCallbacks.push(callback)
  }

  onError(callback) {
    this.errorCallbacks.push(callback)
  }

  // I1: 内部 try/catch，错误通过 onError 回调上报
  async send(to, type, data) {
    try {
      const res = await fetch(`${this.apiBase}/api/signal/${this.roomCode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.peerId, to, type, data })
      })
      if (!res.ok) {
        this.errorCallbacks.forEach(cb => cb(new Error(`Signal send failed: ${res.status}`)))
      }
    } catch (e) {
      this.errorCallbacks.forEach(cb => cb(e))
    }
  }

  start() {
    this.running = true
    this.poll()
  }

  // I10: 重连时恢复轮询
  reset() {
    this.running = true
    if (!this.timerId) {
      this.poll()
    }
  }

  // I2: 停止时清空回调，防止重复注册
  stop() {
    this.running = false
    if (this.timerId) {
      clearTimeout(this.timerId)
      this.timerId = null
    }
    this.messageCallbacks = []
    this.timeoutCallbacks = []
    this.errorCallbacks = []
  }

  async poll() {
    if (!this.running) return

    try {
      const res = await fetch(`${this.apiBase}/api/signal/${this.roomCode}?since=${this.lastTs}`)
      if (res.status === 404) {
        // 房间不存在或已过期 — 信令通道随房间生命周期结束
        this.timeoutCallbacks.forEach(cb => cb())
        this.stop()
        return
      }
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
