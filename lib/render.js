/** Compact model-facing projections of internally rich QQ messages. */
import { cleanName, formatClock, headerName, jsonLength, jsonText, truncateText } from './util.js'

const RESERVED_KEYS = new Set([
  'self', 'image', 'sticker', 'record', 'video', 'file', 'forward', 'card', 'poke', 'dice', 'rps',
  'recalled', 'unknown', 'at', 'reply', 'text', 'split', 'owner', 'chatters', 'messages', 'authority',
  'group', 'private', 'name', 'time', 'receipt', 'tempGroup',
])

function baseDisplay(msg) {
  return cleanName(msg.sender_card || msg.sender_nickname || '') || String(msg.sender_id || '')
}

function validSpeakerName(value, id) {
  if (!value || value === String(id)) return String(id)
  if (/^\d+$/u.test(value)) return String(id)
  if (/[\u0000-\u001f\u007f]/u.test(value)) return String(id)
  if (RESERVED_KEYS.has(value.toLowerCase())) return String(id)
  return value
}

function sameDay(ms) {
  const a = new Date(Number(ms)); const b = new Date()
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Convert one normalized internal segment to the terse model form. */
function compactSegment(segment, msg, context) {
  switch (segment.type) {
    case 'text': return String(segment.text ?? '')
    case 'at': {
      const qq = String(segment.qq ?? '')
      if (qq === String(context.selfId)) return { at: 'self' }
      if (qq === 'all') return { at: 'all' }
      return { at: qq }
    }
    case 'image': return { image: segment.mediaRef || '?' }
    case 'sticker': return { sticker: segment.mediaRef || '?' }
    case 'record': return { record: segment.mediaRef || '?' }
    case 'video': return { video: segment.mediaRef || '?' }
    case 'file': return { file: segment.mediaRef || '?', name: cleanName(segment.name || 'file') }
    case 'forward': return { forward: segment.ref || '?' }
    case 'card': return { card: truncateText(cleanName([segment.title, segment.summary].filter(Boolean).join('：')), 300) }
    case 'poke': return { poke: String(segment.qq === String(context.selfId) ? 'self' : segment.qq) }
    case 'dice': return { dice: Number(segment.value) || 0 }
    case 'rps': return { rps: String(segment.value || '') }
    case 'recalled': return { recalled: true }
    case 'reply': return { reply: segment.rendered ?? '?' }
    case 'unknown':
    default: return { unknown: cleanName(segment.typeName || segment.type || 'unknown') }
  }
}

function compactContent(segments, msg, context) {
  const parts = []
  for (const segment of segments) {
    if (segment?.type === 'text') {
      const text = String(segment.text ?? '')
      if (text.length === 0) continue
      if (parts.length > 0 && typeof parts[parts.length - 1] === 'string') parts[parts.length - 1] += text
      else parts.push(text)
      continue
    }
    if (!segment || typeof segment !== 'object') continue
    parts.push(compactSegment(segment, msg, context))
  }
  if (msg.recalled && !parts.some(part => part && part.recalled)) parts.push({ recalled: true })
  if (parts.length === 0) return ''
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0]
  if (parts.length === 1 && parts[0] && typeof parts[0] === 'object' && !Array.isArray(parts[0])) return parts[0]
  return parts
}

function contentPlainText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : contentPlainText(part)).join('')
  if (content && typeof content === 'object') {
    if (typeof content.self === 'string') return content.self
    if (typeof content.recalled === 'boolean') return ''
    return jsonText(content)
  }
  return ''
}

function speakerPlan(messages, ownerId, ownerName = '') {
  const names = new Map()
  for (const msg of messages) {
    if (msg.direction === 'out') continue
    names.set(String(msg.sender_id), baseDisplay(msg))
  }
  const counts = new Map()
  const keyBySender = new Map()
  for (const [id, name] of names) {
    const key = validSpeakerName(name, id)
    const earlier = keyBySender.get(id)
    if (earlier && earlier !== key) keyBySender.set(id, id)
    else if (!earlier) keyBySender.set(id, key)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  for (const [id, key] of [...keyBySender]) {
    const senderNames = [...messages.filter(m => String(m.sender_id) === id && m.direction !== 'out').map(baseDisplay)]
    if (new Set(senderNames).size > 1 || counts.get(key) > 1 || (ownerName && key === ownerName) || !key) keyBySender.set(id, id)
  }
  return keyBySender
}

export class Renderer {
  constructor(store, options = {}) {
    this.store = store
    this.selfId = String(options.selfId || '')
    this.ownerId = String(options.ownerId || '')
    this.quoteThreshold = Number(options.quoteThreshold || 160)
    this.resolveReply = options.resolveReply || (async () => null)
    this.replyFetch = options.replyFetch || (async () => null)
  }

  setIdentity({ selfId, ownerId, quoteThreshold }) {
    if (selfId !== undefined) this.selfId = String(selfId || '')
    if (ownerId !== undefined) this.ownerId = String(ownerId || '')
    if (quoteThreshold !== undefined) this.quoteThreshold = Number(quoteThreshold || 160)
  }

  authority(msg) {
    if (this.ownerId && String(msg.sender_id) === this.ownerId) return 'owner'
    return 'chat'
  }

  async resolveReplySegment(segment, msg, batchPositions) {
    const targetId = segment.targetId == null ? '' : String(segment.targetId)
    if (!targetId) return { reply: '?' }
    if (batchPositions.has(targetId)) return { reply: batchPositions.get(targetId) }
    let target = this.store.findByProtocol(msg.chat_type, msg.peer_id, targetId)
    if (!target) target = await this.replyFetch(msg.chat_type, msg.peer_id, targetId)
    if (!target) return { reply: '?' }
    const content = compactContent(target.segments || [], target, this)
    const text = contentPlainText(content)
    if (text.length <= this.quoteThreshold) {
      const key = target.direction === 'out' ? 'self' : (baseDisplay(target) || String(target.sender_id))
      return { reply: { [key]: content } }
    }
    return { reply: target.msg_ref }
  }

  async renderContent(msg, batchPositions = new Map()) {
    const segments = []
    for (const segment of msg.segments || []) {
      if (segment.type === 'reply') segments.push({ type: 'reply', rendered: (await this.resolveReplySegment(segment, msg, batchPositions)).reply })
      else segments.push(segment)
    }
    return compactContent(segments, msg, this)
  }

  async renderGroupBatch(receipt, messages, { bodyOnly = false } = {}) {
    const inbound = messages.filter(msg => !(msg.direction === 'out' && msg.origin !== 'dsh'))
    const ownerUser = this.ownerId ? this.store.user(this.ownerId) : null
    const ownerMessage = this.ownerId ? inbound.find(msg => String(msg.sender_id) === String(this.ownerId)) : null
    const ownerHint = ownerMessage ? baseDisplay(ownerMessage) : (ownerUser?.card || ownerUser?.nickname || '')
    const plan = speakerPlan(inbound, this.ownerId, ownerHint)
    const batchPositions = new Map()
    for (const item of receipt.items) {
      if (item.message.message_id != null) batchPositions.set(String(item.message.message_id), item.pos)
      if (item.message.message_seq != null) batchPositions.set(String(item.message.message_seq), item.pos)
    }
    const outMessages = []
    const speakerIds = new Set()
    const refIds = new Set()
    for (const msg of messages) {
      if (msg.direction === 'out' && msg.origin === 'dsh') continue
      const content = await this.renderContent(msg, batchPositions)
      if (msg.direction === 'out') outMessages.push({ self: content })
      else {
        const key = plan.get(String(msg.sender_id)) || String(msg.sender_id)
        outMessages.push({ [key]: content })
        speakerIds.add(String(msg.sender_id))
        for (const segment of msg.segments || []) {
          if (segment.type === 'at' && segment.qq && segment.qq !== 'all') refIds.add(String(segment.qq))
          if (segment.type === 'reply' && segment.targetId) {
            const target = this.store.findByProtocol(msg.chat_type, msg.peer_id, segment.targetId)
            if (target) refIds.add(String(target.sender_id))
          }
        }
      }
    }
    const ownerName = this.ownerId ? (this.store.user(this.ownerId)?.card || this.store.user(this.ownerId)?.nickname || this.ownerId) : ''
    const owner = this.ownerId ? { [this.ownerId]: cleanName(ownerName || this.ownerId) } : undefined
    const chatters = {}
    for (const id of [...speakerIds, ...refIds]) {
      if (!id || id === this.selfId) continue
      if (this.ownerId && id === this.ownerId) continue
      const user = this.store.user(id)
      chatters[id] = cleanName(user?.card || user?.nickname || '') || id
    }
    const last = messages[messages.length - 1] || receipt.items?.[receipt.items.length - 1]?.message
    const full = {
      receipt: receipt.receipt,
      group: String(receipt.peer_id),
      name: cleanName(this.store.conversation('group', receipt.peer_id)?.name || receipt.name || receipt.peer_id),
      time: formatClock(last?.ts || receipt.last_ts, !sameDay(last?.ts || receipt.last_ts)),
      ...(owner ? { owner } : {}),
      ...(Object.keys(chatters).length ? { chatters } : {}),
      messages: outMessages,
    }
    if (!bodyOnly) return full
    const body = {}
    if (owner) body.owner = owner
    if (Object.keys(chatters).length) body.chatters = chatters
    body.messages = outMessages
    return body
  }

  async renderPrivateBatch(receipt, messages, { bodyOnly = false } = {}) {
    const batchPositions = new Map()
    for (const item of receipt.items) {
      if (item.message.message_id != null) batchPositions.set(String(item.message.message_id), item.pos)
      if (item.message.message_seq != null) batchPositions.set(String(item.message.message_seq), item.pos)
    }
    const outMessages = []
    for (const msg of messages) {
      if (msg.direction === 'out' && msg.origin === 'dsh') continue
      const content = await this.renderContent(msg, batchPositions)
      outMessages.push(msg.direction === 'out' ? { self: content } : content)
    }
    const firstIn = messages.find(msg => msg.direction !== 'out') || messages[0]
    const last = messages[messages.length - 1]
    const conv = this.store.conversation('private', receipt.peer_id)
    const full = {
      receipt: receipt.receipt,
      private: String(receipt.peer_id),
      name: cleanName(conv?.name || receipt.name || firstIn?.sender_nickname || receipt.peer_id),
      time: formatClock(last?.ts || receipt.last_ts, !sameDay(last?.ts || receipt.last_ts)),
      authority: firstIn ? this.authority(firstIn) : 'chat',
      ...(receipt.group_id ? { tempGroup: String(receipt.group_id) } : {}),
      messages: outMessages,
    }
    if (!bodyOnly) return full
    const body = { authority: full.authority }
    if (full.tempGroup) body.tempGroup = full.tempGroup
    body.messages = outMessages
    return body
  }

  async renderBatch(receipt, { bodyOnly = false } = {}) {
    const messages = receipt.items.map(item => item.message)
    if (receipt.chat_type === 'group') return this.renderGroupBatch(receipt, messages, { bodyOnly })
    return this.renderPrivateBatch(receipt, messages, { bodyOnly })
  }

  async notificationLine(receipt, inlineThreshold, { forceLong = false } = {}) {
    const fullName = cleanName(this.store.conversation(receipt.chat_type, receipt.peer_id)?.name || receipt.name || receipt.peer_id)
    const kind = receipt.chat_type === 'group' ? 'group' : 'private'
    const body = await this.renderBatch(receipt, { bodyOnly: true })
    if (!forceLong && jsonLength(body) <= inlineThreshold) {
      return { line: `[QQ] ${receipt.receipt} ${kind}=${headerName(fullName)}(${receipt.peer_id}) ${jsonText(body)}`, inline: true, receipt }
    }
    const prefix = kind === 'group' ? '[QQ group]' : '[QQ private]'
    return { line: `${prefix} ${receipt.receipt} ${headerName(fullName)}(${receipt.peer_id}) ${receipt.message_count}条`, inline: false, receipt }
  }
}

