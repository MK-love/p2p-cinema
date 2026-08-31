// test/frontend/webrtc.test.js — WebRTC 配置与屏幕共享能力测试

import { describe, it, expect, vi, afterEach } from 'vitest'
import { WebRTCClient, isScreenShareSupported, ICE_SERVERS } from '../../frontend/js/webrtc.js'

function allStunUrls() {
  return ICE_SERVERS.flatMap(s => Array.isArray(s.urls) ? s.urls : [s.urls])
}

describe('ICE 服务器配置', () => {
  it('包含国内可达的备用 STUN（不能只有 Google STUN）', () => {
    const urls = allStunUrls()
    const hasCloudflareStun = urls.some(u => u.includes('stun.cloudflare.com'))
    const hasChinaStun = urls.some(u => /miwifi|hitv|cssdns|qq\.com/.test(u))
    expect(hasCloudflareStun || hasChinaStun).toBe(true)
  })

  it('所有 STUN 地址均为合法格式', () => {
    for (const url of allStunUrls()) {
      expect(url).toMatch(/^stun:[a-z0-9.\-]+:\d+$/)
    }
  })

  it('至少保留 2 台 STUN 服务器做冗余', () => {
    expect(allStunUrls().length).toBeGreaterThanOrEqual(2)
  })
})

describe('屏幕共享能力检测', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('无 getDisplayMedia 时返回 false', () => {
    vi.stubGlobal('navigator', { mediaDevices: {} })
    expect(isScreenShareSupported()).toBe(false)
  })

  it('有 getDisplayMedia 时返回 true', () => {
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: () => {} } })
    expect(isScreenShareSupported()).toBe(true)
  })

  it('不支持的浏览器调用 startScreenShare 抛出友好错误', async () => {
    vi.stubGlobal('navigator', { mediaDevices: {} })
    const client = new WebRTCClient('peer-1', {}, true)
    await expect(client.startScreenShare()).rejects.toThrow(/不支持屏幕共享/)
  })

  it('支持的浏览器正常发起屏幕共享', async () => {
    const fakeStream = { getTracks: () => [] }
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(fakeStream) }
    })
    const client = new WebRTCClient('peer-1', {}, true)
    const stream = await client.startScreenShare()
    expect(stream).toBe(fakeStream)
  })
})

// 模拟真实 RTCPeerConnection 时序：setRemoteDescription 未完成前 addIceCandidate 必须抛错（WebRTC 规范行为）
class FakePC {
  constructor() {
    this.remoteDescription = null
    this.iceCalls = []
    this.setRemoteDelay = 20
  }
  async setRemoteDescription(desc) {
    await new Promise(r => setTimeout(r, this.setRemoteDelay))
    this.remoteDescription = desc
  }
  async createOffer() { return { type: 'offer', sdp: 'fake-offer' } }
  async createAnswer() { return { type: 'answer', sdp: 'fake-answer' } }
  async setLocalDescription() {}
  async addIceCandidate(candidate) {
    if (!this.remoteDescription) {
      throw new Error('InvalidStateError: setRemoteDescription must be called first')
    }
    this.iceCalls.push(candidate)
  }
}

describe('ICE 候选缓冲（先于 remote description 到达时不丢失）', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('同批消息 offer+ice：候选在 setRemoteDescription 完成后被应用', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('RTCPeerConnection', FakePC)
    const signalMock = { send: vi.fn().mockResolvedValue(undefined) }
    const client = new WebRTCClient('peer-1', signalMock, false)

    // 模拟 signal.js 同批消息循环：同步连续分发 offer 和 ice（async 回调均不 await）
    const p1 = client.handleOffer('peer-2', JSON.stringify({ type: 'offer', sdp: 'x' }))
    const p2 = client.handleIceCandidate('peer-2', JSON.stringify({ candidate: 'cand-1', sdpMid: '0' }))
    const p3 = client.handleIceCandidate('peer-2', JSON.stringify({ candidate: 'cand-2', sdpMid: '0' }))
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([p1, p2, p3])

    const pc = client.connections.get('peer-2')
    expect(pc.iceCalls.map(c => c.candidate)).toEqual(['cand-1', 'cand-2'])
  })

  it('候选早于任何连接创建时不崩溃', async () => {
    const client = new WebRTCClient('peer-1', {}, false)
    await expect(
      client.handleIceCandidate('peer-unknown', JSON.stringify({ candidate: 'x' }))
    ).resolves.toBeUndefined()
  })
})

// 支持 DataChannel 与连接状态模拟的 FakePC
class DataChannelFakePC {
  constructor() {
    this.remoteDescription = null
    this.iceCalls = []
    this._dataChannel = { readyState: 'open', send: () => {} }
  }
  createDataChannel() { return this._dataChannel }
  async createOffer() { return { type: 'offer', sdp: 'fake-offer' } }
  async createAnswer() { return { type: 'answer', sdp: 'fake-answer' } }
  async setLocalDescription() {}
  async setRemoteDescription(desc) { this.remoteDescription = desc }
  async addIceCandidate(c) { this.iceCalls.push(c) }
  getSenders() { return [] }
  setConnectionState(state) {
    this.connectionState = state
    if (this.onconnectionstatechange) this.onconnectionstatechange()
  }
}

describe('DataChannel 消息健壮性', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('非 JSON 消息不抛错，且后续有效消息仍被分发', () => {
    vi.stubGlobal('RTCPeerConnection', DataChannelFakePC)
    const client = new WebRTCClient('peer-1', { send: () => {} }, true)
    const received = []
    client.onDataMessage(d => received.push(d))

    client.createConnection('peer-2')
    const dc = client.connections.get('peer-2') && client.dataChannels.get('peer-2')

    expect(() => dc.onmessage({ data: 'not-json{{{' })).not.toThrow()
    dc.onmessage({ data: JSON.stringify({ type: 'chat', text: 'hi' }) })

    expect(received).toEqual([{ type: 'chat', text: 'hi' }])
  })
})

describe('对端重连失败通知（幽灵成员治理）', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('重连 3 次用尽后触发 onPeerFailed，且不再继续重试', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('RTCPeerConnection', DataChannelFakePC)
    const client = new WebRTCClient('peer-1', { send: () => Promise.resolve() }, true)
    const failedSpy = vi.fn()
    client.onPeerFailed(failedSpy)

    client.createConnection('peer-2')
    const pc = client.connections.get('peer-2')

    // 连接成功一次（重置计数基线）
    pc.setConnectionState('connected')
    expect(failedSpy).not.toHaveBeenCalled()

    // 4 次 failed：前 3 次安排重连，第 4 次用尽触发 onPeerFailed
    pc.setConnectionState('failed')
    pc.setConnectionState('failed')
    pc.setConnectionState('failed')
    pc.setConnectionState('failed')
    await vi.advanceTimersByTimeAsync(30000)

    expect(failedSpy).toHaveBeenCalledTimes(1)
    expect(failedSpy).toHaveBeenCalledWith('peer-2')
  })
})
