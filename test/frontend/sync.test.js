// test/frontend/sync.test.js

import { describe, it, expect, vi } from 'vitest'
import { formatSyncMessage, parseSyncMessage, SyncController } from '../../frontend/js/sync.js'

// 记录 add/remove 调用的假 video 元素
function createFakeVideo() {
  const added = []
  return {
    currentTime: 0,
    src: '',
    addEventListener: vi.fn((ev, fn) => added.push([ev, fn])),
    removeEventListener: vi.fn((ev, fn) => {
      const i = added.findIndex(([e, f]) => e === ev && f === f)
      if (i >= 0) added.splice(i, 1)
    }),
    _added: added
  }
}

describe('SyncController 生命周期', () => {
  it('房主 init 后 destroy 会移除 video 事件监听器（防止反复进出房间叠加泄漏）', () => {
    const video = createFakeVideo()
    const webrtc = { onDataMessage: () => {}, sendData: () => {} }
    const controller = new SyncController(video, webrtc, true)
    controller.init()

    expect(video._added.length).toBe(3) // play / pause / seeked

    controller.destroy()
    expect(video.addEventListener).toHaveBeenCalledTimes(3)
    expect(video.removeEventListener).toHaveBeenCalledTimes(3)
  })

  it('非房主 init 不添加监听器，destroy 无副作用', () => {
    const video = createFakeVideo()
    const webrtc = { onDataMessage: () => {}, sendData: () => {} }
    const controller = new SyncController(video, webrtc, false)
    controller.init()
    controller.destroy()
    expect(video.addEventListener).not.toHaveBeenCalled()
  })
})

describe('formatSyncMessage', () => {
  it('formats a play message', () => {
    const msg = formatSyncMessage('play', { time: 123.4 })
    expect(msg.type).toBe('play')
    expect(msg.time).toBe(123.4)
    expect(msg.ts).toBeTypeOf('number')
  })

  it('formats a load message', () => {
    const msg = formatSyncMessage('load', { url: 'https://example.com/v.mp4', time: 0 })
    expect(msg.type).toBe('load')
    expect(msg.url).toBe('https://example.com/v.mp4')
  })

  it('formats a chat message', () => {
    const msg = formatSyncMessage('chat', { text: 'hello', from: 'Alice' })
    expect(msg.type).toBe('chat')
    expect(msg.text).toBe('hello')
    expect(msg.from).toBe('Alice')
  })
})

describe('parseSyncMessage', () => {
  it('parses a JSON string message', () => {
    const msg = parseSyncMessage(JSON.stringify({ type: 'pause', time: 50 }))
    expect(msg.type).toBe('pause')
    expect(msg.time).toBe(50)
  })

  it('returns null for invalid JSON', () => {
    expect(parseSyncMessage('not json')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseSyncMessage('')).toBeNull()
  })
})
