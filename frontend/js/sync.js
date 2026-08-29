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
    this.loadUrlCallbacks = []
    this.profileCallbacks = []
    this.participantsCallbacks = []
    this.roomDissolvedCallbacks = []
    this.peerLeftCallbacks = []

    this.webrtc.onDataMessage((data, remotePeerId) => {
      this.handleDataMessage(data, remotePeerId)
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

  onLoadUrl(callback) {
    this.loadUrlCallbacks.push(callback)
  }

  // --- 房间事件消息 ---

  sendProfile(nickname, peerId) {
    this.webrtc.sendData(formatSyncMessage('profile', { nickname, peerId }))
  }

  broadcastParticipants(list) {
    this.webrtc.sendData(formatSyncMessage('participants', { list }))
  }

  sendPeerLeft(peerId) {
    this.webrtc.sendData(formatSyncMessage('peer-left', { peerId }))
  }

  sendRoomDissolved() {
    this.webrtc.sendData(formatSyncMessage('room-dissolved', {}))
  }

  onProfile(callback) {
    this.profileCallbacks.push(callback)
  }

  onParticipantsUpdate(callback) {
    this.participantsCallbacks.push(callback)
  }

  onRoomDissolved(callback) {
    this.roomDissolvedCallbacks.push(callback)
  }

  onPeerLeft(callback) {
    this.peerLeftCallbacks.push(callback)
  }

  // --- 消息路由 ---

  handleDataMessage(data, remotePeerId) {
    // 聊天消息 — 所有角色都处理
    if (data.type === 'chat') {
      this.chatCallbacks.forEach(cb => cb(data))
      return
    }

    // 房间事件 — 所有角色都处理
    switch (data.type) {
      case 'room-dissolved':
        this.roomDissolvedCallbacks.forEach(cb => cb())
        return
      case 'peer-left':
        this.peerLeftCallbacks.forEach(cb => cb(data.peerId))
        return
      case 'participants':
        this.participantsCallbacks.forEach(cb => cb(data.list))
        return
      case 'profile':
        this.profileCallbacks.forEach(cb => cb(data.nickname, data.peerId))
        return
    }

    // 同步播放 — 仅加入者跟随房主
    if (this.isHost) return

    switch (data.type) {
      case 'load':
        this.video.src = data.url
        this.loadUrlCallbacks.forEach(cb => cb(data.url))
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
