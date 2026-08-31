// frontend/js/webrtc.js — WebRTC 封装（P2P mesh + DataChannel）

// ICE 服务器：Google STUN 在中国大陆不可达，补充 Cloudflare 与国内公共 STUN 保证跨网打洞
export const ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // 免费 TURN（Open Relay 公共服务）：对称 NAT / 企业网 / 蜂窝网络下 STUN
  // 打洞失败时的兜底中继 —— 没有 TURN 这类网络组合永远连不上（P2P 免费方案
  // 的最后一环）。演示级公共服务；生产可替换为自建 coturn 或 Cloudflare Calls TURN。
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
]

const MAX_RECONNECT_ATTEMPTS = 3

// 屏幕共享能力检测：iOS/iPadOS 全系浏览器及新版 Android Chrome 均不支持 getDisplayMedia
export function isScreenShareSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
}

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
    this.peerFailedCallbacks = []
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

  // 重连次数用尽通知：上层应移除该对端（防止幽灵成员残留）
  onPeerFailed(callback) {
    this.peerFailedCallbacks.push(callback)
  }

  createConnection(remotePeerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pc._reconnectAttempts = 0
    // 候选缓冲：setRemoteDescription 完成前到达的 ICE 候选先入队，避免被浏览器丢弃
    pc._pendingCandidates = []

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalClient.send(remotePeerId, 'ice', JSON.stringify(event.candidate))
      }
    }

    // I10: 断连自动重连（ICE restart）
    // 修复：真正失败(failed)才消耗重连机会并重启（瞬时 disconnected 仅通知，避免
    // 「时不时重连」）；计时器去重+绑定当前 pc，防止多次状态回调堆积多个计时器，
    // 或被替换后的旧 pc 干扰新连接
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'connected') {
        pc._reconnectAttempts = 0
        if (pc._reconnectTimer) {
          clearTimeout(pc._reconnectTimer)
          pc._reconnectTimer = null
        }
        this.connectedCallbacks.forEach(cb => cb(remotePeerId))
      } else if (state === 'disconnected') {
        this.disconnectedCallbacks.forEach(cb => cb(remotePeerId))
      } else if (state === 'failed') {
        this.disconnectedCallbacks.forEach(cb => cb(remotePeerId))
        pc._reconnectAttempts++
        if (pc._reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
          if (!pc._reconnectTimer) {
            const attempt = pc._reconnectAttempts
            pc._reconnectTimer = setTimeout(() => {
              pc._reconnectTimer = null
              this.tryReconnect(remotePeerId, pc, attempt)
            }, attempt * 2000)
          }
        } else {
          // 重试用尽：对端确定离线，通知上层移除（幽灵成员治理）
          this.peerFailedCallbacks.forEach(cb => cb(remotePeerId))
        }
      } else if (state === 'closed') {
        if (pc._reconnectTimer) {
          clearTimeout(pc._reconnectTimer)
          pc._reconnectTimer = null
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
      let data
      try {
        data = JSON.parse(event.data)
      } catch {
        return // 忽略无法解析的消息，避免中断后续消息分发
      }
      this.dataMessageCallbacks.forEach(cb => cb(data, remotePeerId))
    }
  }

  async startScreenShare() {
    if (!isScreenShareSupported()) {
      throw new Error('当前浏览器不支持屏幕共享（手机端浏览器均不支持），请在电脑端使用 Chrome/Edge/Firefox 观看和发起共享')
    }
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
    const existing = this.connections.get(remotePeerId)
    // WS 闪断会触发服务端重复广播 join：
    //  - 连接健康（connected/connecting）：跳过，绝不打断画面与屏幕流
    //  - 本端 offer 已发出待应答（have-local-offer）：跳过，等 answer 回来，
    //    否则拆连接会把迟到 answer 变成 wrong-state 异常，握手死亡
    //  仅当连接缺失或确证失效（failed 等）才回收重建
    const healthy = existing && (existing.connectionState === 'connected' || existing.connectionState === 'connecting')
    const offerPending = existing && existing.signalingState === 'have-local-offer'
    if (healthy || offerPending) return
    if (existing) {
      this.connections.delete(remotePeerId)
      existing.close()
    }
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
    await this._flushCandidates(pc)
  }

  async handleAnswer(remotePeerId, sdp) {
    const pc = this.connections.get(remotePeerId)
    if (!pc) return
    // answer 只在 have-local-offer 状态合法。迟到/过期的 answer（连接已被重复
    // join 重建、或对端应答了已被替换的旧 offer）在这里优雅忽略——否则
    // InvalidStateError 未捕获会打断整个信令处理，握手彻底死亡
    if (pc.signalingState !== 'have-local-offer') {
      console.warn(`忽略迟到的 answer（${remotePeerId} 当前信令状态 ${pc.signalingState}）`)
      return
    }
    await pc.setRemoteDescription(JSON.parse(sdp))
    await this._flushCandidates(pc)
  }

  // 候选就绪后按序应用缓冲队列
  async _flushCandidates(pc) {
    const pending = pc._pendingCandidates
    pc._pendingCandidates = []
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate)
      } catch (e) {
        console.warn('ICE candidate apply failed:', e)
      }
    }
  }

  async handleIceCandidate(remotePeerId, candidate) {
    const pc = this.connections.get(remotePeerId)
    if (!pc) return
    const parsed = JSON.parse(candidate)
    // remoteDescription 未就绪时（offer/answer 仍在处理中）缓冲，否则浏览器会抛 InvalidStateError 丢弃候选
    if (!pc.remoteDescription) {
      pc._pendingCandidates.push(parsed)
      return
    }
    try {
      await pc.addIceCandidate(parsed)
    } catch (e) {
      console.warn('ICE candidate apply failed:', e)
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

  // I10: ICE restart 重连（绑定特定 pc：若该连接已被重建/替换或已连接，则跳过，
  // 避免旧计时器作用到新连接上造成反复无谓 ICE-restart）
  async tryReconnect(remotePeerId, pc, attempt) {
    if (this.connections.get(remotePeerId) !== pc) return // pc 已被替换
    if (pc.connectionState === 'connected' || pc.connectionState === 'closed') return
    this.reconnectCallbacks.forEach(cb => cb(remotePeerId, attempt))
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
