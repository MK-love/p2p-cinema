// test/frontend/signal.test.js — SignalClient 轮询生命周期测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SignalClient } from '../../frontend/js/signal.js'

describe('SignalClient 轮询生命周期', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('超过30秒后轮询仍继续（不因超时停摆）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new SignalClient('http://test', 'ABC234', 'peer-1')
    client.start()

    await vi.advanceTimersByTimeAsync(30000)
    const callsAt30s = fetchMock.mock.calls.length
    expect(callsAt30s).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAt30s)
  })

  it('房间不存在(404)时触发超时回调并停止轮询', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({})
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new SignalClient('http://test', 'ABC234', 'peer-1')
    const onTimeout = vi.fn()
    client.onTimeout(onTimeout)
    client.start()

    await vi.advanceTimersByTimeAsync(1000)
    expect(onTimeout).toHaveBeenCalledTimes(1)

    const callsAfter404 = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock.mock.calls.length).toBe(callsAfter404)
  })

  it('只分发给目标为自身 peer 的消息', async () => {
    const mine = { from: 'other', to: 'peer-1', type: 'offer', data: '{}', ts: 123 }
    const others = { from: 'other', to: 'peer-2', type: 'ice', data: '{}', ts: 124 }
    // 模拟服务端 since 过滤：只返回 ts > since 的新消息
    const fetchMock = vi.fn().mockImplementation((url) => {
      const since = Number(new URL(url).searchParams.get('since') || 0)
      const messages = since === 0 ? [mine, others] : []
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ messages }) })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new SignalClient('http://test', 'ABC234', 'peer-1')
    const onMessage = vi.fn()
    client.onMessage(onMessage)
    client.start()

    await vi.advanceTimersByTimeAsync(600)

    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith(mine)
  })
})
