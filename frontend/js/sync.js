// frontend/js/sync.js — 同步播放控制（DataChannel）

const SYNC_TOLERANCE = 2
const SYNC_INTERVAL = 5000

export function formatSyncMessage(type, payload) {
  return { type, ...payload, ts: Date.now() }
}

export function parseSyncMessage(jsonString) {
  try {
    return JSON.parse(jsonString)
  } catch {
    return null
  }
}

export class SyncController {
  constructor(videoElement, webrtcClient, isHost = false) {
    this.video = videoElement
    this.webrtc = webrtcClient
    this.isHost = isHost
    this.syncTimer = null
    this.chatCallbacks = []

    this.webrtc.onDataMessage((data, remotePeerId) => {
      this.handleDataMessage(data)
    })
  }

  init() {
    if (this.isHost) {
      this.video.addEventListener('play', () => {
        this.webrtc.sendData(formatSyncMessage('play', { time: this.video.currentTime }))
      })
      this.video.addEventListener('pause', () => {
        this.webrtc.sendData(formatSyncMessage('pause', { time: this.video.currentTime }))
      })
      this.video.addEventListener('seeked', () => {
        this.webrtc.sendData(formatSyncMessage('seek', { time: this.video.currentTime }))
      })
      this.syncTimer = setInterval(() => {
        this.webrtc.sendData(formatSyncMessage('sync', { time: this.video.currentTime }))
      }, SYNC_INTERVAL)
    }
  }

  loadUrl(url) {
    this.video.src = url
    if (this.isHost) {
      this.webrtc.sendData(formatSyncMessage('load', { url, time: 0 }))
    }
  }

  handleDataMessage(data) {
    if (data.type === 'chat') {
      this.chatCallbacks.forEach(cb => cb(data))
      return
    }

    if (this.isHost) return

    switch (data.type) {
      case 'load':
        this.video.src = data.url
        break
      case 'play':
        this.video.currentTime = data.time
        this.video.play()
        break
      case 'pause':
        this.video.currentTime = data.time
        this.video.pause()
        break
      case 'seek':
        this.video.currentTime = data.time
        break
      case 'sync':
        if (Math.abs(this.video.currentTime - data.time) > SYNC_TOLERANCE) {
          this.video.currentTime = data.time
        }
        break
    }
  }

  sendChat(text, from) {
    this.webrtc.sendData(formatSyncMessage('chat', { text, from }))
  }

  onChat(callback) {
    this.chatCallbacks.push(callback)
  }

  destroy() {
    if (this.syncTimer) clearInterval(this.syncTimer)
  }
}
