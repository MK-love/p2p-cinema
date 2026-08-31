// test/frontend/webrtc.test.js — 屏幕共享能力检测测试

import { describe, it, expect, vi, afterEach } from 'vitest'
import { WebRTCClient, isScreenShareSupported } from '../../frontend/js/webrtc.js'

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
