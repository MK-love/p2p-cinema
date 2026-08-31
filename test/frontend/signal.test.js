// test/frontend/signal.test.js — SignalClient（WebSocket）生命周期测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SignalClient } from '../../frontend/js/signal.js'

class FakeWebSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.closed = false
    FakeWebSocket.instances.push(this)
  }

  send(data) { this.sent.push(data) }

  close(code = 1000) {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    if (this.onclose) this.onclose({ code })
  }

  // --- 测试驱动 ---
  simulateOpen() {
    this.readyState = 1
    if (this.onopen) this.onopen()
  }

  simulateMessage(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) })
  }

  simulateClose(code = 1006) {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    if (this.onclose) this.onclose({ code })
  }
}

describe('SignalClient（WebSocket）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('ws 地址由 http(s) apiBase 派生并携带 peerId', () => {
    const client = new SignalClient('http://localhost:8787', 'ABC234', 'peer-1')
    client.start()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:8787/api/signal/ABC234?peerId=peer-1')
    client.stop()

    const secure = new SignalClient('https://cinema.example.com', 'ABC234', 'peer-1')
    secure.start()
    expect(FakeWebSocket.instances[1].url).toBe('wss://cinema.example.com/api/signal/ABC234?peerId=peer-1')
    secure.stop()
  })

  it('连接建立前 send 入队，open 后统一发出', () => {
    const client = new SignalClient('http://test', 'ABC234', 'peer-1')
    client.send('peer-2', 'offer', 'sdp')

    client.start()
    const ws = FakeWebSocket.instances[0]
    expect(ws.sent).toHaveLength(0) // 未 open，先入队

    ws.simulateOpen()
    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toMatchObject({ from: 'peer-1', to: 'peer-2', type: 'offer', data: 'sdp' })

    // open 后直发，不再入队
    client.send('peer-2', 'ice', 'cand')
    expect(ws.sent).toHaveLength(2)
    client.stop()
  })

  it('只分发给目标为自身 peer 的消息', () => {
    const client = new SignalClient('http://test', 'ABC234', 'peer-1')
    const onMessage = vi.fn()
    client.onMessage(onMessage)
    client.start()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    ws.simulateMessage({ from: 'peer-2', to: 'peer-1', type: 'offer', data: '{}' })
    ws.simulateMessage({ from: 'peer-2', to: 'peer-3', type: 'ice', data: '{}' })
    ws.simulateMessage({ from: 'peer-2', to: 'peer-1', type: 'peer-left', data: 'peer-2' })

    expect(onMessage).toHaveBeenCalledTimes(2)
    client.stop()
  })

  it('从未连上且重试 3 次仍失败 → 触发 onTimeout 并停止（房间不存在/已过期）', async () => {
    const client = new SignalClient('http://test', 'ABC234', 'peer-1')
    const onTimeout = vi.fn()
    client.onTimeout(onTimeout)
    client.start()

    for (let i = 0; i < 3; i++) {
      FakeWebSocket.instances[i].simulateClose(1006)
      await vi.advanceTimersByTimeAsync(1100) // 覆盖退避间隔
    }

    expect(onTimeout).toHaveBeenCalledTimes(1)
    // 停止后不再新建连接
    const count = FakeWebSocket.instances.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(FakeWebSocket.instances.length).toBe(count)
  })

  it('会话中掉线自动重连（指数退避）', async () => {
    const client = new SignalClient('http://test', 'ABC234', 'peer-1')
    client.start()
    const ws1 = FakeWebSocket.instances[0]
    ws1.simulateOpen()

    ws1.simulateClose(1006)
    await vi.advanceTimersByTimeAsync(600) // 首次退避 500ms
    expect(FakeWebSocket.instances.length).toBe(2)

    // 重连成功后再次直发
    const ws2 = FakeWebSocket.instances[1]
    ws2.simulateOpen()
    client.send('peer-2', 'answer', 'sdp')
    expect(ws2.sent).toHaveLength(1)
    client.stop()
  })

  it('stop() 后不再重连且重复 stop 幂等', async () => {
    const client = new SignalClient('http://test', 'ABC234', 'peer-1')
    client.start()
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()

    client.stop()
    client.stop()
    ws.simulateClose(1006)
    await vi.advanceTimersByTimeAsync(10000)
    expect(FakeWebSocket.instances.length).toBe(1)
  })
})
