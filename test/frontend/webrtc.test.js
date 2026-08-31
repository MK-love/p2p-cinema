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
