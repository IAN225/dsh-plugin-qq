/** OneBot 11 transport for SnowLuma and NapCat: forward WebSocket or HTTP event sink. */
import http from 'node:http'
import { jsonText, safeJsonParse } from './util.js'

const WS_OPEN = 1

export class OneBotClient {
  constructor(options, handlers = {}) {
    this.options = {
      mode: 'ws',
      url: 'ws://127.0.0.1:3001/',
      httpUrl: 'http://127.0.0.1:3000/',
      accessToken: '',
      listenHost: '127.0.0.1',
      listenPort: 5701,
      listenPath: '/onebot/events',
      requestTimeoutMs: 30000,
      reconnectMs: 1000,
      ...options,
    }
    this.handlers = handlers
    this.ws = null
    this.server = null
    this.pending = new Map()
    this.seq = 0
    this.connected = false
    this.stopping = false
    this.reconnectTimer = null
    this.reconnectAttempt = 0
    this.state = {
      transport: this.options.mode,
      connected: false,
      implementation: '',
      version: '',
      selfId: '',
      capabilities: {},
      lastError: '',
      lastEventAt: 0,
      connectedAt: 0,
      actionCount: 0,
    }
  }

  async start() {
    this.stopping = false
    if (this.options.mode === 'http') return this.startHttp()
    return this.startWs()
  }

  async stop() {
    this.stopping = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.ws) {
      try { this.ws.close(1000, 'plugin stopping') } catch {}
      this.ws = null
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('OneBot connection stopped'))
    }
    this.pending.clear()
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise(resolve => server.close(() => resolve()))
    }
    this.setConnected(false, 'stopped')
  }

  setConnected(value, error = '') {
    const changed = this.connected !== value
    this.connected = value
    this.state.connected = value
    if (value) { this.state.connectedAt = Date.now(); this.state.lastError = '' }
    else if (error) this.state.lastError = String(error)
    if (changed) {
      try { this.handlers.onConnection?.({ connected: value, error, state: this.getState() }) } catch {}
    }
  }

  getState() { return { ...this.state, capabilities: { ...this.state.capabilities } } }

  buildWsUrl() {
    const raw = String(this.options.url || '').trim()
    const url = new URL(raw)
    if (this.options.accessToken) url.searchParams.set('access_token', this.options.accessToken)
    return url.toString()
  }

  async startWs() {
    if (this.stopping) return
    let url
    try { url = this.buildWsUrl() } catch (error) {
      this.state.lastError = `Invalid OneBot WebSocket URL: ${error.message}`
      this.handlers.onError?.({ code: 'onebot/url', message: this.state.lastError })
      return
    }
    this.handlers.onLog?.({ level: 'info', message: `OneBot WS connecting ${url.replace(/access_token=[^&]+/u, 'access_token=***')}` })
    let ws
    try { ws = new WebSocket(url) } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.reconnectAttempt = 0
      this.setConnected(true)
      this.handlers.onLog?.({ level: 'info', message: 'OneBot WS connected' })
      void this.probeIdentity()
    })
    ws.addEventListener('message', event => {
      if (this.ws !== ws) return
      const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
      this.handleRaw(text)
    })
    ws.addEventListener('error', () => {
      this.state.lastError = 'WebSocket transport error'
    })
    ws.addEventListener('close', event => {
      if (this.ws !== ws) return
      this.ws = null
      const reason = event.reason ? `${event.code} ${event.reason}` : `code ${event.code}`
      this.setConnected(false, `WebSocket closed: ${reason}`)
      this.handlers.onLog?.({ level: 'warn', message: `OneBot WS closed: ${reason}` })
      this.scheduleReconnect()
    })
  }

  scheduleReconnect() {
    if (this.stopping || this.options.mode !== 'ws' || this.reconnectTimer) return
    const base = Math.max(250, Number(this.options.reconnectMs) || 1000)
    const delay = Math.min(30000, base * Math.max(1, 2 ** Math.min(5, this.reconnectAttempt++)))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.startWs()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  async startHttp() {
    const host = String(this.options.listenHost || '127.0.0.1')
    const port = Number(this.options.listenPort || 5701)
    const route = String(this.options.listenPath || '/onebot/events')
    this.server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res, route)
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => resolve())
    })
    this.setConnected(true)
    this.handlers.onLog?.({ level: 'info', message: `OneBot event sink listening http://${host}:${port}${route}` })
    void this.probeIdentity()
  }

  authorized(req) {
    const token = String(this.options.accessToken || '')
    if (!token) return true
    const auth = String(req.headers.authorization || '')
    if (auth === `Bearer ${token}`) return true
    try { return new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('access_token') === token } catch { return false }
  }

  async handleHttpRequest(req, res, route) {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method !== 'POST' || url.pathname !== route) { res.writeHead(404).end('not found'); return }
      if (!this.authorized(req)) { res.writeHead(401).end('unauthorized'); return }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 16 * 1024 * 1024) { res.writeHead(413).end('too large'); return }
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      this.handleRaw(text)
      res.writeHead(204).end()
    } catch (error) {
      this.handlers.onError?.({ code: 'onebot/http-event', message: error instanceof Error ? error.message : String(error) })
      try { res.writeHead(400).end('bad request') } catch {}
    }
  }

  handleRaw(text) {
    let payload
    try { payload = JSON.parse(text) } catch {
      this.handlers.onError?.({ code: 'onebot/json', message: 'OneBot sent invalid JSON' })
      return
    }
    this.state.lastEventAt = Date.now()
    if (Array.isArray(payload)) {
      for (const event of payload) { try { this.handlers.onEvent?.(event) } catch {} }
      return
    }
    if (payload && payload.echo !== undefined && !payload.post_type) {
      const pending = this.pending.get(String(payload.echo))
      if (pending) {
        this.pending.delete(String(payload.echo))
        clearTimeout(pending.timer)
        const failed = payload.status === 'failed' || Number(payload.retcode ?? 0) !== 0
        if (failed) {
          const message = String(payload.wording || payload.msg || payload.message || payload.retcode || 'OneBot action failed')
          const error = new Error(message)
          error.code = payload.retcode ?? 'ONE_BOT_ACTION_FAILED'
          error.detail = payload
          pending.reject(error)
        } else {
          pending.resolve(payload.data ?? payload)
        }
      }
      return
    }
    try { this.handlers.onEvent?.(payload) }
    catch (error) { this.handlers.onError?.({ code: 'onebot/event-handler', message: error instanceof Error ? error.message : String(error) }) }
  }

  async action(action, params = {}, timeoutMs = this.options.requestTimeoutMs) {
    if (!this.connected) throw Object.assign(new Error('OneBot 未连接'), { code: 'NOT_CONNECTED' })
    const echo = `qq-${Date.now()}-${++this.seq}`
    const payload = { action, params, echo }
    this.state.actionCount += 1
    if (this.options.mode === 'ws') {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(echo)
          reject(Object.assign(new Error(`OneBot 动作超时: ${action}`), { code: 'ACTION_TIMEOUT' }))
        }, Math.max(1000, Number(timeoutMs) || 30000))
        timer.unref?.()
        this.pending.set(echo, { resolve, reject, timer })
        try { this.ws.send(JSON.stringify(payload)) }
        catch (error) { clearTimeout(timer); this.pending.delete(echo); reject(error) }
      })
    }
    const base = String(this.options.httpUrl || this.options.url || 'http://127.0.0.1:3000/')
    const url = new URL(base)
    const token = String(this.options.accessToken || '')
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 30000)),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw Object.assign(new Error(`OneBot HTTP ${response.status}`), { code: 'HTTP_ERROR', detail: data })
    if (!data || data.status === 'failed' || Number(data.retcode ?? 0) !== 0) {
      throw Object.assign(new Error(String(data?.wording || data?.message || data?.msg || 'OneBot action failed')), { code: data?.retcode ?? 'ACTION_FAILED', detail: data })
    }
    return data.data ?? data
  }

  async probeIdentity() {
    let login = null
    let version = null
    try { login = await this.action('get_login_info', {}, 8000) } catch (error) { this.state.lastError = error.message }
    try { version = await this.action('get_version_info', {}, 8000) } catch {}
    this.state.selfId = String(login?.user_id ?? login?.uin ?? this.state.selfId ?? '')
    const appName = String(version?.app_name || version?.appName || version?.name || '')
    const appVersion = String(version?.app_version || version?.appVersion || version?.version || '')
    const lower = `${appName} ${appVersion}`.toLowerCase()
    this.state.implementation = lower.includes('snowluma') ? 'SnowLuma' : lower.includes('napcat') ? 'NapCat' : (appName || 'OneBot 11')
    this.state.version = appVersion
    this.state.capabilities = {
      messageArray: true,
      selfMessages: 'requires protocol reportSelfMessage=true',
      groupFiles: true,
      customFaces: lower.includes('napcat') || lower.includes('snowluma'),
      implementationHint: appName || 'unknown',
    }
    this.handlers.onReady?.({ state: this.getState(), login, version })
  }
}


