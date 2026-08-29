// frontend/js/webrtc.js — WebRTC 封装（P2P mesh + DataChannel）

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
]

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
    this.connectedCallbacks = []
    this.disconnectedCallbacks = []
  }

  onRemoteStream(callback) {
    this.remoteStreamCallbacks.push(callback)
  }

  onDataMessage(callback) {
    this.dataMessageCallbacks.push(callback)
  }

  onConnected(callback) {
    this.connectedCallbacks.push(callback)
  }

  onDisconnected(callback) {
    this.disconnectedCallbacks.push(callback)
  }

  createConnection(remotePeerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalClient.send(remotePeerId, 'ice', JSON.stringify(event.candidate))
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.connectedCallbacks.forEach(cb => cb(remotePeerId))
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.disconnectedCallbacks.forEach(cb => cb(remotePeerId))
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

  setupDataChannel(dc, remotePeerId) {
    this.dataChannels.set(remotePeerId, dc)
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

  async initiateConnection(remotePeerId) {
    const pc = this.createConnection(remotePeerId)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.signalClient.send(remotePeerId, 'offer', JSON.stringify(offer))
  }

  async handleOffer(remotePeerId, sdp) {
    let pc = this.connections.get(remotePeerId)
    if (!pc) {
      pc = this.createConnection(remotePeerId)
    }
    await pc.setRemoteDescription(JSON.parse(sdp))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    this.signalClient.send(remotePeerId, 'answer', JSON.stringify(answer))
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

  async renegotiate(remotePeerId) {
    const pc = this.connections.get(remotePeerId)
    if (!pc) return
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.signalClient.send(remotePeerId, 'offer', JSON.stringify(offer))
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
