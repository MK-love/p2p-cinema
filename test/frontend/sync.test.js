// test/frontend/sync.test.js

import { describe, it, expect } from 'vitest'
import { formatSyncMessage, parseSyncMessage } from '../../frontend/js/sync.js'

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
