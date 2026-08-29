// frontend/js/app.js — 主应用入口

import { RoomClient } from './room.js'
import { SignalClient } from './signal.js'
import { WebRTCClient } from './webrtc.js'
import { SyncController } from './sync.js'

// 根据环境配置 API 地址
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://p2p-cinema-api.your-account.workers.dev'

const app = {
  state: 'home',
  peerId: null,
  roomCode: null,
  isHost: false,
  roomClient: null,
  signalClient: null,
  webrtcClient: null,
  syncController: null,
  currentMode: 'screen'
}

// 工具函数
function $(id) { return document.getElementById(id) }

function showToast(message, duration = 3000) {
  const toast = $('toast')
  toast.textContent = message
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), duration)
}

function generatePeerId() {
  return 'peer-' + Math.random().toString(36).substr(2, 9)
}

function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  $(`${page}-page`).classList.add('active')
}

// 创建房间
async function handleCreateRoom() {
  app.peerId = generatePeerId()
  app.isHost = true
  app.roomClient = new RoomClient(API_BASE)
  try {
    const result = await app.roomClient.createRoom(app.peerId)
    app.roomCode = result.roomCode
    app.signalClient = new SignalClient(API_BASE, app.roomCode, app.peerId)
    app.webrtcClient = new WebRTCClient(app.peerId, app.signalClient, true)
    setupWebRTC(app.webrtcClient)
    app.signalClient.start()
    enterRoom()
  } catch (e) {
    showToast('创建房间失败: ' + e.message)
  }
}

// 加入房间
async function handleJoinRoom() {
  const code = $('input-room-code').value.trim().toUpperCase()
  if (code.length !== 6) {
    showToast('请输入 6 位邀请码')
    return
  }
  app.peerId = generatePeerId()
  app.isHost = false
  app.roomClient = new RoomClient(API_BASE)
  try {
    const room = await app.roomClient.joinRoom(code)
    app.roomCode = code
    app.signalClient = new SignalClient(API_BASE, app.roomCode, app.peerId)
    app.webrtcClient = new WebRTCClient(app.peerId, app.signalClient, false)
    setupWebRTC(app.webrtcClient)
    app.signalClient.start()
    // 加入者向房主发送 join 通知，房主收到后发起 WebRTC offer
    app.signalClient.send(room.hostId, 'join', app.peerId)
    enterRoom()
  } catch (e) {
    showToast(e.message)
  }
}

// 进入房间
function enterRoom() {
  app.state = 'room'
  showPage('room')
  $('room-code-display').textContent = app.roomCode

  const video = $('url-video')
  app.syncController = new SyncController(video, app.webrtcClient, app.isHost)
  app.syncController.init()
  app.syncController.onChat((data) => {
    appendChatMessage(data.from, data.text)
  })
}

// WebRTC 设置
function setupWebRTC(webrtc) {
  webrtc.onRemoteStream((stream, remotePeerId) => {
    const video = $('screen-video')
    video.srcObject = stream
    $('screen-placeholder').style.display = 'none'
  })

  webrtc.onDataMessage((data, remotePeerId) => {
    // DataChannel 消息由 SyncController 处理，这里不需要额外逻辑
  })

  webrtc.onConnected((remotePeerId) => {
    updateParticipantCount()
    showToast(`已连接: ${remotePeerId}`)
  })

  webrtc.onDisconnected((remotePeerId) => {
    updateParticipantCount()
    showToast(`${remotePeerId} 已断开`)
  })

  // 信令消息路由到 WebRTC
  app.signalClient.onMessage((msg) => {
    switch (msg.type) {
      case 'offer':
        webrtc.handleOffer(msg.from, msg.data)
        break
      case 'answer':
        webrtc.handleAnswer(msg.from, msg.data)
        break
      case 'ice':
        webrtc.handleIceCandidate(msg.from, msg.data)
        break
      case 'join':
        // join 通知通过 DataChannel 无关路径处理
        // 实际上 join 是通过 signal 通道发送的，需要在这里处理
        if (app.isHost) {
          webrtc.initiateConnection(msg.from)
        }
        break
    }
  })

  app.signalClient.onTimeout(() => {
    showToast('信令超时，请重试')
  })
}

// 屏幕共享
async function handleShareScreen() {
  try {
    const stream = await app.webrtcClient.startScreenShare()
    // 房主自己也显示画面
    const video = $('screen-video')
    video.srcObject = stream
    $('screen-placeholder').style.display = 'none'
    $('btn-share-screen').style.display = 'none'
    $('btn-stop-screen').style.display = 'inline-block'

    // 监听屏幕共享停止
    stream.getVideoTracks()[0].onended = () => {
      handleStopScreen()
    }

    // 向已连接的对端添加流并重新协商
    app.webrtcClient.connections.forEach((pc, remotePeerId) => {
      app.webrtcClient.addStreamToConnection(remotePeerId, stream)
      app.webrtcClient.renegotiate(remotePeerId)
    })
  } catch (e) {
    showToast('屏幕共享失败: ' + e.message)
  }
}

function handleStopScreen() {
  app.webrtcClient.stopScreenShare()
  const video = $('screen-video')
  video.srcObject = null
  $('screen-placeholder').style.display = 'block'
  $('btn-share-screen').style.display = 'inline-block'
  $('btn-stop-screen').style.display = 'none'
}

// URL 同步播放
function handleLoadUrl() {
  const url = $('input-video-url').value.trim()
  if (!url) {
    showToast('请输入视频 URL')
    return
  }
  app.syncController.loadUrl(url)
  $('url-placeholder').style.display = 'none'
  $('url-video').style.display = 'block'
}

// 模式切换
function switchMode(mode) {
  app.currentMode = mode
  document.querySelectorAll('.btn-mode').forEach(b => b.classList.remove('active'))
  $(`btn-mode-${mode}`).classList.add('active')
  document.querySelectorAll('.mode-panel').forEach(p => p.classList.remove('active'))
  $(`${mode}-mode`).classList.add('active')
}

// 聊天
function handleSendChat() {
  const input = $('input-chat')
  const text = input.value.trim()
  if (!text) return
  app.syncController.sendChat(text, app.peerId)
  appendChatMessage(app.peerId, text)
  input.value = ''
}

function appendChatMessage(from, text) {
  const messages = $('chat-messages')
  const div = document.createElement('div')
  div.className = 'chat-msg'
  div.innerHTML = `<span class="from">${from}:</span> ${text}`
  messages.appendChild(div)
  messages.scrollTop = messages.scrollHeight
}

// 离开房间
async function handleLeaveRoom() {
  if (app.webrtcClient) app.webrtcClient.close()
  if (app.signalClient) app.signalClient.stop()
  if (app.syncController) app.syncController.destroy()
  if (app.roomClient && app.roomCode) {
    try { await app.roomClient.leaveRoom(app.roomCode, app.peerId) } catch {}
  }
  app.state = 'home'
  app.roomCode = null
  app.webrtcClient = null
  app.signalClient = null
  app.syncController = null
  showPage('home')
  $('input-room-code').value = ''
}

function updateParticipantCount() {
  const count = app.webrtcClient ? app.webrtcClient.connections.size + 1 : 1
  $('participant-count').textContent = `在线: ${count}人`
}

// 事件绑定
function init() {
  $('btn-create').addEventListener('click', handleCreateRoom)
  $('btn-join').addEventListener('click', handleJoinRoom)
  $('input-room-code').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleJoinRoom()
  })
  $('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(app.roomCode)
    showToast('邀请码已复制')
  })
  $('btn-leave').addEventListener('click', handleLeaveRoom)
  $('btn-share-screen').addEventListener('click', handleShareScreen)
  $('btn-stop-screen').addEventListener('click', handleStopScreen)
  $('btn-load-url').addEventListener('click', handleLoadUrl)
  $('btn-mode-screen').addEventListener('click', () => switchMode('screen'))
  $('btn-mode-url').addEventListener('click', () => switchMode('url'))
  $('btn-send-chat').addEventListener('click', handleSendChat)
  $('input-chat').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSendChat()
  })

  // 页面关闭时清理
  window.addEventListener('beforeunload', () => {
    if (app.state === 'room') {
      if (app.webrtcClient) app.webrtcClient.close()
      if (app.signalClient) app.signalClient.stop()
      if (app.roomClient && app.roomCode) {
        app.roomClient.leaveRoom(app.roomCode, app.peerId).catch(() => {})
      }
    }
  })
}

init()
