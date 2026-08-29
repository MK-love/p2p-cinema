// frontend/js/webrtc.js — WebRTC 封装（P2P mesh + DataChannel）

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
]

const MAX_RECONNECT_ATTEMPTS = 3

export class WebRTCClient {
  constructor(peerId, signalClient, isHost = false) {
    this.peerId = peerId
    this.signalClient = signalClient
    this.isHost = isHost
    this.connections = new Map()
    this.dataChannels = new Map()
    this.localStream = null
    this.remoteStreamCallbacks = []
    this.dataMessageCallbacks = []
    this.dataChannelOpenCallbacks = []
    this.dataChannelCloseCallbacks = []
    this.connectedCallbacks = []
    this.disconnectedCallbacks = []
    this.reconnectCallbacks = []
  }

  onRemoteStream(callback) {
    this.remoteStreamCallbacks.push(callback)
  }

  onDataMessage(callback) {
    this.dataMessageCallbacks.push(callback)
  }

  // I9: DataChannel 生命周期回调
  onDataChannelOpen(callback) {
    this.dataChannelOpenCallbacks.push(callback)
  }

  onDataChannelClose(callback) {
    this.dataChannelCloseCallbacks.push(callback)
  }

  onConnected(callback) {
    this.connectedCallbacks.push(callback)
  }

  onDisconnected(callback) {
    this.disconnectedCallbacks.push(callback)
  }

  // I10: 重连事件回调
  onReconnect(callback) {
    this.reconnectCallbacks.push(callback)
  }

  createConnection(remotePeerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pc._reconnectAttempts = 0

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalClient.send(remotePeerId, 'ice', JSON.stringify(event.candidate))
      }
    }

    // I10: 断连自动重连（ICE restart）
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        pc._reconnectAttempts = 0
        this.connectedCallbacks.forEach(cb => cb(remotePeerId))
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.disconnectedCallbacks.forEach(cb => cb(remotePeerId))
        if (pc._reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          pc._reconnectAttempts++
          const delay = pc._reconnectAttempts * 2000
          setTimeout(() => this.tryReconnect(remotePeerId), delay)
        }
      }
    }

    pc.ontrack = (event) => {
      this.remoteStreamCallbacks.forEach(cb => cb(event.streams[0], remotePeerId))
    }

    if (this.isHost) {
      const dc = pc.createDataChannel('sync', { ordered: true })
      this.setupDataChannel(dc, remotePeerId)
    } else {
      pc.ondatachannel = (event) => {
        this.setupDataChannel(event.channel, remotePeerId)
      }
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream)
      })
    }

    this.connections.set(remotePeerId, pc)
    return pc
  }

  // I9: 添加 onopen/onclose/onerror 处理
  setupDataChannel(dc, remotePeerId) {
    this.dataChannels.set(remotePeerId, dc)
    dc.onopen = () => {
      this.dataChannelOpenCallbacks.forEach(cb => cb(remotePeerId))
    }
    dc.onclose = () => {
      this.dataChannelCloseCallbacks.forEach(cb => cb(remotePeerId))
    }
    dc.onmessage = (event) => {
      const data = JSON.parse(event.data)
      this.dataMessageCallbacks.forEach(cb => cb(data, remotePeerId))
    }
  }

  async startScreenShare() {
    this.localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true
    })
    return this.localStream
  }

  stopScreenShare() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop())
      this.localStream = null
    }
  }

  // I1: await send
  async initiateConnection(remotePeerId) {
    const pc = this.createConnection(remotePeerId)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await this.signalClient.send(remotePeerId, 'offer', JSON.stringify(offer))
  }

  // I8: glare 保护 — rollback pending local offer
  async handleOffer(remotePeerId, sdp) {
    let pc = this.connections.get(remotePeerId)
    if (!pc) {
      pc = this.createConnection(remotePeerId)
    }
    const offer = JSON.parse(sdp)
    if (pc.signalingState === 'have-local-offer') {
      await pc.setLocalDescription({ type: 'rollback' })
    }
    await pc.setRemoteDescription(offer)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await this.signalClient.send(remotePeerId, 'answer', JSON.stringify(answer))
  }

  async handleAnswer(remotePeerId, sdp) {
    const pc = this.connections.get(remotePeerId)
    if (pc) {
      await pc.setRemoteDescription(JSON.parse(sdp))
    }
  }

  async handleIceCandidate(remotePeerId, candidate) {
    const pc = this.connections.get(remotePeerId)
    if (pc) {
      await pc.addIceCandidate(JSON.parse(candidate))
    }
  }

  addStreamToConnection(remotePeerId, stream) {
    const pc = this.connections.get(remotePeerId)
    if (!pc) return
    stream.getTracks().forEach(track => {
      const existingSender = pc.getSenders().find(s => s.track && s.track.kind === track.kind)
      if (existingSender) {
        existingSender.replaceTrack(track)
      } else {
        pc.addTrack(track, stream)
      }
    })
    // 画质优化：设置视频编码参数
    const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
    if (videoSender) {
      const params = videoSender.getParameters()
      if (!params.encodings) params.encodings = [{}]
      params.encodings[0].maxBitrate = 2500000
      params.degradationPreference = 'maintain-framerate'
      videoSender.setParameters(params)
    }
  }

  // I1: await send
  async renegotiate(remotePeerId) {
    const pc = this.connections.get(remotePeerId)
    if (!pc) return
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await this.signalClient.send(remotePeerId, 'offer', JSON.stringify(offer))
  }

  // I10: ICE restart 重连
  async tryReconnect(remotePeerId) {
    const pc = this.connections.get(remotePeerId)
    if (!pc || pc.connectionState === 'connected') return
    this.reconnectCallbacks.forEach(cb => cb(remotePeerId, pc._reconnectAttempts))
    try {
      const offer = await pc.createOffer({ iceRestart: true })
      await pc.setLocalDescription(offer)
      await this.signalClient.send(remotePeerId, 'offer', JSON.stringify(offer))
    } catch (e) {
      // reconnection failed
    }
  }

  sendData(data) {
    const json = JSON.stringify(data)
    this.dataChannels.forEach(dc => {
      if (dc.readyState === 'open') {
        dc.send(json)
      }
    })
  }

  close() {
    this.connections.forEach(pc => pc.close())
    this.connections.clear()
    this.dataChannels.clear()
    this.stopScreenShare()
  }
}
