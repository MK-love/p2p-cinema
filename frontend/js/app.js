// frontend/js/app.js — 主应用入口

import { RoomClient } from './room.js'
import { SignalClient } from './signal.js'
import { WebRTCClient, isScreenShareSupported } from './webrtc.js'
import { SyncController } from './sync.js'

// 根据环境配置 API 地址（生产环境前端与 API 同域，自动适配部署域名）
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : window.location.origin

const app = {
  state: 'home',
  peerId: null,
  nickname: null,
  roomCode: null,
  isHost: false,
  roomClient: null,
  signalClient: null,
  webrtcClient: null,
  syncController: null,
  currentMode: 'screen',
  participants: []
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
  return 'peer-' + Math.random().toString(36).slice(2, 11)
}

function generateNickname() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let suffix = ''
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return '用户-' + suffix
}

function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  $(`${page}-page`).classList.add('active')
}

function switchSidebarTab(tab) {
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'))
  $(`tab-${tab}`).classList.add('active')
  $(`${tab}-panel`).classList.add('active')
}

// 创建房间
async function handleCreateRoom() {
  app.peerId = generatePeerId()
  app.nickname = $('input-nickname').value.trim() || generateNickname()
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
  app.nickname = $('input-nickname').value.trim() || generateNickname()
  app.isHost = false
  app.roomClient = new RoomClient(API_BASE)
  try {
    const room = await app.roomClient.joinRoom(code)
    app.roomCode = code
    app.signalClient = new SignalClient(API_BASE, app.roomCode, app.peerId)
    app.webrtcClient = new WebRTCClient(app.peerId, app.signalClient, false)
    setupWebRTC(app.webrtcClient)
    app.signalClient.start()
    await app.signalClient.send(room.hostId, 'join', app.peerId)
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
  $('btn-leave').textContent = app.isHost ? '解散房间' : '退出房间'

  // 初始化参与者列表（自己）
  app.participants = [{ peerId: app.peerId, nickname: app.nickname, isHost: app.isHost }]
  renderParticipants()

  // 重置 UI
  $('chat-messages').innerHTML = ''
  switchSidebarTab('chat')

  const video = $('url-video')
  app.syncController = new SyncController(video, app.webrtcClient, app.isHost)
  app.syncController.init()
  app.syncController.onChat((data) => {
    appendChatMessage(data.from, data.text)
  })
  app.syncController.onLoadUrl(() => {
    $('url-placeholder').style.display = 'none'
    $('url-video').style.display = 'block'
  })

  // 房间事件回调
  app.syncController.onProfile((nickname, peerId) => {
    if (!app.isHost) return
    app.participants = app.participants.filter(p => p.peerId !== peerId)
    app.participants.push({ peerId, nickname, isHost: false })
    app.syncController.broadcastParticipants(app.participants)
    renderParticipants()
  })

  app.syncController.onParticipantsUpdate((list) => {
    app.participants = list
    renderParticipants()
  })

  app.syncController.onPeerLeft((peerId) => {
    if (!app.isHost) return
    const left = app.participants.find(p => p.peerId === peerId)
    app.participants = app.participants.filter(p => p.peerId !== peerId)
    app.syncController.broadcastParticipants(app.participants)
    renderParticipants()
    showToast(`${left?.nickname || peerId} 已退出房间`)
  })

  app.syncController.onRoomDissolved(() => {
    if (app.webrtcClient) app.webrtcClient.close()
    if (app.signalClient) app.signalClient.stop()
    if (app.syncController) app.syncController.destroy()
    resetAppState()
    showToast('房主已解散房间')
  })
}

// WebRTC 设置
function setupWebRTC(webrtc) {
  webrtc.onRemoteStream((stream, remotePeerId) => {
    const video = $('screen-video')
    video.srcObject = stream
    $('screen-placeholder').style.display = 'none'
  })

  webrtc.onConnected((remotePeerId) => {
    updateParticipantCount()
    showToast(`已连接: ${remotePeerId}`)
  })

  webrtc.onDisconnected((remotePeerId) => {
    updateParticipantCount()
    showToast(`${remotePeerId} 已断开`)
  })

  webrtc.onReconnect((remotePeerId, attempt) => {
    if (app.signalClient) {
      app.signalClient.reset()
    }
    showToast(`正在重连 ${remotePeerId} (第${attempt}次)...`)
  })

  // DataChannel 就绪 — 加入者发送昵称给房主
  webrtc.onDataChannelOpen((remotePeerId) => {
    if (!app.isHost && app.syncController) {
      app.syncController.sendProfile(app.nickname, app.peerId)
    }
    showToast('数据通道已就绪')
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
        if (app.isHost) {
          webrtc.initiateConnection(msg.from)
        }
        break
    }
  })

  app.signalClient.onTimeout(() => {
    showToast('房间不存在或已过期')
  })

  app.signalClient.onError((e) => {
    console.error('Signal error:', e.message)
  })
}

// 屏幕共享
async function handleShareScreen() {
  try {
    const stream = await app.webrtcClient.startScreenShare()
    const video = $('screen-video')
    video.srcObject = stream
    $('screen-placeholder').style.display = 'none'
    $('btn-share-screen').style.display = 'none'
    $('btn-stop-screen').style.display = 'inline-block'

    stream.getVideoTracks()[0].onended = () => {
      handleStopScreen()
    }

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
  $('btn-share-screen').style.display = isScreenShareSupported() ? 'inline-block' : 'none'
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

// 聊天 — 使用昵称显示
function handleSendChat() {
  const input = $('input-chat')
  const text = input.value.trim()
  if (!text) return
  app.syncController.sendChat(text, app.nickname || app.peerId)
  appendChatMessage(app.nickname || app.peerId, text)
  input.value = ''
}

// XSS 修复 — 使用 textContent
function appendChatMessage(from, text) {
  const messages = $('chat-messages')
  const div = document.createElement('div')
  div.className = 'chat-msg'
  const span = document.createElement('span')
  span.className = 'from'
  span.textContent = `${from}:`
  div.appendChild(span)
  div.appendChild(document.createTextNode(` ${text}`))
  messages.appendChild(div)
  messages.scrollTop = messages.scrollHeight
}

// 参与者列表渲染
function renderParticipants() {
  const list = $('members-list')
  list.innerHTML = ''
  app.participants.forEach(p => {
    const div = document.createElement('div')
    div.className = 'member-item'
    const name = document.createElement('span')
    name.className = 'member-name'
    name.textContent = p.nickname
    const badge = document.createElement('span')
    badge.className = `member-badge ${p.isHost ? 'host' : 'member'}`
    badge.textContent = p.isHost ? '房主' : '成员'
    div.appendChild(name)
    div.appendChild(badge)
    list.appendChild(div)
  })
}

// 离开/解散房间（按角色分流）
async function handleLeaveRoom() {
  if (app.isHost) {
    // 房主解散房间：通知所有对端
    if (app.syncController) {
      app.syncController.sendRoomDissolved()
    }
    // 等待消息发出再关闭连接
    await new Promise(r => setTimeout(r, 300))
    if (app.webrtcClient) app.webrtcClient.close()
    if (app.signalClient) app.signalClient.stop()
    if (app.syncController) app.syncController.destroy()
    if (app.roomClient && app.roomCode) {
      try { await app.roomClient.leaveRoom(app.roomCode, app.peerId) } catch {}
    }
    resetAppState()
    showToast('房间已解散')
  } else {
    // 加入者退出房间：通知房主
    if (app.syncController) {
      app.syncController.sendPeerLeft(app.peerId)
    }
    await new Promise(r => setTimeout(r, 300))
    if (app.webrtcClient) app.webrtcClient.close()
    if (app.signalClient) app.signalClient.stop()
    if (app.syncController) app.syncController.destroy()
    resetAppState()
  }
}

function resetAppState() {
  app.state = 'home'
  app.roomCode = null
  app.webrtcClient = null
  app.signalClient = null
  app.syncController = null
  app.participants = []
  showPage('home')
  $('input-room-code').value = ''
  // 重置视频元素
  $('screen-video').srcObject = null
  $('url-video').src = ''
  $('screen-placeholder').style.display = 'block'
  $('url-placeholder').style.display = 'block'
  $('btn-share-screen').style.display = isScreenShareSupported() ? 'inline-block' : 'none'
  $('btn-stop-screen').style.display = 'none'
  // 重置音量
  $('screen-volume').value = '1'
  $('url-volume').value = '1'
  $('screen-video').volume = 1
  $('url-video').volume = 1
  // 重置缩放模式
  $('screen-video').classList.remove('object-fit-fill')
  $('url-video').classList.remove('object-fit-fill')
  // 重置播放按钮
  const playBtn = document.querySelector('.toolbar-btn[data-action="play-pause"][data-target="screen-video"]')
  if (playBtn) playBtn.textContent = '▶'
  // 重置聊天
  $('chat-messages').innerHTML = ''
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
  // 不支持屏幕共享的设备（手机端）直接隐藏按钮，避免误点报错
  if (!isScreenShareSupported()) {
    $('btn-share-screen').style.display = 'none'
  }
  $('btn-stop-screen').addEventListener('click', handleStopScreen)
  $('btn-load-url').addEventListener('click', handleLoadUrl)
  $('btn-mode-screen').addEventListener('click', () => switchMode('screen'))
  $('btn-mode-url').addEventListener('click', () => switchMode('url'))
  $('btn-send-chat').addEventListener('click', handleSendChat)
  $('input-chat').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSendChat()
  })

  // 侧栏标签页切换
  $('tab-chat').addEventListener('click', () => switchSidebarTab('chat'))
  $('tab-members').addEventListener('click', () => switchSidebarTab('members'))

  // 视频工具栏 — 播放/暂停、全屏、画中画、缩放模式
  document.querySelectorAll('.toolbar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action
      const video = $(btn.dataset.target)
      if (!video) return

      switch (action) {
        case 'play-pause':
          if (video.paused) {
            video.play()
            btn.textContent = '⏸'
          } else {
            video.pause()
            btn.textContent = '▶'
          }
          break

        case 'fullscreen':
          if (document.fullscreenElement) {
            document.exitFullscreen()
          } else {
            const container = video.closest('.video-container')
            if (container.requestFullscreen) {
              container.requestFullscreen()
            } else if (container.webkitRequestFullscreen) {
              container.webkitRequestFullscreen()
            }
          }
          break

        case 'pip':
          if (document.pictureInPictureElement) {
            document.exitPictureInPicture()
          } else if (video !== document.pictureInPictureElement) {
            if (video.requestPictureInPicture) {
              video.requestPictureInPicture().catch(() => {
                showToast('当前浏览器不支持画中画')
              })
            } else {
              showToast('当前浏览器不支持画中画')
            }
          }
          break

        case 'fit':
          if (video.classList.contains('object-fit-fill')) {
            video.classList.remove('object-fit-fill')
            showToast('缩放模式：适应窗口')
          } else {
            video.classList.add('object-fit-fill')
            showToast('缩放模式：填满窗口')
          }
          break
      }
    })
  })

  // 播放/暂停按钮状态同步
  $('screen-video').addEventListener('play', () => {
    const btn = document.querySelector('.toolbar-btn[data-action="play-pause"][data-target="screen-video"]')
    if (btn) btn.textContent = '⏸'
  })
  $('screen-video').addEventListener('pause', () => {
    const btn = document.querySelector('.toolbar-btn[data-action="play-pause"][data-target="screen-video"]')
    if (btn) btn.textContent = '▶'
  })

  // 音量控制
  $('screen-volume').addEventListener('input', (e) => {
    $('screen-video').volume = parseFloat(e.target.value)
  })
  $('url-volume').addEventListener('input', (e) => {
    $('url-video').volume = parseFloat(e.target.value)
  })

  // 音量图标点击 — 静音/取消静音
  document.querySelectorAll('.volume-icon').forEach((icon, index) => {
    icon.addEventListener('click', () => {
      const slider = index === 0 ? $('screen-volume') : $('url-volume')
      const video = index === 0 ? $('screen-video') : $('url-video')
      if (video.volume > 0) {
        video.dataset.prevVolume = video.volume
        video.volume = 0
        slider.value = '0'
        icon.textContent = '🔇'
      } else {
        const prev = parseFloat(video.dataset.prevVolume || '1')
        video.volume = prev
        slider.value = String(prev)
        icon.textContent = '🔊'
      }
    })
  })

  // beforeunload 清理 — 仅房主删除房间
  window.addEventListener('beforeunload', () => {
    if (app.state === 'room') {
      if (app.webrtcClient) app.webrtcClient.close()
      if (app.signalClient) app.signalClient.stop()
      if (app.isHost && app.roomClient && app.roomCode) {
        fetch(`${API_BASE}/api/room/${app.roomCode}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ peerId: app.peerId }),
          keepalive: true
        }).catch(() => {})
      }
    }
  })
}

init()
