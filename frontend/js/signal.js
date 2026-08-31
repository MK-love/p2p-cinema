// frontend/js/signal.js — 信令客户端（WebSocket，v2）
//
// v1 为 KV HTTP 轮询（500ms 一次 GET，按毫秒时间戳游标增量拉取）；v2 升级为
// Durable Object WebSocket 推送：消息即时到达，无轮询游标 —— 从根上消除
// 同毫秒/时钟回拨导致的丢消息问题（v1 "同房间互看不到对方"的根因）。
//
// 可靠性设计：
//  - 连接建立前 send() 的消息进入队列，open 后统一 flush
//  - join 广播由服务端在连接建立时自动发出（客户端无需补发）
//  - 意外断连自动指数退避重连；从未成功连上且重试 3 次仍失败 → 判定房间
//    不存在/已过期，触发 onTimeout；会话中掉线则持续重连（配合服务端
//    join 自动广播实现握手自愈）

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 5000
const MAX_INITIAL_ATTEMPTS = 3

export class SignalClient {
  constructor(apiBase, roomCode, peerId) {
    this.wsBase = apiBase.replace(/^http/, 'ws')
    this.roomCode = roomCode
    this.peerId = peerId
    this.ws = null
    this.queue = []
    this.stopped = false
    this.initialAttempts = 0
    this.everConnected = false
    this.reconnectTimer = null
    this.backoffMs = RECONNECT_BASE_MS
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

  // 连接未就绪时入队，open 后统一 flush；发送异常经 onError 上报
  send(to, type, data) {
    const payload = JSON.stringify({ from: this.peerId, to, type, data })
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(payload)
      } catch (e) {
        this.errorCallbacks.forEach(cb => cb(e))
      }
    } else {
      this.queue.push(payload)
    }
  }

  start() {
    if (this.ws) return
    this.stopped = false
    this.connect()
  }

  // I10: 对外恢复入口 — WS 存活时为 no-op，已断开且未被手动停止时立即重连
  reset() {
    if (!this.ws && !this.stopped) {
      this.connect()
    }
  }

  // I2: 停止时清空回调，防止重复注册
  stop() {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      try {
        ws.close(1000)
      } catch {}
    }
    this.messageCallbacks = []
    this.timeoutCallbacks = []
    this.errorCallbacks = []
  }

  connect() {
    if (this.stopped) return
    const url = `${this.wsBase}/api/signal/${this.roomCode}?peerId=${encodeURIComponent(this.peerId)}`
    let ws
    try {
      ws = new WebSocket(url)
    } catch (e) {
      this.errorCallbacks.forEach(cb => cb(e))
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.everConnected = true
      this.initialAttempts = 0
      this.backoffMs = RECONNECT_BASE_MS
      const pending = this.queue.splice(0)
      for (const payload of pending) {
        try {
          ws.send(payload)
        } catch {}
      }
    }

    ws.onmessage = (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return // 忽略无法解析的帧
      }
      if (!msg || typeof msg.type !== 'string') return
      if (msg.to === this.peerId) {
        this.messageCallbacks.forEach(cb => cb(msg))
      }
    }

    ws.onclose = () => {
      if (this.ws !== ws) return // 已被 stop() 或新连接取代
      this.ws = null
      if (this.stopped) return

      if (!this.everConnected) {
        this.initialAttempts++
        if (this.initialAttempts >= MAX_INITIAL_ATTEMPTS) {
          // 从未连上：房间不存在或已过期 — 信令通道随房间生命周期结束
          this.timeoutCallbacks.forEach(cb => cb())
          this.stop()
          return
        }
      }
      this.scheduleReconnect()
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS)
  }
}
