import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QQService } from '../lib/service.js'

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qq-test-')) }

class FakeClient {
  constructor() { this.connected = true; this.calls = []; this.nextId = 100 }
  getState() { return { connected: true, implementation: 'fixture', version: '1', capabilities: {} } }
  async action(name, params) {
    this.calls.push({ name, params })
    if (name.startsWith('send_') || name === 'send_msg') return { message_id: this.nextId++ }
    if (name === 'get_group_root_files') return { files: [], folders: [] }
    if (name === 'get_group_file_url') return { url: 'http://127.0.0.1/file' }
    if (name === 'get_msg') return null
    if (name === 'get_forward_msg') return { messages: [] }
    return {}
  }
}

function agent(id = 'session-a') {
  return {
    id, status: 'idle', wakes: [], followups: [],
    followup(message) { this.followups.push(message); this.wakes.push(message.content[0].text); this.status = 'running' },
  }
}

function setup(account = '10000', owner = '20000') {
  const dir = tmp()
  const a = agent()
  const client = new FakeClient()
  const svc = new QQService({ dataDir: dir, account, owner, onebot: {} }, { agents: { get: id => id === a.id ? a : undefined, list: () => [a] } })
  svc.started = true
  svc.client = client
  svc.openStore(account)
  svc.ensureHolder(a)
  svc.backlogNeeded = false
  return { svc, a, client, dir }
}

function groupEvent(mid, user = '20000', text = 'hello', extra = {}) {
  return {
    post_type: 'message', message_type: 'group', self_id: 10000, group_id: 123, user_id: Number(user),
    message_id: mid, time: Math.floor(Date.now() / 1000), sender: { user_id: Number(user), nickname: `u${user}`, card: `u${user}` },
    message: [{ type: 'text', data: { text } }], ...extra,
  }
}

test('buffers and delivers inline receipt once', async () => {
  const { svc, a } = setup()
  svc.store.patchScopedSettings('group:123', { silenceSeconds: 0, countMessages: 1, maxWaitSeconds: 0, inlineThreshold: 300 })
  await svc.handleEvent(groupEvent(1))
  await svc.tick()
  assert.equal(a.followups.length, 1)
  assert.match(a.wakes[0], /^\[QQ\] [0-9a-f]{8} group=/u)
  assert.match(a.wakes[0], /hello/u)
  assert.equal(svc.store.counts().buffered, 0)
  assert.equal(svc.store.counts().unprocessed, 0)
  assert.equal(svc.store.getReceipt(svc.store.stmt('SELECT receipt FROM receipts').get().receipt).state, 'read')
  svc.store.close()
})

test('recall stays in the same batch and keeps numbering', async () => {
  const { svc, a } = setup()
  svc.store.patchScopedSettings('group:123', { silenceSeconds: 0, countMessages: 2, maxWaitSeconds: 0, inlineThreshold: 500 })
  await svc.handleEvent(groupEvent(1, '20000', 'one'))
  await svc.handleEvent(groupEvent(2, '30000', 'two'))
  await svc.handleNotice({ post_type: 'notice', notice_type: 'group_recall', group_id: 123, user_id: 30000, message_id: 2 })
  await svc.tick()
  assert.equal(a.followups.length, 1)
  assert.match(a.wakes[0], /recalled/u)
  const receipt = svc.store.stmt('SELECT receipt FROM receipts').get().receipt
  const full = await svc.receive({ receipt }, a)
  assert.equal(full.messages.length, 2)
  assert.equal(full.group, '123')
  svc.store.close()
})

test('binding takeover is one-way for the old session', async () => {
  const { svc } = setup()
  const b = agent('session-b')
  svc.agents = { get: id => id === b.id ? b : undefined, list: () => [b] }
  svc.ensureHolder(b)
  assert.throws(() => svc.ensureHolder(agent('session-a')), /已被其他会话接管/u)
  assert.equal(svc.store.getBindings().session_id, 'session-b')
  svc.store.close()
})

test('unbound backlog produces one summary notification', async () => {
  const { svc, a } = setup()
  const dir = svc.store.dir
  svc.store.close()
  const svc2 = new QQService({ dataDir: path.dirname(path.dirname(dir)), account: '10000', owner: '20000' }, { agents: { get: () => a, list: () => [a] } })
  svc2.started = true; svc2.client = new FakeClient()
  // Re-open a fresh isolated store instead of depending on the first temp path.
  svc2.config.dataDir = tmp(); svc2.openStore('10000')
  await svc2.handleEvent(groupEvent(1, '20000', 'a'))
  await svc2.handleEvent({ ...groupEvent(2, '20000', 'b'), message_type: 'private', user_id: 20000, group_id: undefined })
  svc2.ensureHolder(a)
  svc2.backlogNeeded = true
  await svc2.tick()
  assert.equal(a.followups.length, 1)
  assert.match(a.wakes[0], /^\[QQ backlog\]/u)
  assert.match(a.wakes[0], /未处理批/u)
  svc2.store.close()
})

test('silent receipt and split send', async () => {
  const { svc, a, client } = setup()
  svc.store.patchScopedSettings('private:20000', { silenceSeconds: 0, countMessages: 1, maxWaitSeconds: 0, inlineThreshold: 500 })
  await svc.handleEvent({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20000, message_id: 1, time: Math.floor(Date.now()/1000), sender: { user_id: 20000, nickname: 'owner' }, message: [{ type: 'text', data: { text: 'ping' } }] })
  await svc.tick()
  const receipt = svc.store.stmt('SELECT receipt FROM receipts').get().receipt
  const silent = await svc.send({ receipt }, a)
  assert.equal(silent.state, 'silent')
  assert.equal(svc.store.getReceipt(receipt).state, 'silent')
  svc.store.patchScopedSettings('private:20000', { splitDelayMs: 0 })
  const sent = await svc.send({ target: 'private:20000', content: ['a', { split: true }, 'b'] }, a)
  assert.equal(sent.sent, 2)
  assert.equal(client.calls.filter(c => c.name === 'send_private_msg').length, 2)
  svc.store.close()
})

test('owner confirmation controls whitelist and direct changes are refused', async () => {
  const { svc, a, client } = setup()
  const pending = await svc.settings({ whitelist: { add: ['group:123'] } }, a)
  assert.equal(pending.pending.length, 1)
  assert.equal(svc.store.listWhitelist().length, 0)
  const id = pending.pending[0].id
  await svc.handleEvent({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20000, message_id: 9, time: Math.floor(Date.now()/1000), sender: { user_id: 20000 }, message: [{ type: 'text', data: { text: `同意 ${id}` } }] })
  assert.deepEqual(svc.store.listWhitelist(), ['group:123'])
  assert.equal(client.calls.some(c => c.name === 'send_private_msg'), true)
  await assert.rejects(() => svc.settings({ set: { whitelist: ['group:999'] } }, a), /whitelist.add/u)
  svc.store.close()
})

test('settings inherit and DND duration validation', async () => {
  const { svc, a } = setup()
  await svc.settings({ target: 'group:all', set: { silenceSeconds: 2 } }, a)
  await svc.settings({ target: 'group:123', set: { silenceSeconds: 3 } }, a)
  assert.equal(svc.store.effectiveSettings('group:123').silenceSeconds, 3)
  await svc.settings({ target: 'group:123', set: { silenceSeconds: 'inherit' } }, a)
  assert.equal(svc.store.effectiveSettings('group:123').silenceSeconds, 2)
  await assert.rejects(() => svc.settings({ target: 'group:123', set: { dnd: 'all' } }, a), /dndHours/u)
  await svc.settings({ target: 'group:123', set: { dnd: 'all', dndHours: 1 } }, a)
  assert.equal(svc.store.effectiveSettings('group:123').dnd, 'all')
  svc.store.close()
})


test('group speaker names disambiguate collisions and reply numbering stays in batch', async () => {
  const { svc, a } = setup()
  svc.store.patchScopedSettings('group:123', { silenceSeconds: 0, countMessages: 3, maxWaitSeconds: 0, inlineThreshold: 1000 })
  await svc.handleEvent(groupEvent(1, '20000', 'owner'))
  await svc.handleEvent(groupEvent(2, '30000', 'a', { sender: { user_id: 30000, nickname: 'same', card: 'same' } }))
  await svc.handleEvent(groupEvent(3, '40000', 'b', { sender: { user_id: 40000, nickname: 'same', card: 'same' }, message: [{ type: 'reply', data: { id: '2' } }, { type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: 'go' } }] }))
  await svc.tick()
  const receipt = svc.store.stmt('SELECT receipt FROM receipts').get().receipt
  const full = await svc.receive({ receipt }, a)
  assert.equal(full.messages.length, 3)
  assert.equal(full.messages[1]['30000'], 'a')
  assert.equal(full.messages[2]['40000'][0].reply, 2)
  assert.equal(full.owner['20000'], 'u20000')
  svc.store.close()
})

test('DND at stores messages but only wakes on direct at/reply', async () => {
  const { svc, a } = setup()
  svc.store.patchScopedSettings('group:123', { silenceSeconds: 0, countMessages: 1, maxWaitSeconds: 0, dnd: 'at', inlineThreshold: 500 })
  await svc.handleEvent(groupEvent(1, '30000', 'ambient'))
  await svc.tick()
  assert.equal(a.followups.length, 0)
  assert.equal(svc.store.counts().buffered, 1)
  await svc.handleEvent(groupEvent(2, '30000', 'direct', { message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: 'look' } }] }))
  await svc.tick()
  assert.equal(a.followups.length, 1)
  assert.match(a.wakes[0], /ambient/u)
  assert.match(a.wakes[0], /look/u)
  svc.store.close()
})

test('local image is downloaded to a stable media path', async () => {
  const { svc, a } = setup()
  const source = path.join(svc.store.dir, 'source.png')
  fs.writeFileSync(source, Buffer.from([137, 80, 78, 71]))
  svc.store.patchScopedSettings('private:20000', { silenceSeconds: 0, countMessages: 1, maxWaitSeconds: 0, inlineThreshold: 500 })
  await svc.handleEvent({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20000, message_id: 5, time: Math.floor(Date.now()/1000), sender: { user_id: 20000, nickname: 'owner' }, message: [{ type: 'image', data: { file: source, file_size: 4, url: `file:///${source.replace(/\\/g, '/')}` } }] })
  await svc.tick()
  const receipt = svc.store.stmt('SELECT receipt FROM receipts').get().receipt
  const full = await svc.receive({ receipt }, a)
  const mediaRef = full.messages[0].image
  const media = await svc.ref({ ref: mediaRef }, a)
  assert.equal(media.status, 'downloaded')
  assert.equal(fs.existsSync(media.path), true)
  svc.store.close()
})

test('receipt reply quotes by batch number and marks replied', async () => {
  const { svc, a, client } = setup()
  svc.store.patchScopedSettings('private:20000', { silenceSeconds: 0, countMessages: 1, maxWaitSeconds: 0, inlineThreshold: 500 })
  await svc.handleEvent({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20000, message_id: 321, time: Math.floor(Date.now()/1000), sender: { user_id: 20000, nickname: 'owner' }, message: [{ type: 'text', data: { text: 'question' } }] })
  await svc.tick()
  const receipt = svc.store.stmt('SELECT receipt FROM receipts').get().receipt
  const result = await svc.send({ receipt, reply: 1, content: 'answer' }, a)
  assert.equal(result.state, 'replied')
  const call = client.calls.filter(c => c.name === 'send_private_msg').at(-1)
  assert.equal(call.params.message[0].type, 'reply')
  assert.equal(call.params.message[0].data.id, '321')
  assert.equal(svc.store.getReceipt(receipt).state, 'replied')
  svc.store.close()
})

test('setup tool is independent from binding and documents reload/security timing', async () => {
  const dir = tmp()
  const svc = new QQService({ dataDir: dir, account: '', owner: '' }, { agents: { get() {}, list() { return [] } } })
  svc.started = true
  const guide = await svc.setupTool({ action: 'guide' }, null)
  assert.match(guide.title, /quick start/iu)
  assert.equal(guide.status.configExists, false)
  assert.equal(Array.isArray(guide.timing), true)
  assert.equal(guide.installLocationPolicy.askBeforeExtract, true)
  assert.equal(guide.installLocationPolicy.askOnce, true)
  assert.match(guide.installLocationPolicy.askLanguage, /same language/iu)
  assert.equal(guide.installLocationPolicy.requiredQuestions.some(line => /ask once/iu.test(line)), true)
  assert.equal(guide.installLocationPolicy.onlyAskAgainWhen.length > 0, true)
  assert.equal(guide.timing.some(line => /reload|watches/u.test(line)), true)
  assert.equal(guide.afterReboot.some(line => /plugin is loaded|launcher|inject|reinstall|qq_setup/u.test(line)), true)
  assert.equal(guide.windowsSecurity.some(line => /Low Integrity|Unblock/u.test(line)), true)
  const viaChannel = await svc.channel({ module: 'setup' }, null)
  assert.match(viaChannel.title, /quick start/iu)
})

