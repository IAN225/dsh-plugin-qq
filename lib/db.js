/** Per-account SQLite store. One database file per QQ account provides hard isolation. */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { jsonClone, jsonText, randomHex, safeJsonParse } from './util.js'

export const DEFAULT_SETTINGS = Object.freeze({
  silenceSeconds: 15,
  countMessages: 5,
  maxWaitSeconds: 60,
  inlineThreshold: 360,
  quoteThreshold: 160,
  splitDelayMs: 700,
  dnd: 'off',
  dndUntil: 0,
  serviceEnabled: true,
  whitelistEnabled: false,
  whitelist: [],
  owner: '',
  uploadDirs: [],
  downloadDir: '',
  cacheMaxMb: 1024,
  mediaRetentionDays: 30,
  receiptRetentionDays: 14,
  receiptMax: 2000,
  messageRetentionDays: 30,
  messageMaxPerChat: 2000,
  notifyMaxBatches: 8,
  notifyMaxChars: 5000,
  historyDefault: 20,
  historyMax: 50,
  replyFetchLimit: 20,
})

export class Store {
  constructor(dir, account) {
    this.dir = dir
    this.account = String(account)
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true })
    this.db = new DatabaseSync(path.join(dir, 'qq.db'))
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON;')
    this.migrate()
    this.statements = new Map()
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(
        account TEXT PRIMARY KEY,
        session_id TEXT,
        epoch INTEGER NOT NULL DEFAULT 0,
        bound_at INTEGER NOT NULL DEFAULT 0,
        changed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS binding_history(
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings(
        scope TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations(
        chat_type TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        group_id TEXT,
        name TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(chat_type, peer_id)
      );
      CREATE TABLE IF NOT EXISTS users(
        user_id TEXT PRIMARY KEY,
        nickname TEXT,
        card TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages(
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        msg_ref TEXT NOT NULL UNIQUE,
        chat_type TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        group_id TEXT,
        message_id TEXT,
        message_seq TEXT,
        real_id TEXT,
        sender_id TEXT NOT NULL,
        sender_nickname TEXT,
        sender_card TEXT,
        direction TEXT NOT NULL,
        origin TEXT NOT NULL,
        ts INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        segments TEXT NOT NULL,
        raw_event TEXT,
        recalled INTEGER NOT NULL DEFAULT 0,
        buffer_state TEXT NOT NULL DEFAULT 'history',
        receipt TEXT,
        receipt_pos INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_protocol
        ON messages(chat_type, peer_id, message_id) WHERE message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS ix_messages_chat_ts ON messages(chat_type, peer_id, ts, row_id);
      CREATE INDEX IF NOT EXISTS ix_messages_receipt ON messages(receipt, receipt_pos);
      CREATE TABLE IF NOT EXISTS buffers(
        message_row_id INTEGER PRIMARY KEY REFERENCES messages(row_id) ON DELETE CASCADE,
        chat_type TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        group_id TEXT,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        enqueued_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_buffers_chat ON buffers(chat_type, peer_id, first_at);
      CREATE TABLE IF NOT EXISTS receipts(
        receipt TEXT PRIMARY KEY,
        chat_type TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        group_id TEXT,
        name TEXT,
        batch_no INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        notified_at INTEGER NOT NULL DEFAULT 0,
        read_at INTEGER NOT NULL DEFAULT 0,
        replied_at INTEGER NOT NULL DEFAULT 0,
        silent_at INTEGER NOT NULL DEFAULT 0,
        last_ts INTEGER NOT NULL,
        message_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_receipts_state ON receipts(state, created_at);
      CREATE TABLE IF NOT EXISTS receipt_items(
        receipt TEXT NOT NULL REFERENCES receipts(receipt) ON DELETE CASCADE,
        pos INTEGER NOT NULL,
        message_row_id INTEGER NOT NULL REFERENCES messages(row_id) ON DELETE CASCADE,
        PRIMARY KEY(receipt, pos)
      );
      CREATE TABLE IF NOT EXISTS media(
        ref TEXT PRIMARY KEY,
        message_row_id INTEGER,
        kind TEXT NOT NULL,
        source_json TEXT,
        remote_url TEXT,
        local_path TEXT,
        name TEXT,
        mime TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_media_message ON media(message_row_id);
      CREATE INDEX IF NOT EXISTS ix_media_status ON media(status, updated_at);
      CREATE TABLE IF NOT EXISTS forward_refs(
        ref TEXT PRIMARY KEY,
        protocol_id TEXT,
        message_row_id INTEGER,
        payload TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_file_refs(
        ref TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        busid INTEGER NOT NULL DEFAULT 102,
        name TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        uploader TEXT,
        upload_time INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_stats(
        chat_type TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        silent_streak INTEGER NOT NULL DEFAULT 0,
        last_hint_at INTEGER NOT NULL DEFAULT 0,
        last_sent_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(chat_type, peer_id)
      );
      CREATE TABLE IF NOT EXISTS pending_whitelist(
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS errors(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS meta_account(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        account TEXT NOT NULL
      );
      INSERT OR IGNORE INTO meta_account VALUES(1, '');
      INSERT OR IGNORE INTO bindings VALUES('account', NULL, 0, 0, 0);
    `)
    const columns = new Set(this.db.prepare('PRAGMA table_info(messages)').all().map(row => row.name))
    if (!columns.has('message_seq')) this.db.exec('ALTER TABLE messages ADD COLUMN message_seq TEXT')
    this.db.exec('CREATE INDEX IF NOT EXISTS ix_messages_seq ON messages(chat_type, peer_id, message_seq)')
  }

  close() { try { this.db.close() } catch {} }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = fn(); this.db.exec('COMMIT'); return value }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {} throw error }
  }

  stmt(sql) {
    let s = this.statements.get(sql)
    if (!s) { s = this.db.prepare(sql); this.statements.set(sql, s) }
    return s
  }

  getMeta(key, fallback = '') {
    const row = this.stmt('SELECT value FROM meta WHERE key=?').get(key)
    return row ? row.value : fallback
  }

  setMeta(key, value) {
    this.stmt('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(key, String(value))
  }

  getBindings() {
    const row = this.stmt('SELECT * FROM bindings WHERE account=?').get('account')
    return row ? { ...row } : { account: 'account', session_id: null, epoch: 0, bound_at: 0, changed_at: 0 }
  }

  getBindingHistory(sessionId) {
    const row = this.stmt('SELECT * FROM binding_history WHERE session_id=?').get(String(sessionId))
    return row ? { ...row } : null
  }

  /** Attach a resumed agent only when it is still the recorded holder. */
  reattach(sessionId) {
    const binding = this.getBindings()
    if (!binding.session_id || binding.session_id !== String(sessionId)) return { ok: false, binding }
    this.stmt('UPDATE bindings SET bound_at=? WHERE account=?').run(Date.now(), 'account')
    this.stmt('UPDATE binding_history SET status=?, updated_at=? WHERE session_id=?').run('current', Date.now(), String(sessionId))
    return { ok: true, binding: this.getBindings() }
  }

  /** First caller binds; a new session may take over; a taken-over session may never reclaim. */
  claimBinding(sessionId) {
    const sid = String(sessionId)
    return this.tx(() => {
      const binding = this.getBindings()
      if (binding.session_id === sid) {
        this.stmt('UPDATE binding_history SET status=?, updated_at=? WHERE session_id=?').run('current', Date.now(), sid)
        return { ok: true, changed: false, binding: this.getBindings() }
      }
      const history = this.getBindingHistory(sid)
      if (history && history.status === 'taken_over') {
        return { ok: false, changed: false, reason: '该账号已被其他会话接管', binding }
      }
      if (binding.session_id) {
        this.stmt('UPDATE binding_history SET status=?, updated_at=? WHERE session_id=?').run('taken_over', Date.now(), binding.session_id)
      }
      const epoch = Number(binding.epoch || 0) + 1
      const now = Date.now()
      this.stmt('UPDATE bindings SET session_id=?, epoch=?, bound_at=?, changed_at=? WHERE account=?').run(sid, epoch, now, now, 'account')
      this.stmt('INSERT INTO binding_history(session_id,status,epoch,updated_at) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET status=excluded.status,epoch=excluded.epoch,updated_at=excluded.updated_at').run(sid, 'current', epoch, now)
      return { ok: true, changed: true, previous: binding.session_id, binding: this.getBindings() }
    })
  }

  getSettingsScope(scope) {
    const row = this.stmt('SELECT payload FROM settings WHERE scope=?').get(String(scope))
    return row ? safeJsonParse(row.payload, {}) : {}
  }

  putSettingsScope(scope, payload) {
    if (!payload || Object.keys(payload).length === 0) this.stmt('DELETE FROM settings WHERE scope=?').run(String(scope))
    else this.stmt('INSERT OR REPLACE INTO settings(scope,payload,updated_at) VALUES(?,?,?)').run(String(scope), jsonText(payload), Date.now())
  }

  effectiveSettings(chatKey = '') {
    let result = { ...DEFAULT_SETTINGS }
    const scopes = ['global']
    if (chatKey) {
      const [kind] = chatKey.split(':')
      scopes.push(`${kind}:all`, chatKey)
    }
    for (const scope of scopes) Object.assign(result, this.getSettingsScope(scope))
    if (result.dnd === 'all' && Number(result.dndUntil || 0) <= Date.now()) result.dnd = 'off'
    return result
  }

  patchScopedSettings(scope, patch) {
    return this.tx(() => {
      const current = this.getSettingsScope(scope)
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (value === 'inherit' || value === null) delete current[key]
        else current[key] = value
      }
      this.putSettingsScope(scope, current)
      return current
    })
  }

  listSettings() {
    return this.stmt('SELECT scope,payload,updated_at FROM settings ORDER BY scope').all().map(row => ({
      scope: row.scope, values: safeJsonParse(row.payload, {}), updatedAt: row.updated_at,
    }))
  }

  conversation(chatType, peerId) {
    const row = this.stmt('SELECT * FROM conversations WHERE chat_type=? AND peer_id=?').get(chatType, peerId)
    return row ? { ...row } : null
  }

  upsertConversation(chatType, peerId, groupId, name, ts = Date.now()) {
    this.stmt(`INSERT INTO conversations(chat_type,peer_id,group_id,name,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(chat_type,peer_id) DO UPDATE SET group_id=COALESCE(excluded.group_id,conversations.group_id),
      name=CASE WHEN excluded.name IS NOT NULL AND excluded.name<>'' THEN excluded.name ELSE conversations.name END,
      updated_at=excluded.updated_at`).run(chatType, peerId, groupId ?? null, name ?? null, ts)
  }

  rememberUser(userId, nickname, card) {
    if (!userId) return
    this.stmt(`INSERT INTO users(user_id,nickname,card,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET nickname=COALESCE(excluded.nickname,users.nickname),
      card=COALESCE(excluded.card,users.card),updated_at=excluded.updated_at`).run(String(userId), nickname ?? null, card ?? null, Date.now())
  }

  user(userId) {
    const row = this.stmt('SELECT * FROM users WHERE user_id=?').get(String(userId))
    return row ? { ...row } : null
  }

  findByProtocol(chatType, peerId, messageId) {
    if (messageId === undefined || messageId === null || messageId === '') return null
    const row = this.stmt('SELECT * FROM messages WHERE chat_type=? AND peer_id=? AND (message_id=? OR message_seq=?) ORDER BY row_id DESC LIMIT 1').get(chatType, peerId, String(messageId), String(messageId))
    return row ? this.hydrate(row) : null
  }

  findMessageByRef(ref) {
    const row = this.stmt('SELECT * FROM messages WHERE msg_ref=?').get(String(ref))
    return row ? this.hydrate(row) : null
  }

  findMessageByRowId(rowId) {
    const row = this.stmt('SELECT * FROM messages WHERE row_id=?').get(Number(rowId))
    return row ? this.hydrate(row) : null
  }

  hydrate(row) {
    return { ...row, segments: safeJsonParse(row.segments, []), raw_event: safeJsonParse(row.raw_event, null) }
  }

  insertMessage(input) {
    const now = Date.now()
    const msgRef = input.msgRef || this.uniqueMessageRef()
    const result = this.stmt(`INSERT OR IGNORE INTO messages(
      msg_ref,chat_type,peer_id,group_id,message_id,message_seq,real_id,sender_id,sender_nickname,sender_card,
      direction,origin,ts,received_at,segments,raw_event,recalled,buffer_state
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      msgRef, input.chatType, input.peerId, input.groupId ?? null, input.messageId == null ? null : String(input.messageId),
      input.messageSeq == null ? null : String(input.messageSeq), input.realId == null ? null : String(input.realId),
      String(input.senderId ?? ''), input.senderNickname ?? null,
      input.senderCard ?? null, input.direction ?? 'in', input.origin ?? 'incoming', Number(input.ts ?? now),
      Number(input.receivedAt ?? now), jsonText(input.segments ?? []), input.rawEvent ? jsonText(input.rawEvent) : null,
      input.recalled ? 1 : 0, input.bufferState ?? 'history',
    )
    if (result.changes > 0) {
      const row = input.messageId == null
        ? this.stmt('SELECT * FROM messages WHERE msg_ref=?').get(msgRef)
        : this.stmt('SELECT * FROM messages WHERE chat_type=? AND peer_id=? AND message_id=?').get(input.chatType, input.peerId, String(input.messageId))
      return row ? this.hydrate(row) : null
    }
    return this.findByProtocol(input.chatType, input.peerId, input.messageId)
  }

  uniqueMessageRef() {
    for (;;) { const ref = `m${randomHex(4)}`; if (!this.stmt('SELECT 1 FROM messages WHERE msg_ref=?').get(ref)) return ref }
  }

  uniqueReceipt() {
    for (;;) { const ref = randomHex(4); if (!this.stmt('SELECT 1 FROM receipts WHERE receipt=?').get(ref)) return ref }
  }

  uniqueMediaRef() {
    for (;;) { const ref = `media:${randomHex(4)}`; if (!this.stmt('SELECT 1 FROM media WHERE ref=?').get(ref)) return ref }
  }

  uniqueForwardRef() {
    for (;;) { const ref = `f:${randomHex(4)}`; if (!this.stmt('SELECT 1 FROM forward_refs WHERE ref=?').get(ref)) return ref }
  }

  uniqueGroupFileRef() {
    for (;;) { const ref = `gf:${randomHex(4)}`; if (!this.stmt('SELECT 1 FROM group_file_refs WHERE ref=?').get(ref)) return ref }
  }

  enqueueBuffer(message) {
    if (!message) return
    const now = Date.now()
    this.tx(() => {
      this.stmt('UPDATE messages SET buffer_state=? WHERE row_id=?').run('buffered', message.row_id)
      this.stmt(`INSERT INTO buffers(message_row_id,chat_type,peer_id,group_id,first_at,last_at,enqueued_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(message_row_id) DO UPDATE SET last_at=excluded.last_at`).run(
        message.row_id, message.chat_type, message.peer_id, message.group_id ?? null,
        Number(message.ts) || now, Number(message.ts) || now, now,
      )
    })
  }

  bufferedChats() {
    return this.stmt(`SELECT b.chat_type,b.peer_id,MIN(b.first_at) first_at,MAX(b.last_at) last_at,
      COUNT(*) count,MAX(b.group_id) group_id FROM buffers b JOIN messages m ON m.row_id=b.message_row_id
      WHERE m.buffer_state='buffered' GROUP BY b.chat_type,b.peer_id ORDER BY first_at`).all().map(row => ({ ...row }))
  }

  bufferCount(chatType, peerId) {
    return Number(this.stmt(`SELECT COUNT(*) c FROM buffers b JOIN messages m ON m.row_id=b.message_row_id
      WHERE b.chat_type=? AND b.peer_id=? AND m.buffer_state='buffered'`).get(chatType, peerId)?.c ?? 0)
  }

  peekBuffered(chatType, peerId, limit = 10) {
    return this.stmt(`SELECT m.* FROM buffers b JOIN messages m ON m.row_id=b.message_row_id
      WHERE b.chat_type=? AND b.peer_id=? AND m.buffer_state='buffered'
      ORDER BY m.ts,m.row_id LIMIT ?`).all(chatType, peerId, Math.max(1, Number(limit) || 10)).map(row => this.hydrate(row))
  }

  /** Freeze one receipt from buffered rows. The mapping never changes afterwards. */
  createReceipt(chatType, peerId, groupId, name, maxMessages = 10) {
    return this.tx(() => {
      const rows = this.peekBuffered(chatType, peerId, maxMessages)
      if (rows.length === 0) return null
      const receipt = this.uniqueReceipt()
      const batchNo = Number(this.stmt('SELECT COALESCE(MAX(batch_no),0)+1 n FROM receipts WHERE chat_type=? AND peer_id=?').get(chatType, peerId).n)
      const now = Date.now()
      const lastTs = Number(rows[rows.length - 1].ts)
      this.stmt(`INSERT INTO receipts(receipt,chat_type,peer_id,group_id,name,batch_no,state,created_at,last_ts,message_count)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(receipt, chatType, peerId, groupId ?? null, name ?? null, batchNo, 'unprocessed', now, lastTs, rows.length)
      rows.forEach((row, index) => {
        this.stmt('INSERT INTO receipt_items(receipt,pos,message_row_id) VALUES(?,?,?)').run(receipt, index + 1, row.row_id)
        this.stmt('UPDATE messages SET buffer_state=?,receipt=?,receipt_pos=? WHERE row_id=?').run('receipt', receipt, index + 1, row.row_id)
        this.stmt('DELETE FROM buffers WHERE message_row_id=?').run(row.row_id)
      })
      return this.getReceipt(receipt)
    })
  }

  getReceipt(receipt) {
    const row = this.stmt('SELECT * FROM receipts WHERE receipt=?').get(String(receipt))
    if (!row) return null
    const items = this.stmt(`SELECT ri.pos,m.* FROM receipt_items ri JOIN messages m ON m.row_id=ri.message_row_id
      WHERE ri.receipt=? ORDER BY ri.pos`).all(String(receipt)).map(item => ({ pos: item.pos, message: this.hydrate(item) }))
    return { ...row, items }
  }

  receiptCounts(chatType, peerId) {
    return this.stmt(`SELECT state,COUNT(*) c FROM receipts WHERE chat_type=? AND peer_id=? GROUP BY state`).all(chatType, peerId)
  }

  unprocessedReceipts(limit = 100) {
    return this.stmt(`SELECT * FROM receipts WHERE state='unprocessed' ORDER BY created_at LIMIT ?`).all(Number(limit)).map(row => ({ ...row }))
  }

  unprocessedChats() {
    return this.stmt(`SELECT chat_type,peer_id,COUNT(*) batches,MIN(created_at) first_at,MAX(last_ts) last_at
      FROM receipts WHERE state='unprocessed' GROUP BY chat_type,peer_id ORDER BY first_at`).all().map(row => ({ ...row }))
  }

  markReceiptNotified(receipt) {
    this.stmt('UPDATE receipts SET notified_at=? WHERE receipt=? AND notified_at=0').run(Date.now(), String(receipt))
  }

  markReceiptState(receipt, state) {
    const now = Date.now()
    return this.tx(() => {
      const row = this.stmt('SELECT state FROM receipts WHERE receipt=?').get(String(receipt))
      if (!row) return null
      if (row.state === 'replied') return this.getReceipt(receipt)
      const column = state === 'read' ? 'read_at' : state === 'silent' ? 'silent_at' : state === 'replied' ? 'replied_at' : null
      if (column) this.stmt(`UPDATE receipts SET state=?,${column}=? WHERE receipt=?`).run(state, now, String(receipt))
      else this.stmt('UPDATE receipts SET state=? WHERE receipt=?').run(state, String(receipt))
      return this.getReceipt(receipt)
    })
  }

  recallMessage(chatType, peerId, messageId) {
    const msg = this.findByProtocol(chatType, peerId, messageId)
    if (!msg) return null
    this.stmt('UPDATE messages SET recalled=1 WHERE row_id=?').run(msg.row_id)
    return { ...msg, recalled: 1 }
  }

  recentMessages(chatType, peerId, limit = 20, beforeRowId = null) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20))
    const rows = beforeRowId
      ? this.stmt(`SELECT * FROM messages WHERE chat_type=? AND peer_id=? AND row_id<? ORDER BY row_id DESC LIMIT ?`).all(chatType, peerId, Number(beforeRowId), safeLimit)
      : this.stmt('SELECT * FROM messages WHERE chat_type=? AND peer_id=? ORDER BY row_id DESC LIMIT ?').all(chatType, peerId, safeLimit)
    return rows.map(row => this.hydrate(row)).reverse()
  }

  markDshSent(rowId, messageId) {
    this.tx(() => {
      this.stmt('UPDATE messages SET origin=?,buffer_state=? WHERE row_id=?').run('dsh', 'history', Number(rowId))
      this.stmt('DELETE FROM buffers WHERE message_row_id=?').run(Number(rowId))
      if (messageId != null) this.stmt('UPDATE messages SET message_id=? WHERE row_id=?').run(String(messageId), Number(rowId))
    })
  }

  insertMedia(input) {
    const ref = input.ref || this.uniqueMediaRef()
    const now = Date.now()
    this.stmt(`INSERT OR REPLACE INTO media(ref,message_row_id,kind,source_json,remote_url,local_path,name,mime,size,status,error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ref, input.messageRowId ?? null, input.kind, input.source ? jsonText(input.source) : null,
      input.remoteUrl ?? null, input.localPath ?? null, input.name ?? null, input.mime ?? null,
      Number(input.size ?? 0), input.status ?? 'pending', input.error ?? null, now, now,
    )
    return this.getMedia(ref)
  }

  getMedia(ref) {
    const row = this.stmt('SELECT * FROM media WHERE ref=?').get(String(ref))
    return row ? { ...row, source: safeJsonParse(row.source_json, null) } : null
  }

  updateMedia(ref, patch) {
    const current = this.getMedia(ref)
    if (!current) return null
    const next = { ...current, ...patch, updated_at: Date.now() }
    this.stmt(`UPDATE media SET remote_url=?,local_path=?,name=?,mime=?,size=?,status=?,error=?,updated_at=? WHERE ref=?`).run(
      next.remote_url ?? null, next.local_path ?? null, next.name ?? null, next.mime ?? null, Number(next.size ?? 0),
      next.status, next.error ?? null, Date.now(), String(ref),
    )
    return this.getMedia(ref)
  }

  mediaByMessage(rowId) {
    return this.stmt('SELECT * FROM media WHERE message_row_id=? ORDER BY created_at').all(Number(rowId)).map(row => ({ ...row, source: safeJsonParse(row.source_json, null) }))
  }

  recentMedia(limit = 20) {
    return this.stmt('SELECT * FROM media ORDER BY updated_at DESC LIMIT ?').all(Number(limit)).map(row => ({ ...row, source: safeJsonParse(row.source_json, null) }))
  }

  insertForward(ref, protocolId, messageRowId, payload, status = 'pending') {
    const now = Date.now()
    const actualRef = ref || this.uniqueForwardRef()
    this.stmt(`INSERT OR REPLACE INTO forward_refs(ref,protocol_id,message_row_id,payload,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(actualRef, protocolId ?? null, messageRowId ?? null, payload == null ? null : jsonText(payload), status, now, now)
    return this.getForward(actualRef)
  }

  getForward(ref) {
    const row = this.stmt('SELECT * FROM forward_refs WHERE ref=?').get(String(ref))
    return row ? { ...row, payload: safeJsonParse(row.payload, null) } : null
  }

  updateForward(ref, payload, status) {
    this.stmt('UPDATE forward_refs SET payload=?,status=?,updated_at=? WHERE ref=?').run(payload == null ? null : jsonText(payload), status, Date.now(), String(ref))
    return this.getForward(ref)
  }

  insertGroupFile(input) {
    const ref = input.ref || this.uniqueGroupFileRef()
    this.stmt(`INSERT OR REPLACE INTO group_file_refs(ref,group_id,file_id,busid,name,size,uploader,upload_time,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(ref, String(input.groupId), String(input.fileId), Number(input.busid ?? 102),
      input.name ?? null, Number(input.size ?? 0), input.uploader ?? null, Number(input.uploadTime ?? 0), Date.now())
    return this.getGroupFile(ref)
  }

  getGroupFile(ref) {
    const row = this.stmt('SELECT * FROM group_file_refs WHERE ref=?').get(String(ref))
    return row ? { ...row } : null
  }

  findGroupFileByName(groupId, name) {
    const row = this.stmt('SELECT * FROM group_file_refs WHERE group_id=? AND name=? ORDER BY created_at DESC LIMIT 1').get(String(groupId), String(name))
    return row ? { ...row } : null
  }

  bumpSilent(chatType, peerId, delta = 1) {
    this.stmt(`INSERT INTO chat_stats(chat_type,peer_id,silent_streak,last_hint_at,last_sent_at) VALUES(?,?,?,0,0)
      ON CONFLICT(chat_type,peer_id) DO UPDATE SET silent_streak=chat_stats.silent_streak+excluded.silent_streak`).run(chatType, peerId, delta)
  }

  resetSilent(chatType, peerId) {
    this.stmt(`INSERT INTO chat_stats(chat_type,peer_id,silent_streak,last_hint_at,last_sent_at) VALUES(?,?,0,0,?)
      ON CONFLICT(chat_type,peer_id) DO UPDATE SET silent_streak=0,last_sent_at=excluded.last_sent_at`).run(chatType, peerId, Date.now())
  }

  getChatStats(chatType, peerId) {
    const row = this.stmt('SELECT * FROM chat_stats WHERE chat_type=? AND peer_id=?').get(chatType, peerId)
    return row ? { ...row } : { chat_type: chatType, peer_id: peerId, silent_streak: 0, last_hint_at: 0, last_sent_at: 0 }
  }

  setHintAt(chatType, peerId, ts) {
    this.stmt(`INSERT INTO chat_stats(chat_type,peer_id,silent_streak,last_hint_at,last_sent_at) VALUES(?,?,0,?,0)
      ON CONFLICT(chat_type,peer_id) DO UPDATE SET last_hint_at=excluded.last_hint_at`).run(chatType, peerId, Number(ts))
  }

  addPendingWhitelist(scope, action = 'add') {
    const id = randomHex(4)
    const now = Date.now()
    this.stmt('INSERT INTO pending_whitelist(id,scope,action,created_at,expires_at) VALUES(?,?,?,?,?)').run(id, scope, action, now, now + 24 * 3600 * 1000)
    return id
  }

  getPendingWhitelist(id) {
    const row = this.stmt('SELECT * FROM pending_whitelist WHERE id=?').get(String(id))
    return row ? { ...row } : null
  }

  deletePendingWhitelist(id) { this.stmt('DELETE FROM pending_whitelist WHERE id=?').run(String(id)) }

  purgeExpiredWhitelist() { this.stmt('DELETE FROM pending_whitelist WHERE expires_at<?').run(Date.now()) }

  addError(code, message, detail = null) {
    const text = String(message ?? '').slice(0, 4000)
    this.stmt('INSERT INTO errors(ts,code,message,detail) VALUES(?,?,?,?)').run(Date.now(), String(code), text, detail == null ? null : jsonText(detail).slice(0, 8000))
    this.stmt('DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 50)').run()
  }

  recentErrors(limit = 10) {
    return this.stmt('SELECT * FROM errors ORDER BY id DESC LIMIT ?').all(Number(limit)).map(row => ({ ...row, detail: safeJsonParse(row.detail, null) }))
  }

  counts() {
    const one = sql => Number(this.stmt(sql).get()?.c ?? 0)
    return {
      messages: one('SELECT COUNT(*) c FROM messages'),
      buffered: one("SELECT COUNT(*) c FROM messages WHERE buffer_state='buffered'"),
      receipts: one('SELECT COUNT(*) c FROM receipts'),
      unprocessed: one("SELECT COUNT(*) c FROM receipts WHERE state='unprocessed'"),
      media: one('SELECT COUNT(*) c FROM media'),
      mediaBytes: Number(this.stmt('SELECT COALESCE(SUM(size),0) c FROM media WHERE local_path IS NOT NULL').get()?.c ?? 0),
    }
  }

  expireReceipts(olderThanMs) {
    const limit = Date.now() - Math.max(0, Number(olderThanMs) || 0)
    return this.tx(() => {
      const rows = this.stmt("SELECT receipt,chat_type,peer_id FROM receipts WHERE state IN ('unprocessed','read') AND created_at<?").all(limit)
      for (const row of rows) this.bumpSilent(row.chat_type, row.peer_id, 1)
      this.stmt("UPDATE receipts SET state='expired' WHERE state IN ('unprocessed','read') AND created_at<?").run(limit)
      return rows.length
    })
  }

  pruneReceipts(maxCount) {
    const limit = Math.max(50, Number(maxCount) || 2000)
    return this.tx(() => {
      const rows = this.stmt(`SELECT receipt FROM receipts WHERE state IN ('expired','silent','replied')
        ORDER BY created_at DESC LIMIT -1 OFFSET ?`).all(limit)
      for (const row of rows) this.stmt('DELETE FROM receipts WHERE receipt=?').run(row.receipt)
      return rows.length
    })
  }

  mediaOlderThan(cutoff) {
    return this.stmt("SELECT ref,local_path FROM media WHERE status<>'deleted' AND created_at<?").all(Number(cutoff)).map(row => ({ ...row }))
  }

  deleteMedia(ref) {
    const row = this.getMedia(ref)
    if (row?.local_path) { try { fs.rmSync(row.local_path, { force: true }) } catch {} }
    this.stmt("UPDATE media SET status='deleted',local_path=NULL,updated_at=? WHERE ref=?").run(Date.now(), String(ref))
  }

  messagesOlderThan(cutoff, keepPerChat = 1000) {
    return this.stmt(`SELECT row_id FROM messages WHERE received_at<? AND row_id NOT IN
      (SELECT row_id FROM (SELECT row_id,ROW_NUMBER() OVER (PARTITION BY chat_type,peer_id ORDER BY row_id DESC) rn FROM messages)
      WHERE rn<=?) AND receipt IS NULL`).all(Number(cutoff), Number(keepPerChat)).map(row => row.row_id)
  }

  deleteMessages(rowIds) {
    if (!rowIds.length) return 0
    return this.tx(() => {
      let count = 0
      for (const rowId of rowIds) {
        this.stmt('DELETE FROM messages WHERE row_id=?').run(Number(rowId))
        count += 1
      }
      return count
    })
  }

  listWhitelist() {
    const settings = this.getSettingsScope('global')
    return Array.isArray(settings.whitelist) ? [...new Set(settings.whitelist)] : []
  }

  setWhitelist(entries) {
    const current = this.getSettingsScope('global')
    current.whitelist = [...new Set(entries)].sort()
    this.putSettingsScope('global', current)
    return current.whitelist
  }

  isWhitelisted(chatKey, ownerId = '') {
    const settings = this.effectiveSettings(chatKey)
    if (!settings.whitelistEnabled) return true
    const list = Array.isArray(settings.whitelist) ? settings.whitelist : []
    return list.includes(chatKey)
  }
}

export function accountDir(rootDir, account) {
  const safe = /^[1-9]\d{0,19}$/u.test(String(account)) ? String(account) : `account-${String(account).replace(/[^A-Za-z0-9_.-]/gu, '_')}`
  return path.join(rootDir, 'accounts', safe)
}
