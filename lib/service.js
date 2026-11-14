/** DSH QQ/OneBot service: durable buffering, receipts, binding, media and tools. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Store, accountDir, DEFAULT_SETTINGS } from './db.js'
import { OneBotClient } from './onebot.js'
import { Renderer } from './render.js'
import { MediaManager } from './media.js'
import {
  cleanName, formatBytes, formatClock, isHttpUrl, jsonClone, jsonText, mimeForName, parseReceiptRef, parseTarget,
  randomHex, safeFilename, safeJsonParse, toFileUrl, truncateText,
} from './util.js'

const RESERVED_RESULT_MAX = 12000

function nowMs() { return Date.now() }
function asArray(value) { return Array.isArray(value) ? value : (value == null ? [] : [value]) }
function textOfSegments(segments) {
  return (segments || []).filter(s => s?.type === 'text').map(s => String(s.text ?? '')).join('')
}
function compactPreview(content, maxChars = 600) {
  const text = typeof content === 'string' ? content : jsonText(content)
  return text.length <= maxChars ? content : truncateText(text, maxChars)
}

function parseCQString(raw) {
  if (typeof raw !== 'string') return []
  const out = []
  let cursor = 0
  const re = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/gu
  let match
  while ((match = re.exec(raw))) {
    if (match.index > cursor) out.push({ type: 'text', data: { text: raw.slice(cursor, match.index) } })
    const data = {}
    for (const part of (match[2] || '').replace(/^,/u, '').split(',')) {
      if (!part) continue
      const eq = part.indexOf('=')
      if (eq > 0) data[part.slice(0, eq)] = part.slice(eq + 1).replace(/&#44;/gu, ',').replace(/&#91;/gu, '[').replace(/&#93;/gu, ']').replace(/&amp;/gu, '&')
    }
    out.push({ type: match[1], data })
    cursor = re.lastIndex
  }
  if (cursor < raw.length) out.push({ type: 'text', data: { text: raw.slice(cursor) } })
  return out
}

function cardText(seg) {
  const d = seg.data || {}
  const raw = d.data || d.content || d.string || ''
  let title = String(d.title || d.summary || '').trim()
  let summary = String(d.desc || d.description || '').trim()
  if (raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      title ||= String(parsed.prompt || parsed.title || parsed.meta?.title || parsed.news?.title || '').trim()
      summary ||= String(parsed.meta?.desc || parsed.meta?.detail_1 || parsed.desc || parsed.news?.desc || parsed.summary || '').trim()
    } catch {
      const cleaned = String(raw).replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()
      if (!title && cleaned) title = cleaned.slice(0, 180)
    }
  }
  return { title: cleanName(title), summary: cleanName(summary || title) }
}

export class QQService {
  constructor(config = {}, deps = {}) {
    const defaults = {
      dataDir: path.join(os.homedir(), '.dsh', 'qq-plugin'),
      account: '', owner: '',
      onebot: {
        mode: 'ws', url: 'ws://127.0.0.1:3001/', httpUrl: 'http://127.0.0.1:3000/',
        accessToken: '', listenHost: '127.0.0.1', listenPort: 5701, listenPath: '/onebot/events',
        reconnectMs: 1000, requestTimeoutMs: 30000,
      },
      autoImageMaxMb: 64, autoMediaMaxMb: 20,
    }
    this.config = { ...defaults, ...config, onebot: { ...defaults.onebot, ...(config.onebot || {}) } }
    this.ctx = deps.ctx
    this.agents = deps.agents
    this.store = null; this.client = null; this.media = null; this.renderer = null
    this.accountId = String(this.config.account || '')
    this.selfId = String(this.config.account || '')
    this.ownerId = String(this.config.owner || '')
    this.boundSessionId = ''; this.boundAgent = null
    this.backlogNeeded = false; this.lastWakeAt = 0; this.wakePending = false
    this.timer = null; this.housekeepingAt = 0; this.started = false
    this.lastError = ''; this.lastLog = []
    this.groupNameAttempts = new Map()
    this.configLoader = deps.loadConfig
    this.configWatcher = null
    this.configReloadTimer = null
    this.configReloading = null
  }

  log(level, message, detail = undefined) {
    const entry = { ts: nowMs(), level, message: String(message || '') }
    if (detail !== undefined) entry.detail = detail
    this.lastLog.push(entry)
    if (this.lastLog.length > 80) this.lastLog.shift()
    if (level === 'error') this.lastError = entry.message
    if (this.store && level === 'error') { try { this.store.addError('runtime', entry.message, detail) } catch {} }
  }

  async start() {
    if (this.started) return
    this.started = true
    this.housekeepingAt = nowMs() + 60_000
    this.client = this.createClient()
    if (this.config.account) {
      try { this.openStore(String(this.config.account)) } catch (error) { this.log('error', `QQ 账号数据库打开失败: ${error.message}`) }
    }
    const initial = this.store?.effectiveSettings('')
    if (this.config.serviceEnabled !== false && initial?.serviceEnabled !== false) {
      await this.client.start().catch(error => this.log('error', `OneBot start failed: ${error.message}`))
    }
    if (!this.started) { await this.client.stop().catch(() => {}); return }
    this.timer = setInterval(() => { void this.tick().catch(error => this.log('error', `tick: ${error.message}`)) }, 1000)
    this.timer.unref?.()
    this.watchConfig()
  }

  createClient() {
    return new OneBotClient(this.config.onebot, {
      onLog: event => this.log(event.level === 'warn' ? 'warn' : 'info', event.message),
      onError: event => this.log('error', event.message, event),
      onEvent: event => { void this.handleEvent(event).catch(error => this.log('error', `event: ${error.message}`, { stack: error.stack })) },
      onConnection: event => {
        this.log('info', event.connected ? 'OneBot connected' : `OneBot disconnected: ${event.error || ''}`)
        if (event.connected) void this.onProtocolReady(event.state).catch(error => this.log('error', `OneBot ready handling failed: ${error.message}`))
      },
      onReady: event => { void this.onProtocolReady(event.state, event.login, event.version).catch(error => this.log('error', `OneBot identity probe failed: ${error.message}`)) },
    })
  }

  async stop() {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.configReloadTimer) clearTimeout(this.configReloadTimer)
    this.configReloadTimer = null
    try { this.configWatcher?.close() } catch {}
    this.configWatcher = null
    await this.client?.stop().catch(() => {})
    this.client = null
    this.store?.close()
    this.store = null
  }

  watchConfig() {
    try { this.configWatcher?.close() } catch {}
    this.configWatcher = null
    const file = this.config.configFile || path.join(this.config.dataDir, 'config.json')
    const dir = path.dirname(file)
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    try {
      this.configWatcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        const changed = filename ? String(filename) : ''
        if (changed && changed !== path.basename(file) && changed !== 'config.json') return
        if (this.configReloadTimer) clearTimeout(this.configReloadTimer)
        this.configReloadTimer = setTimeout(() => {
          this.configReloadTimer = null
          void this.reloadConfig('config-file').catch(error => this.log('warn', `配置热重载失败: ${error.message}`))
        }, 600)
        this.configReloadTimer.unref?.()
      })
      this.configWatcher.on?.('error', error => this.log('warn', `配置文件监视失败: ${error.message}`))
    } catch (error) {
      this.log('warn', `配置文件监视启动失败: ${error.message}`)
    }
  }

  async reloadConfig(reason = 'manual') {
    if (this.configReloading) return this.configReloading
    this.configReloading = (async () => {
      if (typeof this.configLoader !== 'function') return { ok: false, reason, error: '当前实例没有配置加载器' }
      const next = this.configLoader()
      if (!next || typeof next !== 'object') throw new Error('配置文件格式无效')
      const oldAccount = String(this.config.account || this.accountId || '')
      const oldToken = String(this.config.onebot?.accessToken || '')
      this.config = next
      const account = String(next.account || '')
      if (this.store && account && this.store.account !== account) {
        this.store.close()
        this.store = null; this.media = null; this.renderer = null
        this.boundSessionId = ''; this.boundAgent = null; this.backlogNeeded = false
      }
      this.selfId = account || this.selfId
      this.ownerId = String(next.owner || this.ownerId || '')
      await this.client?.stop().catch(() => {})
      this.client = this.createClient()
      if (account) {
        try { this.openStore(account) } catch (error) { this.log('error', `QQ 账号数据库打开失败: ${error.message}`) }
      }
      this.renderer?.setIdentity({ selfId: this.selfId, ownerId: this.ownerId })
      const settings = this.store?.effectiveSettings('')
      if (this.started && settings?.serviceEnabled !== false) {
        await this.client.start().catch(error => this.log('error', `OneBot start failed: ${error.message}`))
      }
      this.watchConfig()
      this.schedulePump(true)
      return {
        ok: true, reason,
        changed: oldAccount !== account || oldToken !== String(next.onebot?.accessToken || ''),
        status: this.setupStatus(),
      }
    })().finally(() => { this.configReloading = null })
    return this.configReloading
  }

  setupStatus() {
    const configFile = this.config.configFile || path.join(this.config.dataDir, 'config.json')
    let configExists = false
    try { configExists = fs.existsSync(configFile) } catch {}
    const binding = this.store?.getBindings?.()
    return {
      configFile,
      configExists,
      account: this.config.account || this.accountId || null,
      owner: this.config.owner || this.ownerId || null,
      onebot: {
        mode: this.config.onebot?.mode,
        url: this.config.onebot?.url,
        httpUrl: this.config.onebot?.httpUrl,
        accessTokenConfigured: Boolean(this.config.onebot?.accessToken),
      },
      connection: this.client?.getState?.() ?? { connected: false },
      store: this.store ? { account: this.store.account, ...this.store.counts() } : null,
      binding: binding ? { session: binding.session_id || null, epoch: binding.epoch } : null,
    }
  }

  async verifySetup() {
    const status = this.setupStatus()
    const checks = []
    checks.push({ name: 'config', ok: status.configExists, detail: status.configFile })
    for (const port of [Number(new URL(status.onebot.httpUrl || 'http://127.0.0.1:3000').port || 80), Number(new URL(status.onebot.url || 'ws://127.0.0.1:3001').port || 80)]) {
      const open = await new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port })
        const done = value => { try { socket.destroy() } catch {}; resolve(value) }
        socket.once('connect', () => done(true))
        socket.once('error', () => done(false))
        socket.setTimeout(1500, () => done(false))
      })
      checks.push({ name: `port:${port}`, ok: open })
    }
    let login = null
    try {
      const base = new URL(status.onebot.httpUrl || 'http://127.0.0.1:3000/')
      const headers = { 'content-type': 'application/json' }
      if (this.config.onebot?.accessToken) headers.authorization = `Bearer ${this.config.onebot.accessToken}`
      const response = await fetch(base, {
        method: 'POST', headers, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ action: 'get_login_info', params: {}, echo: 'qq-setup-verify' }),
      })
      const data = await response.json()
      const ok = response.ok && data?.status === 'ok' && Number(data?.retcode ?? 0) === 0
      login = data?.data ? { user_id: data.data.user_id, nickname: data.data.nickname } : null
      checks.push({ name: 'get_login_info', ok, detail: login })
    } catch (error) {
      checks.push({ name: 'get_login_info', ok: false, detail: error.message })
    }
    return { ok: checks.every(check => check.ok), status, checks, login }
  }

  async setupTool(args = {}, _agent) {
    const action = String(args.action || 'guide')
    if (action === 'guide') return { ...this.setupGuide(), status: this.setupStatus() }
    if (action === 'status') return this.setupStatus()
    if (action === 'reload') return this.reloadConfig('manual')
    if (action === 'verify') return this.verifySetup()
    throw new Error('action 可选 guide / status / reload / verify')
  }

  effectiveOptions() {
    const settings = this.store ? this.store.effectiveSettings('') : { ...DEFAULT_SETTINGS, owner: this.config.owner || '' }
    return { ...this.config, ...settings, owner: settings.owner || this.config.owner || this.ownerId }
  }

  async onProtocolReady(state, login = null, version = null) {
    const id = String(state.selfId || login?.user_id || login?.uin || this.config.account || '')
    if (!id) { this.log('warn', 'OneBot connected but account id is unavailable'); return }
    if (this.accountId && this.accountId !== id) {
      this.log('error', `检测到另一个 QQ 账号 ${id}，当前插件只处理 ${this.accountId}`)
      return
    }
    if (!this.store || this.store.account !== id) this.openStore(id)
    this.selfId = id
    if (!this.ownerId) this.ownerId = String(this.effectiveOptions().owner || this.config.owner || '')
    this.renderer?.setIdentity({ selfId: this.selfId, ownerId: this.ownerId })
    for (const agent of this.agents?.list?.() ?? []) this.maybeReattach(agent)
    this.schedulePump(true)
  }

  openStore(account) {
    if (this.store && this.store.account === account) return this.store
    if (this.store) {
      const counts = this.store.counts()
      if (this.store.account === 'pending' && counts.messages === 0 && counts.receipts === 0) this.store.close()
      else if (counts.messages > 0 || counts.receipts > 0) throw new Error(`不能切换到另一个账号 ${account}：当前账号数据库已有数据`)
      else this.store.close()
    }
    this.accountId = String(account)
    this.store = new Store(accountDir(this.config.dataDir, account), account)
    const settings = this.store.effectiveSettings('')
    this.ownerId = String(settings.owner || this.config.owner || this.ownerId || '')
    this.media = new MediaManager(this.store, this.client, {
      autoImageMaxBytes: Math.max(1, Number(this.config.autoImageMaxMb || 64)) * 1024 * 1024,
      autoMediaMaxBytes: Math.max(1, Number(this.config.autoMediaMaxMb || 20)) * 1024 * 1024,
      onLog: event => this.log(event.level || 'info', event.message),
    })
    this.renderer = new Renderer(this.store, {
      selfId: this.selfId || this.accountId, ownerId: this.ownerId,
      quoteThreshold: settings.quoteThreshold,
      replyFetch: (chatType, peerId, messageId) => this.fetchMessage(chatType, peerId, messageId),
    })
    const binding = this.store.getBindings()
    this.boundSessionId = String(binding.session_id || '')
    this.boundAgent = this.boundSessionId ? (this.agents?.get?.(this.boundSessionId) ?? null) : null
    if (this.boundAgent) this.backlogNeeded = true
    return this.store
  }

  ensureStore() {
    if (this.store) return this.store
    if (this.config.account) return this.openStore(String(this.config.account))
    throw Object.assign(new Error('QQ 尚未连接或未识别账号；请先等待 OneBot 登录'), { code: 'QQ_NOT_READY' })
  }

  schedulePump(immediate = false) {
    if (!this.started) return
    if (immediate) queueMicrotask(() => { void this.tick().catch(error => this.log('error', `pump: ${error.message}`)) })
  }

  maybeReattach(agent) {
    if (!this.store || !agent?.id) return false
    const result = this.store.reattach(agent.id)
    if (!result.ok) return false
    this.boundSessionId = String(agent.id)
    this.boundAgent = agent
    this.backlogNeeded = true
    this.ownerId = String(this.effectiveOptions().owner || this.ownerId || '')
    this.renderer?.setIdentity({ selfId: this.selfId, ownerId: this.ownerId })
    this.schedulePump()
    return true
  }

  ensureHolder(agent) {
    const store = this.ensureStore()
    if (!agent?.id) throw Object.assign(new Error('QQ 工具只能在 DSH 会话中调用'), { code: 'NO_AGENT' })
    const claim = store.claimBinding(agent.id)
    if (!claim.ok) throw Object.assign(new Error(claim.reason || '该账号已被其他会话接管'), { code: 'QQ_SESSION_TAKEN_OVER' })
    const changed = claim.changed || this.boundSessionId !== String(agent.id)
    this.boundSessionId = String(agent.id)
    this.boundAgent = agent
    this.ownerId = String(this.effectiveOptions().owner || this.ownerId || '')
    this.renderer?.setIdentity({ selfId: this.selfId, ownerId: this.ownerId })
    if (changed) this.backlogNeeded = true
    this.schedulePump()
    return store
  }

  currentAgent() {
    if (!this.boundSessionId) return null
    const live = this.agents?.get?.(this.boundSessionId)
    if (live) this.boundAgent = live
    else if (this.boundAgent?.id !== this.boundSessionId) this.boundAgent = null
    return this.boundAgent
  }

  async tick() {
    if (!this.started) return
    const now = nowMs()
    if (now >= this.housekeepingAt) {
      this.housekeepingAt = now + 5 * 60_000
      await this.housekeeping().catch(error => this.log('error', `housekeeping: ${error.message}`))
    }
    if (!this.store) return
    const settings = this.store.effectiveSettings('')
    if (settings.serviceEnabled === false) return
    const agent = this.currentAgent()
    if (!agent || agent.status !== 'idle') return
    if (this.wakePending && now - this.lastWakeAt < 1500) return
    if (this.backlogNeeded) {
      const sent = await this.sendBacklogSummary(agent)
      if (sent) { this.wakePending = true; this.lastWakeAt = now; return }
      this.backlogNeeded = false
    }
    const items = await this.readyNotifications()
    if (items.length === 0) return
    const text = this.fitNotification(items)
    if (!text) return
    try {
      this.deliverWake(agent, text)
      this.wakePending = true
      this.lastWakeAt = now
      const delivered = items.filter(item => text.includes(item.receipt.receipt))
      for (const item of delivered) {
        this.store.markReceiptNotified(item.receipt.receipt)
        if (item.inline) this.store.markReceiptState(item.receipt.receipt, 'read')
      }
      const hintChats = this.hintCandidates(delivered)
      for (const [chatType, peerId] of hintChats) this.store.setHintAt(chatType, peerId, now)
    } catch (error) {
      this.log('error', `QQ 通知投递失败: ${error.message}`)
    }
  }

  deliverWake(agent, text) {
    agent.followup({
      id: crypto.randomUUID(), role: 'user',
      content: [{ type: 'text', text }], source: { kind: 'qq' },
    })
  }

  hintCandidates(items) {
    const now = nowMs()
    const found = []
    for (const item of items) {
      const stats = this.store.getChatStats(item.receipt.chat_type, item.receipt.peer_id)
      if (Number(stats.silent_streak || 0) < 3) continue
      if (now - Number(stats.last_hint_at || 0) < 3600_000) continue
      found.push([item.receipt.chat_type, item.receipt.peer_id])
    }
    return found.slice(0, 3)
  }

  fitNotification(items) {
    const maxChars = Math.max(600, Number(this.store.effectiveSettings('').notifyMaxChars) || 5000)
    const lines = items.map(item => item.line.slice())
    let text = lines.join('\n')
    if (text.length <= maxChars) return text
    for (let i = lines.length - 1; i >= 0 && text.length > maxChars; i -= 1) {
      if (!items[i].inline) continue
      items[i].line = items[i].longLine
      lines[i] = items[i].line
      text = lines.join('\n')
    }
    while (lines.length > 1 && text.length > maxChars) { lines.pop(); text = lines.join('\n') }
    return text.length <= maxChars ? text : truncateText(text, maxChars)
  }

  async readyNotifications() {
    const settings = this.store.effectiveSettings('')
    const maxBatches = Math.max(1, Number(settings.notifyMaxBatches || 8))
    const ready = []
    const now = nowMs()
    for (const chat of this.store.bufferedChats()) {
      const chatKey = `${chat.chat_type}:${chat.peer_id}`
      const s = this.store.effectiveSettings(chatKey)
      if (s.whitelistEnabled && !this.store.isWhitelisted(chatKey, this.ownerId) && chatKey !== `private:${this.ownerId}`) continue
      if (s.dnd === 'all') continue
      const countReady = Number(chat.count) >= Number(s.countMessages || 5)
      const silenceReady = now - Number(chat.last_at || 0) >= Number(s.silenceSeconds || 0) * 1000
      const waitReady = now - Number(chat.first_at || 0) >= Number(s.maxWaitSeconds || 0) * 1000
      if (!(countReady || silenceReady || waitReady)) continue
      if (s.dnd === 'at') {
        const rows = this.store.peekBuffered(chat.chat_type, chat.peer_id, 100)
        if (!rows.some(row => this.isDirect(row, chat.chat_type, chat.peer_id))) continue
      }
      ready.push(chat)
    }
    const out = []
    let remaining = maxBatches
    for (const chat of ready) {
      if (remaining <= 0) break
      const s = this.store.effectiveSettings(`${chat.chat_type}:${chat.peer_id}`)
      const name = this.store.conversation(chat.chat_type, chat.peer_id)?.name || chat.peer_id
      const receipt = this.store.createReceipt(chat.chat_type, chat.peer_id, chat.group_id, name, 10)
      if (!receipt) continue
      remaining -= 1
      const line = await this.renderer.notificationLine(receipt, Number(s.inlineThreshold || 360))
      const long = await this.renderer.notificationLine(receipt, Number(s.inlineThreshold || 360), { forceLong: true })
      out.push({ receipt, inline: line.inline, line: line.line, longLine: long.line })
    }
    for (const chat of ready) {
      while (remaining > 0) {
        const s = this.store.effectiveSettings(`${chat.chat_type}:${chat.peer_id}`)
        if (s.dnd === 'all') break
        const name = this.store.conversation(chat.chat_type, chat.peer_id)?.name || chat.peer_id
        const receipt = this.store.createReceipt(chat.chat_type, chat.peer_id, chat.group_id, name, 10)
        if (!receipt) break
        remaining -= 1
        const line = await this.renderer.notificationLine(receipt, Number(s.inlineThreshold || 360))
        const long = await this.renderer.notificationLine(receipt, Number(s.inlineThreshold || 360), { forceLong: true })
        out.push({ receipt, inline: line.inline, line: line.line, longLine: long.line })
      }
    }
    const hinted = new Set()
    for (const item of out) {
      const stats = this.store.getChatStats(item.receipt.chat_type, item.receipt.peer_id)
      if (Number(stats.silent_streak || 0) >= 3 && now - Number(stats.last_hint_at || 0) >= 3600_000 && !hinted.has(item.receipt.peer_id)) {
        hinted.add(item.receipt.peer_id)
        const hint = '\n提示：可使用 qq_settings 设置免打扰(off/at/all)或减少通知。'
        item.line += hint; item.longLine += hint
      }
    }
    return out
  }

  isDirect(msg, chatType, peerId) {
    if (chatType === 'private') return true
    if (String(msg.sender_id) === this.selfId) return false
    for (const segment of msg.segments || []) {
      if (segment.type === 'at' && (String(segment.qq) === this.selfId || String(segment.qq) === 'all')) return true
      if (segment.type === 'reply' && segment.targetId) {
        const target = this.store.findByProtocol(chatType, peerId, segment.targetId)
        if (target && (target.origin === 'dsh' || String(target.sender_id) === this.selfId)) return true
      }
    }
    return false
  }

  async sendBacklogSummary(agent) {
    const settings = this.store.effectiveSettings('')
    const maxBatches = Math.max(1, Math.min(20, Number(settings.notifyMaxBatches || 8)))
    let budget = maxBatches
    for (const chat of this.store.bufferedChats()) {
      while (budget > 0) {
        const name = this.store.conversation(chat.chat_type, chat.peer_id)?.name || chat.peer_id
        const receipt = this.store.createReceipt(chat.chat_type, chat.peer_id, chat.group_id, name, 10)
        if (!receipt) break
        budget -= 1
      }
      if (budget <= 0) break
    }
    const summaries = this.store.unprocessedChats()
    if (summaries.length === 0) return false
    const receiptRows = this.store.unprocessedReceipts(1000)
    const byChat = new Map()
    for (const row of receiptRows) {
      const key = `${row.chat_type}:${row.peer_id}`
      if (!byChat.has(key)) byChat.set(key, [])
      byChat.get(key).push(row.receipt)
    }
    let total = 0
    for (const row of summaries) total += Number(row.batches)
    const buffered = this.store.bufferedChats()
    const bufferedByChat = new Map(buffered.map(row => [`${row.chat_type}:${row.peer_id}`, Number(row.count)]))
    const lines = [`[QQ backlog] ${summaries.length}个对话 ${total}个未处理批；按需 qq_receive，或询问 DSH 用户。本条为积压摘要，不逐批唤醒。`]
    for (const row of summaries) {
      const key = `${row.chat_type}:${row.peer_id}`
      const name = cleanName(this.store.conversation(row.chat_type, row.peer_id)?.name || row.peer_id)
      const kind = row.chat_type === 'group' ? 'group' : 'private'
      const refs = byChat.get(key) || []
      const shown = refs.slice(0, 10).join(',')
      const more = refs.length > 10 ? `,…(${refs.length})` : ''
      const extra = bufferedByChat.get(key) ? ` 另${bufferedByChat.get(key)}条缓冲中` : ''
      lines.push(`${kind}=${name}(${row.peer_id}) ${Number(row.batches)}批 ${shown}${more}${extra}`)
    }
    for (const row of receiptRows) this.store.markReceiptNotified(row.receipt)
    const text = truncateText(lines.join('\n'), Math.max(600, Number(settings.notifyMaxChars || 5000)))
    try { this.deliverWake(agent, text); return true }
    catch (error) { this.log('error', `QQ 积压通知投递失败: ${error.message}`); return false }
  }
  async housekeeping() {
    if (!this.store) return
    const settings = this.store.effectiveSettings('')
    this.store.purgeExpiredWhitelist()
    this.store.expireReceipts(Math.max(1, Number(settings.receiptRetentionDays || 14)) * 24 * 3600 * 1000)
    this.store.pruneReceipts(Number(settings.receiptMax || 2000))
    this.store.deleteMessages(this.store.messagesOlderThan(
      Date.now() - Math.max(1, Number(settings.messageRetentionDays || 30)) * 24 * 3600 * 1000,
      Math.max(100, Number(settings.messageMaxPerChat || 2000)),
    ))
    await this.media?.prune(Number(settings.mediaRetentionDays || 30), Number(settings.cacheMaxMb || 1024))
    this.store.setMeta('lastHousekeepingAt', String(Date.now()))
  }

  parseIncomingSegments(event) {
    let raw = event.message
    if ((raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) && typeof event.raw_message === 'string') raw = event.raw_message
    const segments = Array.isArray(raw) ? raw : (typeof raw === 'string' ? parseCQString(raw) : [])
    const out = []
    for (const segment of segments) {
      const type = String(segment?.type || '')
      const data = segment?.data || {}
      switch (type) {
        case 'text': out.push({ type: 'text', text: String(data.text ?? '') }); break
        case 'at': out.push({ type: 'at', qq: String(data.qq ?? '') }); break
        case 'reply': out.push({ type: 'reply', targetId: data.id == null ? '' : String(data.id) }); break
        case 'image': out.push({ type: 'image', raw: data }); break
        case 'mface': case 'marketface': out.push({ type: 'sticker', raw: data }); break
        case 'record': case 'voice': out.push({ type: 'record', raw: data }); break
        case 'video': out.push({ type: 'video', raw: data }); break
        case 'file': out.push({ type: 'file', raw: data, name: String(data.name || data.file_name || 'file') }); break
        case 'forward': case 'node': out.push({ type: 'forward', raw: data, protocolId: String(data.id || data.forward_id || '') }); break
        case 'json': case 'xml': {
          const card = cardText(segment)
          out.push({ type: 'card', title: card.title, summary: card.summary })
          break
        }
        case 'poke': out.push({ type: 'poke', qq: String(data.qq || data.user_id || data.target_id || '') }); break
        case 'dice': out.push({ type: 'dice', value: Number(data.result ?? data.value ?? 0) }); break
        case 'rps': out.push({ type: 'rps', value: String(data.result ?? data.value ?? '') }); break
        case 'face': case 'bface': case 'sface': out.push({ type: 'unknown', typeName: type, raw: data }); break
        default: out.push({ type: 'unknown', typeName: type || 'unknown', raw: data })
      }
    }
    return out
  }

  async handleEvent(event) {
    if (!event || typeof event !== 'object') return
    if (event.self_id && !this.selfId) this.selfId = String(event.self_id)
    if (event.post_type === 'message' || event.post_type === 'message_sent') return this.handleMessageEvent(event)
    if (event.post_type === 'notice') return this.handleNotice(event)
  }

  async handleMessageEvent(event) {
    if (!this.store) {
      const sid = String(event.self_id || this.selfId || this.config.account || '')
      if (!sid) return
      this.openStore(sid)
    }
    if (event.self_id && String(event.self_id) !== this.store.account) {
      this.log('warn', `忽略其他账号 ${event.self_id} 的消息`)
      return
    }
    const selfId = String(event.self_id || this.selfId || this.store.account)
    if (selfId && selfId !== this.selfId) {
      this.selfId = selfId
      this.renderer?.setIdentity({ selfId, ownerId: this.ownerId })
    }
    const messageType = String(event.message_type || (event.group_id ? 'group' : 'private'))
    const isGroup = messageType === 'group'
    const senderId = String(event.user_id ?? event.sender?.user_id ?? event.target_id ?? '')
    const isSelf = senderId === selfId || event.post_type === 'message_sent'
    const peerId = isGroup ? String(event.group_id) : String(isSelf ? (event.target_id || event.user_id || senderId) : (event.user_id || event.target_id || ''))
    if (!peerId) return
    const chatType = isGroup ? 'group' : 'private'
    const groupId = isGroup ? String(event.group_id) : (event.sub_type === 'group' || event.group_id ? String(event.group_id || '') : null)
    const messageId = event.message_id == null ? '' : String(event.message_id)
    const existing = messageId ? this.store.findByProtocol(chatType, peerId, messageId) : null
    if (existing) {
      if (existing.origin === 'dsh' || isSelf) this.store.stmt('UPDATE messages SET raw_event=?,recalled=? WHERE row_id=?').run(jsonText(event), event.recalled ? 1 : 0, existing.row_id)
      return
    }
    const sender = event.sender || {}
    const nickname = cleanName(sender.nickname || event.sender_name || '')
    const card = cleanName(sender.card || '')
    const segments = this.parseIncomingSegments(event)
    const ts = Number(event.time ? event.time * 1000 : Date.now())
    const origin = isSelf ? 'self-external' : 'incoming'
    let msg = this.store.insertMessage({
      chatType, peerId, groupId, messageId, messageSeq: event.message_seq, realId: event.real_id, senderId,
      senderNickname: nickname, senderCard: card, direction: isSelf ? 'out' : 'in', origin,
      ts, segments, rawEvent: event, bufferState: 'history',
    })
    if (!msg) return
    this.store.rememberUser(senderId, nickname, card)
    let groupName = event.group_name || this.store.conversation(chatType, peerId)?.name || ''
    const lastLookup = Number(this.groupNameAttempts.get(peerId) || 0)
    if (isGroup && (!groupName || groupName === peerId) && Date.now() - lastLookup > 5 * 60_000) {
      this.groupNameAttempts.set(peerId, Date.now())
      try {
        const info = await this.client.action('get_group_info', { group_id: Number(peerId) })
        groupName = cleanName(info?.group_name || info?.name || '')
      } catch {}
    }
    if (isGroup) this.store.upsertConversation(chatType, peerId, groupId, groupName || peerId, ts)
    else if (!isSelf) this.store.upsertConversation(chatType, peerId, groupId, card || nickname || senderId, ts)
    const finalSegments = []
    for (const segment of segments) {
      if (!segment.raw) { finalSegments.push(segment); continue }
      if (segment.type === 'forward') {
        const forward = this.store.insertForward(null, segment.protocolId, msg.row_id, segment.raw?.content ?? null, segment.raw?.content ? 'ready' : 'pending')
        finalSegments.push({ type: 'forward', ref: forward.ref })
      } else if (['image', 'sticker', 'record', 'video', 'file'].includes(segment.type)) {
        const data = segment.type === 'file' && groupId ? { ...segment.raw, group_id: groupId, busid: segment.raw?.busid } : segment.raw
        const sourceSegment = { type: segment.type === 'sticker' ? 'mface' : segment.type, data }
        const media = this.media.register(msg.row_id, sourceSegment, { auto: true })
        const item = { type: segment.type, mediaRef: media.ref }
        if (segment.type === 'file') item.name = segment.name
        finalSegments.push(item)
      } else finalSegments.push(segment)
    }
    this.store.stmt('UPDATE messages SET segments=? WHERE row_id=?').run(jsonText(finalSegments), msg.row_id)
    msg = this.store.findMessageByRowId(msg.row_id)
    const chatKey = `${chatType}:${peerId}`
    const settings = this.store.effectiveSettings(chatKey)
    if (!isSelf && chatType === 'private' && this.ownerId && senderId === this.ownerId) {
      const text = textOfSegments(finalSegments).trim()
      if (await this.handleOwnerConfirmation(text)) {
        this.store.stmt('UPDATE messages SET buffer_state=? WHERE row_id=?').run('history', msg.row_id)
        return
      }
    }
    const allowed = !settings.whitelistEnabled || this.store.isWhitelisted(chatKey, this.ownerId) || chatKey === `private:${this.ownerId}`
    if (!allowed) {
      this.store.stmt('UPDATE messages SET buffer_state=? WHERE row_id=?').run('blocked', msg.row_id)
      return
    }
    this.store.enqueueBuffer(msg)
    this.schedulePump()
  }

  async handleOwnerConfirmation(text) {
    const match = /^(同意|拒绝)\s+([0-9a-f]{8})$/u.exec(String(text || '').trim())
    if (!match) return false
    this.store.purgeExpiredWhitelist()
    const pending = this.store.getPendingWhitelist(match[2])
    if (!pending) {
      await this.sendSystemText(`private:${this.ownerId}`, '确认编号不存在或已过期。')
      return true
    }
    const list = this.store.listWhitelist()
    let reply
    if (match[1] === '同意') {
      if (pending.action === 'add') { if (!list.includes(pending.scope)) list.push(pending.scope); reply = `已加入白名单：${pending.scope}` }
      else { const index = list.indexOf(pending.scope); if (index >= 0) list.splice(index, 1); reply = `已移出白名单：${pending.scope}` }
      this.store.setWhitelist(list)
    } else reply = `已拒绝：${pending.scope}`
    this.store.deletePendingWhitelist(match[2])
    await this.sendSystemText(`private:${this.ownerId}`, reply)
    return true
  }

  async handleNotice(event) {
    if (!this.store) return
    const type = String(event.notice_type || '')
    if (type.includes('recall')) {
      const chatType = String(event.group_id ? 'group' : 'private')
      const peerId = String(event.group_id || event.user_id || '')
      const messageId = event.message_id == null ? '' : String(event.message_id)
      if (peerId && messageId) this.store.recallMessage(chatType, peerId, messageId)
      return
    }
    if (type === 'notify' && String(event.sub_type || '') === 'poke') {
      const groupId = event.group_id ? String(event.group_id) : null
      await this.handleMessageEvent({
        post_type: 'message', message_type: groupId ? 'group' : 'private', self_id: event.self_id,
        group_id: groupId || undefined, user_id: event.user_id, target_id: event.target_id,
        message_id: event.message_id || `poke-${event.time || Date.now()}-${event.user_id}`,
        time: event.time, sender: event.sender || { user_id: event.user_id },
        message: [{ type: 'poke', data: { qq: event.target_id || event.self_id } }],
      })
      return
    }
    if (['group_ban', 'group_decrease', 'group_dismiss', 'group_kick'].includes(type)) {
      this.log('warn', `QQ 群状态事件 ${type}`, event)
      return
    }
    if (type === 'offline_file' && event.file) {
      await this.handleMessageEvent({
        post_type: 'message', message_type: 'private', self_id: event.self_id,
        user_id: event.user_id, message_id: event.file.id || `offline-${Date.now()}`,
        time: event.time, sender: { user_id: event.user_id },
        message: [{ type: 'file', data: { file_id: event.file.id, name: event.file.name, size: event.file.size, url: event.file.url } }],
      })
    }
  }

  async fetchMessage(chatType, peerId, messageId) {
    try {
      const data = await this.client.action('get_msg', { message_id: Number.isNaN(Number(messageId)) ? messageId : Number(messageId) })
      if (!data) return null
      const participant = String(data.sender?.user_id || data.user_id || '')
      const row = this.store.insertMessage({
        chatType, peerId, groupId: chatType === 'group' ? peerId : null, messageId: String(data.message_id || messageId),
        messageSeq: data.message_seq, realId: data.real_id, senderId: participant, senderNickname: data.sender?.nickname || '', senderCard: data.sender?.card || '',
        direction: participant === this.selfId ? 'out' : 'in', origin: participant === this.selfId ? 'self-external' : 'incoming',
        ts: Number(data.time || 0) * 1000 || Date.now(), segments: this.parseIncomingSegments({ message: data.message ?? [] }),
        rawEvent: data, bufferState: 'history',
      })
      return row
    } catch { return null }
  }

  async ensureReplyId(chatType, peerId, reply, receipt = null) {
    if (reply === undefined || reply === null || reply === '') return ''
    if (typeof reply === 'number' || /^\d+$/u.test(String(reply))) {
      const pos = Number(reply)
      if (receipt) {
        const item = receipt.items.find(entry => entry.pos === pos)
        if (!item) throw new Error(`receipt 中没有编号 ${pos}`)
        if (item.message.message_id != null) return String(item.message.message_id)
        throw new Error(`receipt#${pos} 没有可引用的协议消息ID`)
      }
      throw new Error('target 发送时 reply 必须是历史消息 ref')
    }
    const parsed = parseReceiptRef(reply)
    let message = null
    if (parsed?.receipt) {
      const rec = this.store.getReceipt(parsed.receipt)
      if (!rec) throw new Error('reply 指向的 receipt 不存在')
      message = rec.items.find(item => item.pos === parsed.pos)?.message ?? null
    } else message = this.store.findMessageByRef(String(reply))
    if (!message) throw new Error('reply 指向的消息不存在')
    if (message.message_id == null) throw new Error('该消息没有可引用的协议消息ID')
    return String(message.message_id)
  }

  async prepareOutgoing(content) {
    const items = typeof content === 'string' ? [{ text: content }]
      : Array.isArray(content) ? content : (content && typeof content === 'object' ? [content] : [])
    if (items.length === 0) throw new Error('content 必须是非空字符串、对象或数组')
    const chunks = []
    let current = []
    let internal = []
    const pushChunk = () => {
      if (current.length || internal.length) chunks.push({ onebot: current, internal })
      current = []; internal = []
    }
    const addText = text => {
      const value = String(text ?? '')
      if (!value) return
      current.push({ type: 'text', data: { text: value } })
      internal.push({ type: 'text', text: value })
    }
    for (const item of items) {
      if (item == null) continue
      if (typeof item === 'string') { addText(item); continue }
      if (Array.isArray(item)) {
        for (const nested of item) addText(typeof nested === 'string' ? nested : jsonText(nested))
        continue
      }
      if (item.split === true) { pushChunk(); continue }
      if (item.text !== undefined) { addText(item.text); continue }
      if (item.at !== undefined) {
        const qq = item.at === 'self' ? this.selfId : String(item.at)
        current.push({ type: 'at', data: { qq } }); internal.push({ type: 'at', qq }); continue
      }
      if (item.reply !== undefined) {
        const id = await this.resolveOutgoingReply(item.reply)
        if (id) { current.push({ type: 'reply', data: { id } }); internal.push({ type: 'reply', targetId: id }) }
        continue
      }
      if (item.image !== undefined || item.sticker !== undefined || item.record !== undefined || item.video !== undefined || item.file !== undefined) {
        const kind = item.image !== undefined ? 'image' : item.sticker !== undefined ? 'sticker' : item.record !== undefined ? 'record' : item.video !== undefined ? 'video' : 'file'
        const value = item.image ?? item.sticker ?? item.record ?? item.video ?? item.file
        const media = await this.resolveOutgoingMedia(kind, value, item.name)
        if (kind === 'image') { current.push({ type: 'image', data: { file: media.file } }); internal.push({ type: 'image', mediaRef: media.ref }) }
        else if (kind === 'sticker') { current.push({ type: 'image', data: { file: media.file, sub_type: 1, summary: '[动画表情]' } }); internal.push({ type: 'sticker', mediaRef: media.ref }) }
        else if (kind === 'record') { current.push({ type: 'record', data: { file: media.file } }); internal.push({ type: 'record', mediaRef: media.ref }) }
        else if (kind === 'video') { current.push({ type: 'video', data: { file: media.file } }); internal.push({ type: 'video', mediaRef: media.ref }) }
        else { current.push({ type: 'file', data: { file: media.file, name: media.name || item.name || 'file' } }); internal.push({ type: 'file', mediaRef: media.ref, name: media.name || item.name || 'file' }) }
        continue
      }
      if (item.face !== undefined) { current.push({ type: 'face', data: { id: String(item.face) } }); internal.push({ type: 'unknown', typeName: 'face' }); continue }
      addText(jsonText(item))
    }
    pushChunk()
    const filtered = chunks.filter(chunk => chunk.onebot.length > 0)
    if (filtered.length === 0) throw new Error('content 没有可发送的段落')
    return { chunks: filtered }
  }

  async resolveOutgoingReply(value) {
    if (typeof value === 'number' || /^\d+$/u.test(String(value))) return String(value)
    const parsed = parseReceiptRef(value)
    if (parsed?.receipt) {
      const rec = this.store.getReceipt(parsed.receipt)
      if (!rec) throw new Error('reply 指向的 receipt 不存在')
      const msg = rec.items.find(item => item.pos === parsed.pos)?.message
      if (!msg?.message_id) throw new Error('reply 指向的消息没有协议ID')
      return String(msg.message_id)
    }
    const msg = this.store.findMessageByRef(String(value))
    if (!msg?.message_id) throw new Error('reply 指向的消息不存在或没有协议ID')
    return String(msg.message_id)
  }

  async resolveOutgoingMedia(kind, value, name) {
    const raw = String(value ?? '')
    if (raw.startsWith('media:')) {
      const media = await this.media.ensure(raw)
      if (!media?.local_path) throw new Error(`媒体不可用：${media?.status || 'missing'} ${media?.error || ''}`.trim())
      return { file: toFileUrl(media.local_path), ref: media.ref, name: media.name || name || path.basename(media.local_path) }
    }
    if (isHttpUrl(raw)) {
      const media = this.store.insertMedia({ kind, remoteUrl: raw, name: name || path.basename(new URL(raw).pathname), mime: mimeForName(name || raw), status: 'remote' })
      return { file: raw, ref: media.ref, name: name || media.name }
    }
    const local = raw.startsWith('file://') ? decodeURIComponent(new URL(raw).pathname).replace(/^\/([A-Za-z]:)/u, '$1') : raw
    const absolute = path.resolve(local)
    const allowed = this.allowedUploadPaths().some(root => {
      const rel = path.relative(root, absolute)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    })
    if (!allowed) throw new Error('文件路径不在允许上传目录内；可用 qq_settings 修改 uploadDirs')
    if (!fs.existsSync(absolute)) throw new Error(`文件不存在：${absolute}`)
    const stat = fs.statSync(absolute)
    if (!stat.isFile()) throw new Error(`不是文件：${absolute}`)
    const media = this.store.insertMedia({ kind, localPath: absolute, name: name || path.basename(absolute), mime: mimeForName(absolute), size: stat.size, status: 'downloaded' })
    return { file: toFileUrl(absolute), ref: media.ref, name: name || path.basename(absolute) }
  }

  allowedUploadPaths() {
    const settings = this.store.effectiveSettings('')
    const dirs = Array.isArray(settings.uploadDirs) && settings.uploadDirs.length > 0 ? settings.uploadDirs : [os.homedir()]
    return dirs.map(dir => path.resolve(String(dir))).filter(dir => fs.existsSync(dir))
  }

  async sendOne(chatType, peerId, groupId, segments, replyId = '') {
    const message = []
    if (replyId) message.push({ type: 'reply', data: { id: String(replyId) } })
    message.push(...segments)
    let data
    if (chatType === 'group') data = await this.client.action('send_group_msg', { group_id: Number(peerId), message })
    else if (groupId) data = await this.client.action('send_msg', { message_type: 'private', user_id: Number(peerId), group_id: Number(groupId), message })
    else data = await this.client.action('send_private_msg', { user_id: Number(peerId), message })
    const messageId = data?.message_id ?? data?.messageId ?? data?.data?.message_id
    return messageId == null ? '' : String(messageId)
  }

  recordOutgoing(chatType, peerId, groupId, internalSegments, messageId) {
    const msg = this.store.insertMessage({
      chatType, peerId, groupId, messageId: messageId || null, senderId: this.selfId || this.accountId,
      senderNickname: '', senderCard: '', direction: 'out', origin: 'dsh', ts: Date.now(), segments: internalSegments,
      rawEvent: { source: 'dsh', segments: internalSegments }, bufferState: 'history',
    })
    if (msg) this.store.markDshSent(msg.row_id, messageId)
    return msg
  }

  async sendContent(chatType, peerId, groupId, content, replyId = '') {
    const settings = this.store.effectiveSettings(`${chatType}:${peerId}`)
    const prepared = await this.prepareOutgoing(content)
    let sent = 0
    let lastId = ''
    for (let index = 0; index < prepared.chunks.length; index += 1) {
      const chunk = prepared.chunks[index]
      try {
        lastId = await this.sendOne(chatType, peerId, groupId, chunk.onebot, index === 0 ? replyId : '')
        this.recordOutgoing(chatType, peerId, groupId, chunk.internal, lastId)
        sent += 1
      } catch (error) {
        this.log('error', `QQ 发送失败: ${error.message}`, { action: 'send', chatType, peerId })
        const wrapped = new Error(`发送失败（已发送 ${sent} 条）：${error.message}`)
        wrapped.code = error.code; wrapped.sent = sent
        throw wrapped
      }
      if (index < prepared.chunks.length - 1) await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(settings.splitDelayMs || 700))))
    }
    this.store.resetSilent(chatType, peerId)
    return { sent, messageId: lastId }
  }

  async sendSystemText(target, text) {
    const parsed = parseTarget(target)
    if (!parsed) return false
    try {
      const messageId = await this.sendOne(parsed.kind, parsed.id, null, [{ type: 'text', data: { text: String(text) } }])
      this.recordOutgoing(parsed.kind, parsed.id, null, [{ type: 'text', text: String(text) }], messageId)
      return true
    } catch (error) { this.log('error', `系统 QQ 消息发送失败: ${error.message}`); return false }
  }

  async receive(args = {}, agent) {
    this.ensureHolder(agent)
    if (args.receipt) {
      const parsed = parseReceiptRef(args.receipt)
      const receipt = parsed?.receipt ? this.store.getReceipt(parsed.receipt) : null
      if (!receipt) throw new Error('receipt 不存在')
      if (receipt.state === 'expired') return { active: false, receipt: receipt.receipt, reason: 'receipt 已过期' }
      const full = await this.renderer.renderBatch(receipt)
      if (receipt.state === 'unprocessed') this.store.markReceiptState(receipt.receipt, 'read')
      return full
    }
    if (args.target) {
      const target = parseTarget(args.target)
      if (!target) throw new Error('target 使用 group:123 或 private:123')
      const effective = this.store.effectiveSettings(target.key)
      if (effective.whitelistEnabled && !this.store.isWhitelisted(target.key, this.ownerId) && target.key !== `private:${this.ownerId}`) throw new Error('该对话不在白名单')
      const n = Math.max(1, Math.min(Number(effective.historyMax || 50), Number(args.n || effective.historyDefault || 20)))
      const before = args.before ? this.store.findMessageByRef(String(args.before))?.row_id : undefined
      const rows = this.store.recentMessages(target.kind, target.id, n, before ?? null)
      const messages = []
      for (const row of rows) {
        if (row.buffer_state === 'blocked') continue
        const content = compactPreview(await this.renderer.renderContent(row, new Map()), 700)
        messages.push({
          ref: row.receipt && row.receipt_pos ? `${row.receipt}#${row.receipt_pos}` : row.msg_ref,
          time: formatClock(row.ts, true),
          from: row.direction === 'out' ? (row.origin === 'dsh' ? 'self(dsh)' : 'self') : cleanName(row.sender_card || row.sender_nickname || row.sender_id),
          ...(row.recalled ? { recalled: true } : {}),
          content,
        })
      }
      return {
        target: target.key, name: cleanName(this.store.conversation(target.kind, target.id)?.name || target.id),
        messages, ...(messages.length >= n ? { more: true } : {}),
      }
    }
    const receipts = this.store.unprocessedReceipts(50).map(row => ({
      receipt: row.receipt, target: `${row.chat_type}:${row.peer_id}`,
      name: cleanName(this.store.conversation(row.chat_type, row.peer_id)?.name || row.name || row.peer_id),
      count: row.message_count, time: formatClock(row.last_ts, true),
    }))
    const pending = this.store.bufferedChats().map(row => ({
      target: `${row.chat_type}:${row.peer_id}`,
      name: cleanName(this.store.conversation(row.chat_type, row.peer_id)?.name || row.peer_id),
      count: Number(row.count), oldest: Math.floor(Number(row.first_at) / 1000),
    }))
    return { receipts, pending }
  }

  async send(args = {}, agent) {
    this.ensureHolder(agent)
    const hasReceipt = !!args.receipt
    const hasTarget = !!args.target
    if (hasReceipt === hasTarget) throw new Error('target 与 receipt 必须二选一')
    let chatType, peerId, groupId = null, receipt = null
    if (hasReceipt) {
      const parsed = parseReceiptRef(args.receipt)
      receipt = parsed?.receipt ? this.store.getReceipt(parsed.receipt) : null
      if (!receipt) throw new Error('receipt 不存在')
      if (receipt.state === 'expired') throw new Error('receipt 已过期')
      chatType = receipt.chat_type; peerId = receipt.peer_id; groupId = receipt.group_id
      if (!args.content || (Array.isArray(args.content) && args.content.length === 0)) {
        this.store.markReceiptState(receipt.receipt, 'silent')
        this.store.bumpSilent(chatType, peerId, 1)
        return { ok: true, receipt: receipt.receipt, state: 'silent' }
      }
    } else {
      const target = parseTarget(args.target)
      if (!target) throw new Error('target 使用 group:123 或 private:123')
      chatType = target.kind; peerId = target.id
      if (!args.content) throw new Error('主动发送必须提供 content')
      const effective = this.store.effectiveSettings(target.key)
      if (effective.whitelistEnabled && !this.store.isWhitelisted(target.key, this.ownerId) && target.key !== `private:${this.ownerId}`) throw new Error('该对话不在白名单')
    }
    const replyId = await this.ensureReplyId(chatType, peerId, args.reply, receipt)
    const result = await this.sendContent(chatType, peerId, groupId, args.content, replyId)
    if (receipt) this.store.markReceiptState(receipt.receipt, 'replied')
    return { ok: true, ...result, ...(receipt ? { receipt: receipt.receipt, state: 'replied' } : {}) }
  }

  async ref(args = {}, agent) {
    this.ensureHolder(agent)
    const ref = String(args.ref || '').trim()
    if (!ref) return { media: this.store.recentMedia(20).map(row => ({ ref: row.ref, kind: row.kind, status: row.status, name: row.name, size: row.size })) }
    if (ref.startsWith('media:')) {
      const media = await this.media.ensure(ref)
      return {
        ref, kind: media.kind, status: media.status,
        ...(media.local_path ? { path: media.local_path } : {}), ...(media.name ? { name: media.name } : {}),
        ...(media.size ? { size: media.size } : {}), ...(media.mime ? { mime: media.mime } : {}), ...(media.error ? { error: media.error } : {}),
      }
    }
    if (ref.startsWith('f:')) return this.expandForward(ref)
    if (ref.startsWith('gf:')) {
      const row = this.store.getGroupFile(ref)
      if (!row) throw new Error('群文件 ref 不存在')
      return { ref, group: row.group_id, file_id: row.file_id, name: row.name, size: row.size }
    }
    let message = null
    const receiptRef = parseReceiptRef(ref)
    if (receiptRef?.receipt) {
      const receipt = this.store.getReceipt(receiptRef.receipt)
      if (!receipt) throw new Error('receipt 不存在')
      message = receipt.items.find(item => item.pos === receiptRef.pos)?.message ?? null
    } else message = this.store.findMessageByRef(ref)
    if (!message) throw new Error('ref 不存在')
    const content = await this.renderer.renderContent(message, new Map())
    const media = this.store.mediaByMessage(message.row_id).map(row => ({ ref: row.ref, kind: row.kind, status: row.status, name: row.name }))
    return {
      ref: message.receipt && message.receipt_pos ? `${message.receipt}#${message.receipt_pos}` : message.msg_ref,
      target: `${message.chat_type}:${message.peer_id}`, time: formatClock(message.ts, true),
      from: message.direction === 'out' ? (message.origin === 'dsh' ? 'self(dsh)' : 'self') : cleanName(message.sender_card || message.sender_nickname || message.sender_id),
      qq: String(message.sender_id || ''),
      content, ...(message.recalled ? { recalled: true } : {}), ...(media.length ? { media } : {}),
    }
  }

  async expandForward(ref) {
    let forward = this.store.getForward(ref)
    if (!forward) throw new Error('转发 ref 不存在')
    if (!forward.payload) {
      try {
        const data = await this.client.action('get_forward_msg', { id: forward.protocol_id || ref })
        forward = this.store.updateForward(ref, data?.messages ?? data?.message ?? [], 'ready')
      } catch (error) {
        this.store.updateForward(ref, null, 'failed')
        throw new Error(`转发内容获取失败：${error.message}`)
      }
    }
    const nodes = asArray(forward.payload)
    const out = []
    for (const node of nodes.slice(0, 50)) {
      const segments = this.parseIncomingSegments({ message: node.message ?? node.content ?? [] })
      const senderId = String(node.sender?.user_id ?? node.user_id ?? '')
      const name = cleanName(node.sender?.card || node.sender?.nickname || node.nickname || senderId)
      const rendered = []
      for (const segment of segments) {
        if (segment.type === 'forward') {
          const child = this.store.insertForward(null, segment.protocolId, null, segment.raw?.content ?? null, segment.raw?.content ? 'ready' : 'pending')
          rendered.push({ forward: child.ref })
        } else if (segment.raw && ['image', 'sticker', 'record', 'video', 'file'].includes(segment.type)) {
          const media = this.store.insertMedia({ kind: segment.type === 'sticker' ? 'sticker' : segment.type, source: segment.raw, remoteUrl: segment.raw?.url || '', name: segment.name, status: 'pending' })
          if (['image', 'sticker'].includes(media.kind)) this.media.enqueue(() => this.media.ensure(media.ref))
          rendered.push(segment.type === 'file' ? { file: media.ref, name: segment.name } : { [segment.type]: media.ref })
        } else if (segment.type === 'text') rendered.push(segment.text)
        else if (segment.type === 'at') rendered.push({ at: segment.qq })
        else if (segment.type === 'card') rendered.push({ card: [segment.title, segment.summary].filter(Boolean).join('：') })
        else if (segment.type === 'unknown') rendered.push({ unknown: segment.typeName })
      }
      out.push({ from: name, content: compactPreview(rendered.length === 1 ? rendered[0] : rendered, 600) })
    }
    return { ref, messages: out, ...(nodes.length > 50 ? { more: nodes.length - 50 } : {}) }
  }

  async receive(args = {}, agent) {
    this.ensureHolder(agent)
    if (args.receipt) {
      const parsed = parseReceiptRef(args.receipt)
      const receipt = parsed?.receipt ? this.store.getReceipt(parsed.receipt) : null
      if (!receipt) throw new Error('receipt 不存在')
      if (receipt.state === 'expired') return { active: false, receipt: receipt.receipt, reason: 'receipt 已过期' }
      const full = await this.renderer.renderBatch(receipt)
      if (receipt.state === 'unprocessed') this.store.markReceiptState(receipt.receipt, 'read')
      return full
    }
    if (args.target) {
      const target = parseTarget(args.target)
      if (!target) throw new Error('target 使用 group:123 或 private:123')
      const effective = this.store.effectiveSettings(target.key)
      if (effective.whitelistEnabled && !this.store.isWhitelisted(target.key, this.ownerId) && target.key !== `private:${this.ownerId}`) throw new Error('该对话不在白名单')
      const n = Math.max(1, Math.min(Number(effective.historyMax || 50), Number(args.n || effective.historyDefault || 20)))
      const before = args.before ? this.store.findMessageByRef(String(args.before))?.row_id : undefined
      const rows = this.store.recentMessages(target.kind, target.id, n, before ?? null)
      const messages = []
      for (const row of rows) {
        if (row.buffer_state === 'blocked') continue
        const rendered = await this.renderer.renderContent(row, new Map())
        const content = compactPreview(rendered, 700)
        messages.push({
          ref: row.receipt && row.receipt_pos ? `${row.receipt}#${row.receipt_pos}` : row.msg_ref,
          time: formatClock(row.ts, true),
          from: row.direction === 'out' ? (row.origin === 'dsh' ? 'self(dsh)' : 'self') : cleanName(row.sender_card || row.sender_nickname || row.sender_id),
          qq: String(row.sender_id || ''),
          ...(row.recalled ? { recalled: true } : {}),
          ...(content !== rendered ? { truncated: true } : {}),
          content,
        })
      }
      return { target: target.key, name: cleanName(this.store.conversation(target.kind, target.id)?.name || target.id), messages, ...(messages.length >= n ? { more: true } : {}) }
    }
    const receipts = this.store.unprocessedReceipts(50).map(row => ({
      receipt: row.receipt, target: `${row.chat_type}:${row.peer_id}`,
      name: cleanName(this.store.conversation(row.chat_type, row.peer_id)?.name || row.name || row.peer_id),
      count: row.message_count, time: formatClock(row.last_ts, true),
    }))
    const pending = this.store.bufferedChats().map(row => ({
      target: `${row.chat_type}:${row.peer_id}`,
      name: cleanName(this.store.conversation(row.chat_type, row.peer_id)?.name || row.peer_id),
      count: Number(row.count), oldest: Math.floor(Number(row.first_at) / 1000),
    }))
    return { receipts, pending }
  }

  async send(args = {}, agent) {
    this.ensureHolder(agent)
    const hasReceipt = !!args.receipt
    const hasTarget = !!args.target
    if (hasReceipt === hasTarget) throw new Error('target 与 receipt 必须二选一')
    let chatType, peerId, groupId = null, receipt = null
    if (hasReceipt) {
      const parsed = parseReceiptRef(args.receipt)
      receipt = parsed?.receipt ? this.store.getReceipt(parsed.receipt) : null
      if (!receipt) throw new Error('receipt 不存在')
      if (receipt.state === 'expired') throw new Error('receipt 已过期')
      chatType = receipt.chat_type; peerId = receipt.peer_id; groupId = receipt.group_id
      if (!args.content || (Array.isArray(args.content) && args.content.length === 0)) {
        this.store.markReceiptState(receipt.receipt, 'silent')
        this.store.bumpSilent(chatType, peerId, 1)
        return { ok: true, receipt: receipt.receipt, state: 'silent' }
      }
    } else {
      const target = parseTarget(args.target)
      if (!target) throw new Error('target 使用 group:123 或 private:123')
      chatType = target.kind; peerId = target.id
      if (!args.content) throw new Error('主动发送必须提供 content')
      const effective = this.store.effectiveSettings(target.key)
      if (effective.whitelistEnabled && !this.store.isWhitelisted(target.key, this.ownerId) && target.key !== `private:${this.ownerId}`) throw new Error('该对话不在白名单')
    }
    const replyId = await this.ensureReplyId(chatType, peerId, args.reply, receipt)
    const result = await this.sendContent(chatType, peerId, groupId, args.content, replyId)
    if (receipt) this.store.markReceiptState(receipt.receipt, 'replied')
    return { ok: true, ...result, ...(receipt ? { receipt: receipt.receipt, state: 'replied' } : {}) }
  }

  async ref(args = {}, agent) {
    this.ensureHolder(agent)
    const ref = String(args.ref || '').trim()
    if (!ref) return { media: this.store.recentMedia(20).map(row => ({ ref: row.ref, kind: row.kind, status: row.status, name: row.name, size: row.size })) }
    if (ref.startsWith('media:')) {
      const media = await this.media.ensure(ref)
      return {
        ref, kind: media.kind, status: media.status,
        ...(media.local_path ? { path: media.local_path } : {}), ...(media.name ? { name: media.name } : {}),
        ...(media.size ? { size: media.size } : {}), ...(media.mime ? { mime: media.mime } : {}), ...(media.error ? { error: media.error } : {}),
      }
    }
    if (ref.startsWith('f:')) return this.expandForward(ref)
    if (ref.startsWith('gf:')) {
      const row = this.store.getGroupFile(ref)
      if (!row) throw new Error('群文件 ref 不存在')
      return { ref, group: row.group_id, file_id: row.file_id, name: row.name, size: row.size }
    }
    let message = null
    const receiptRef = parseReceiptRef(ref)
    if (receiptRef?.receipt) {
      const receipt = this.store.getReceipt(receiptRef.receipt)
      if (!receipt) throw new Error('receipt 不存在')
      message = receipt.items.find(item => item.pos === receiptRef.pos)?.message ?? null
    } else message = this.store.findMessageByRef(ref)
    if (!message) throw new Error('ref 不存在')
    const content = await this.renderer.renderContent(message, new Map())
    const media = this.store.mediaByMessage(message.row_id).map(row => ({ ref: row.ref, kind: row.kind, status: row.status, name: row.name }))
    return {
      ref: message.receipt && message.receipt_pos ? `${message.receipt}#${message.receipt_pos}` : message.msg_ref,
      target: `${message.chat_type}:${message.peer_id}`, time: formatClock(message.ts, true),
      from: message.direction === 'out' ? (message.origin === 'dsh' ? 'self(dsh)' : 'self') : cleanName(message.sender_card || message.sender_nickname || message.sender_id),
      qq: String(message.sender_id || ''),
      content, ...(message.recalled ? { recalled: true } : {}), ...(media.length ? { media } : {}),
    }
  }

  async expandForward(ref) {
    let forward = this.store.getForward(ref)
    if (!forward) throw new Error('转发 ref 不存在')
    if (!forward.payload) {
      try {
        const data = await this.client.action('get_forward_msg', { id: forward.protocol_id || ref })
        forward = this.store.updateForward(ref, data?.messages ?? data?.message ?? [], 'ready')
      } catch (error) {
        this.store.updateForward(ref, null, 'failed')
        throw new Error(`转发内容获取失败：${error.message}`)
      }
    }
    const nodes = asArray(forward.payload)
    const out = []
    for (const node of nodes.slice(0, 50)) {
      const segments = this.parseIncomingSegments({ message: node.message ?? node.content ?? [] })
      const senderId = String(node.sender?.user_id ?? node.user_id ?? '')
      const name = cleanName(node.sender?.card || node.sender?.nickname || node.nickname || senderId)
      const rendered = []
      for (const segment of segments) {
        if (segment.type === 'forward') {
          const child = this.store.insertForward(null, segment.protocolId, null, segment.raw?.content ?? null, segment.raw?.content ? 'ready' : 'pending')
          rendered.push({ forward: child.ref })
        } else if (segment.raw && ['image', 'sticker', 'record', 'video', 'file'].includes(segment.type)) {
          const media = this.store.insertMedia({ kind: segment.type === 'sticker' ? 'sticker' : segment.type, source: segment.raw, remoteUrl: segment.raw?.url || '', name: segment.name, status: 'pending' })
          if (['image', 'sticker'].includes(media.kind)) this.media.enqueue(() => this.media.ensure(media.ref))
          rendered.push(segment.type === 'file' ? { file: media.ref, name: segment.name } : { [segment.type]: media.ref })
        } else if (segment.type === 'text') rendered.push(segment.text)
        else if (segment.type === 'at') rendered.push({ at: segment.qq })
        else if (segment.type === 'card') rendered.push({ card: [segment.title, segment.summary].filter(Boolean).join('：') })
        else if (segment.type === 'unknown') rendered.push({ unknown: segment.typeName })
      }
      out.push({ from: name, content: compactPreview(rendered.length === 1 ? rendered[0] : rendered, 600) })
    }
    return { ref, messages: out, ...(nodes.length > 50 ? { more: nodes.length - 50 } : {}) }
  }

  async files(args = {}, agent) {
    this.ensureHolder(agent)
    const groupId = String(args.group || '').replace(/^group:/u, '')
    if (!/^[1-9]\d{0,19}$/u.test(groupId)) throw new Error('group 使用群号')
    const groupSettings = this.store.effectiveSettings(`group:${groupId}`)
    if (groupSettings.whitelistEnabled && !this.store.isWhitelisted(`group:${groupId}`, this.ownerId)) throw new Error('该群不在白名单')
    let folderId = String(args.folder || '')
    let data
    if (folderId && !/^\//u.test(folderId)) {
      try {
        const root = await this.client.action('get_group_root_files', { group_id: Number(groupId) })
        const match = asArray(root?.folders).find(item => String(item.folder_name || item.name || '') === folderId)
        if (match) folderId = String(match.folder_id || match.id || '')
      } catch {}
    }
    if (folderId) data = await this.client.action('get_group_files_by_folder', { group_id: Number(groupId), folder_id: folderId })
    else data = await this.client.action('get_group_root_files', { group_id: Number(groupId) })
    const files = asArray(data?.files).map(file => {
      const ref = this.store.insertGroupFile({
        groupId, fileId: file.file_id || file.id, busid: file.busid ?? 102, name: file.file_name || file.name,
        size: file.file_size || file.size, uploader: file.uploader_name || file.uploader, uploadTime: (file.upload_time || 0) * 1000,
      })
      return {
        ref: ref.ref, name: cleanName(file.file_name || file.name), size: Number(file.file_size || file.size || 0),
        uploader: cleanName(file.uploader_name || file.uploader || ''), time: file.upload_time ? formatClock(Number(file.upload_time) * 1000, true) : '',
      }
    })
    const folders = asArray(data?.folders).map(folder => ({
      id: String(folder.folder_id || folder.id || ''), name: cleanName(folder.folder_name || folder.name),
      files: Number(folder.total_file_count || 0), time: folder.last_upload_time ? formatClock(Number(folder.last_upload_time) * 1000, true) : '',
    }))
    return { group: groupId, folder: folderId || '/', files: files.slice(0, 50), ...(files.length > 50 ? { more: files.length - 50 } : {}), folders: folders.slice(0, 50) }
  }

  async uploadFile(args = {}, agent) {
    this.ensureHolder(agent)
    const groupId = String(args.group || '').replace(/^group:/u, '')
    if (!/^[1-9]\d{0,19}$/u.test(groupId)) throw new Error('group 使用群号')
    const groupSettings = this.store.effectiveSettings(`group:${groupId}`)
    if (groupSettings.whitelistEnabled && !this.store.isWhitelisted(`group:${groupId}`, this.ownerId)) throw new Error('该群不在白名单')
    const filePath = path.resolve(String(args.path || ''))
    const allowed = this.allowedUploadPaths().some(root => {
      const rel = path.relative(root, filePath)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    })
    if (!allowed) throw new Error('文件路径不在允许上传目录内')
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error('上传文件不存在')
    const params = { group_id: Number(groupId), file: toFileUrl(filePath), name: args.name || path.basename(filePath) }
    if (args.folder) params.folder = String(args.folder)
    const data = await this.client.action('upload_group_file', params, 120000)
    return { ok: true, group: groupId, file_id: String(data?.file_id || data?.id || ''), name: args.name || path.basename(filePath) }
  }

  async downloadFile(args = {}, agent) {
    this.ensureHolder(agent)
    const groupId = String(args.group || '').replace(/^group:/u, '')
    if (!/^[1-9]\d{0,19}$/u.test(groupId)) throw new Error('group 使用群号')
    const groupSettings = this.store.effectiveSettings(`group:${groupId}`)
    if (groupSettings.whitelistEnabled && !this.store.isWhitelisted(`group:${groupId}`, this.ownerId)) throw new Error('该群不在白名单')
    let row = String(args.file || '').startsWith('gf:') ? this.store.getGroupFile(args.file) : this.store.findGroupFileByName(groupId, args.file)
    if (row && String(row.group_id) !== groupId) throw new Error('群文件 ref 与 group 不匹配')
    if (!row) {
      const listing = await this.files({ group: groupId }, agent)
      const match = listing.files.find(file => file.name === args.file)
      if (match) row = this.store.getGroupFile(match.ref)
    }
    if (!row) throw new Error('群文件不存在；请先用 qq_files 获取 file ref')
    const url = await this.client.action('get_group_file_url', { group_id: Number(groupId), file_id: row.file_id, busid: row.busid || 102 })
    const remote = url?.url || url?.file_url
    if (!remote) throw new Error('OneBot 未返回群文件下载地址')
    const settings = this.store.effectiveSettings('')
    const dir = path.resolve(settings.downloadDir || path.join(this.store.dir, 'downloads'))
    await fsp.mkdir(dir, { recursive: true })
    const saved = await this.media.saveRemoteTo(remote, safeFilename(row.name || row.file_id), dir)
    return { ok: true, group: groupId, name: row.name, path: saved.path, size: saved.size }
  }

  setupGuide() {
    const home = process.env.USERPROFILE || process.env.HOME || '.'
    const dshHome = process.env.DSH_HOME || path.join(home, '.dsh')
    const configPath = this.config.configFile || path.join(dshHome, 'qq-plugin', 'config.json')
    const connection = this.client?.getState?.() ?? { connected: false }
    const tokenConfigured = Boolean(this.config?.onebot?.accessToken)
    return {
      title: 'QQ/OneBot service quick start (Windows)',
      supported: ['SnowLuma 2.x', 'NapCat / OneBot 11'],
      connection: { ...connection, accessTokenConfigured: tokenConfigured },
      installLocationPolicy: {
        askBeforeExtract: true,
        askOnce: true,
        askLanguage: 'Use the same language as the user.',
        requiredQuestions: [
          'In the user language, ask once where SnowLuma/NapCat should be installed or extracted.',
          'Accept a user-supplied path or a vague preference such as another drive or anywhere outside C:.',
          'If the user delegates the choice, pick one reasonable writable directory that matches the stated preference and proceed without repeatedly asking.',
        ],
        ifUserHasNoPreference: 'You may choose a sensible user-owned location such as %LOCALAPPDATA%/SnowLuma, or another drive when the user asked for one. Resolve the path yourself; do not require the user to provide an absolute path.',
        onlyAskAgainWhen: [
          'The chosen directory is not writable.',
          'An existing installation/data conflict requires a user decision.',
        ],
        avoid: [
          'The DSH workspace: files may inherit Low Integrity and fail to inject into Medium-integrity QQ.',
          'C:/Program Files: usually needs elevation and can complicate updates.',
        ],
        checks: [
          'Resolve the selected path to an absolute path internally.',
          'Check free space and write permission.',
          'Keep the directory outside the DSH workspace.',
        ],
      },
      afterReboot: [
        'DSH loads the installed plugin automatically; do not reinstall it.',
        'Sign in to QQNT if it did not auto-login.',
        'Launch SnowLuma launcher.bat or the NapCat startup script; these services do not start themselves after a reboot.',
        'Open the SnowLuma WebUI and load/inject the running QQ process again.',
        'Wait for the plugin WebSocket to reconnect, or call qq_setup action=reload to force an immediate reconnect.',
        'Run qq_setup action=verify, then qq_channel module=status. The account binding and SQLite history persist across reboot.',
        'If SnowLuma regenerated its OneBot token after a data reset, update %USERPROFILE%/.dsh/qq-plugin/config.json; the plugin watches it and reloads.',
      ],
      timing: [
        'Correct order: ask install directory -> extract/start service -> sign in/inject QQ -> SnowLuma creates config/onebot_<uin>.json with a random token -> write external config.json -> install/enable plugin.',
        'SnowLuma OneBot config is per QQ account and may not exist until the first successful injection/login.',
        'The plugin watches the external config file. If config.json is written after plugin start it reloads and reconnects automatically; if watching is unavailable use qq_setup action=reload or disable/enable the plugin.',
        'Writing config.json after the plugin is already active used to require a plugin reload; qq_setup action=reload is the explicit fallback.',
      ],
      windowsSecurity: [
        'Do not extract SnowLuma into the DSH workspace: files may inherit Low Integrity and cannot inject into Medium-integrity QQ.',
        'Preferred location: %USERPROFILE%/SnowLuma.',
        'If Windows shows an Internet security warning, open file Properties and choose Unblock, or run Unblock-File on the archive and extracted files.',
        'Verify the plugin tarball SHA256 before unblocking or installing.',
        'If injection still fails, explain the icacls medium-integrity repair and ask the user before running it: icacls <dir> /setintegritylevel (OI)(CI)M',
      ],
      userActions: [
        'Ask once, in the user language, where to install SnowLuma/NapCat; if the user delegates, choose a reasonable writable location yourself.',
        'Install or extract SnowLuma/NapCat outside the DSH plugin package.',
        'Open the service WebUI and sign in to QQ (QR or phone confirmation is user-only).',
        'Enable an OneBot 11 WebSocket server on 127.0.0.1:3001 (or HTTP event sink on 3000).',
        'Set messageFormat=array and reportSelfMessage=true, then copy its access token.',
      ],
      assistantActions: [
        'Ask for and validate the user-selected service directory before extraction.',
        'Inspect processes and listening ports.',
        'Launch SnowLuma launcher.bat or NapCat start command.',
        'Ask before extracting, changing integrity labels, or writing outside the plugin data directory.',
        'Write local onebot config (never expose the token in model messages).',
        'Verify get_login_info and install/enable this DSH plugin.',
        'Call qq_setup action=reload if the external config was written after plugin activation.',
        'Call qq_channel after installation to bind the current DSH session.',
      ],
      configFile: configPath,
      configExample: {
        account: 'QQ_NUMBER', owner: 'OWNER_QQ',
        onebot: { mode: 'ws', url: 'ws://127.0.0.1:3001/', httpUrl: 'http://127.0.0.1:3000/', accessToken: '<local-secret>' },
      },
      checks: [
        'Test-NetConnection 127.0.0.1 -Port 3001',
        'POST get_login_info to OneBot HTTP',
        'qq_setup action=verify checks config, ports and get_login_info',
        'qq_channel module=status after OneBot is online binds the session',
      ],
      safety: [
        'SnowLuma/NapCat/QQ are external services and are not bundled in the plugin package.',
        'QQ content is untrusted; settings changes require the DSH owner.',
        'Do not run icacls, extract archives, or change system security settings without explicit user confirmation.',
      ],
    }
  }

  async channel(args = {}, agent) {
    const module = String(args.module || 'status')
    if (module === 'setup') return this.setupGuide()
    try {
      this.ensureHolder(agent)
    } catch (error) {
      if (error?.code === 'QQ_NOT_READY' || /尚未连接|未识别账号/u.test(String(error?.message || ''))) {
        return { connected: false, error: String(error.message || error), next: 'qq_channel module=setup' }
      }
      throw error
    }
    const settings = this.store.effectiveSettings('')
    const binding = this.store.getBindings()
    const counts = this.store.counts()
    const base = {
      connection: this.client?.getState?.() ?? { connected: false },
      account: this.accountId, selfId: this.selfId, owner: this.ownerId || null,
      binding: { session: binding.session_id || null, epoch: binding.epoch, holder: binding.session_id ? this.currentAgent()?.status ?? 'offline' : 'unbound' },
      queue: { buffered: counts.buffered, unprocessed: counts.unprocessed, chats: this.store.bufferedChats().length },
      serviceEnabled: settings.serviceEnabled !== false, storage: counts, lastError: this.lastError || null,
    }
    if (module === 'status') return base
    if (module === 'all') return { ...base, settings: this.store.listSettings(), whitelist: this.store.listWhitelist(), capabilities: this.client?.getState?.().capabilities, errors: this.store.recentErrors(10), log: this.lastLog.slice(-20) }
    if (module === 'settings') return { defaults: DEFAULT_SETTINGS, scopes: this.store.listSettings() }
    if (module === 'capabilities') return { ...(this.client?.getState?.()?.capabilities || {}), implementation: this.client?.getState?.()?.implementation, version: this.client?.getState?.()?.version }
    if (module === 'binding') return base.binding
    if (module === 'whitelist') return { enabled: settings.whitelistEnabled, entries: this.store.listWhitelist() }
    if (module === 'errors') return { errors: this.store.recentErrors(20), log: this.lastLog.slice(-30) }
    if (module === 'storage') return base.storage
    throw new Error('module 可选 status/settings/capabilities/binding/whitelist/storage/errors/all')
  }

  async settings(args = {}, agent) {
    this.ensureHolder(agent)
    const set = args.set && typeof args.set === 'object' ? args.set : null
    const whitelist = args.whitelist && typeof args.whitelist === 'object' ? args.whitelist : null
    if (!set && !whitelist) {
      const effective = this.store.effectiveSettings(args.target ? String(args.target) : '')
      return { scopes: this.store.listSettings(), effective }
    }
    if (whitelist) {
      if (!this.ownerId) throw new Error('未配置 owner，无法提交白名单申请')
      const pending = []
      for (const entry of asArray(whitelist.add)) {
        const target = parseTarget(entry); if (!target) throw new Error(`无效白名单对象: ${entry}`)
        const id = this.store.addPendingWhitelist(target.key, 'add')
        const delivered = await this.sendSystemText(`private:${this.ownerId}`, `QQ插件白名单申请 #${id} ${target.key}\n请回复: 同意 ${id} 或 拒绝 ${id}`)
        if (!delivered) { this.store.deletePendingWhitelist(id); throw new Error('白名单确认消息发送失败，请检查 QQ 连接') }
        pending.push({ id, target: target.key })
      }
      for (const entry of asArray(whitelist.remove)) {
        const target = parseTarget(entry); if (!target) throw new Error(`无效白名单对象: ${entry}`)
        const id = this.store.addPendingWhitelist(target.key, 'remove')
        const delivered = await this.sendSystemText(`private:${this.ownerId}`, `QQ插件白名单移除申请 #${id} ${target.key}\n请回复: 同意 ${id} 或 拒绝 ${id}`)
        if (!delivered) { this.store.deletePendingWhitelist(id); throw new Error('白名单确认消息发送失败，请检查 QQ 连接') }
        pending.push({ id, target: target.key })
      }
      return { pending }
    }
    const target = args.target ? String(args.target) : 'global'
    let scope = target
    if (target !== 'global' && target !== 'group:all' && target !== 'private:all') {
      const parsed = parseTarget(target)
      if (!parsed) throw new Error('target 使用 global、group:all、private:all、group:123 或 private:123')
      scope = parsed.key
    }
    const numericKeys = ['silenceSeconds', 'countMessages', 'maxWaitSeconds', 'inlineThreshold', 'quoteThreshold', 'splitDelayMs', 'cacheMaxMb', 'mediaRetentionDays', 'receiptRetentionDays', 'receiptMax', 'messageRetentionDays', 'messageMaxPerChat', 'notifyMaxBatches', 'notifyMaxChars', 'historyDefault', 'historyMax', 'replyFetchLimit']
    const patch = {}
    for (const [key, value] of Object.entries(set)) {
      if (key === 'dndHours') continue
      if (key === 'whitelist') throw new Error('白名单增删请使用 whitelist.add / whitelist.remove，并由 owner 私聊确认')
      if (value === 'inherit' || value === null) { patch[key] = value; continue }
      if (key === 'dnd') {
        if (!['off', 'at', 'all'].includes(String(value))) throw new Error('dnd 必须是 off、at 或 all')
        if (value === 'all') {
          const hours = Number(set.dndHours ?? args.dndHours ?? 0)
          if (!(hours > 0)) throw new Error('免打扰 all 必须同时提供 dndHours')
          patch.dnd = 'all'; patch.dndUntil = Date.now() + Math.min(31 * 24, hours) * 3600_000
        } else { patch.dnd = String(value); patch.dndUntil = 0 }
      } else if (key === 'owner') {
        const owner = String(value || '')
        if (!/^[1-9]\d{0,19}$/u.test(owner)) throw new Error('owner 必须是 QQ 号')
        patch.owner = owner; this.ownerId = owner; this.renderer?.setIdentity({ ownerId: owner })
      } else if (key === 'uploadDirs') patch.uploadDirs = asArray(value).map(v => path.resolve(String(v)))
      else if (key === 'downloadDir') patch.downloadDir = path.resolve(String(value))
      else if (key === 'whitelistEnabled') patch.whitelistEnabled = Boolean(value)
      else if (numericKeys.includes(key)) {
        const n = Number(value)
        if (!Number.isFinite(n) || n < 0) throw new Error(`${key} 必须是非负数`)
        patch[key] = Math.trunc(n)
      } else if (key === 'serviceEnabled') patch[key] = Boolean(value)
      else throw new Error(`未知设置项: ${key}`)
    }
    if (set.dnd === 'all' && !('dndUntil' in patch)) throw new Error('免打扰 all 必须同时提供 dndHours')
    const saved = this.store.patchScopedSettings(scope, patch)
    if (set.serviceEnabled === true && this.client && !this.client.connected) void this.client.start()
    if (set.serviceEnabled === false && this.client) void this.client.stop()
    if (set.owner) this.ownerId = String(set.owner)
    return { scope, values: saved }
  }
}










