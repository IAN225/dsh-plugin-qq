import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { OneBotClient } from '../lib/onebot.js'

function encodeFrame(text) {
  const body = Buffer.from(text)
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body])
  const head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(body.length, 2)
  return Buffer.concat([head, body])
}

function decodeClientFrame(buffer, state) {
  const frames = []
  while (buffer.length >= 2) {
    if (buffer.length < 2) break
    const opcode = buffer[0] & 0x0f
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4 }
    else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
    const masked = (buffer[1] & 0x80) !== 0
    const maskOffset = offset
    if (masked) offset += 4
    if (buffer.length < offset + length) break
    let payload = buffer.subarray(offset, offset + length)
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4)
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))
    }
    frames.push({ opcode, payload, rawLength: offset + length })
    buffer = buffer.subarray(offset + length)
  }
  state.buffer = buffer
  return frames
}

test('OneBot WebSocket transport receives events and correlates actions', async () => {
  let clientSocket
  const events = []
  let readyResolve
  const ready = new Promise(resolve => { readyResolve = resolve })
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    clientSocket = socket
    const state = { buffer: Buffer.alloc(0) }
    socket.on('data', chunk => {
      state.buffer = Buffer.concat([state.buffer, chunk])
      for (const frame of decodeClientFrame(state.buffer, state)) {
        if (frame.opcode !== 1) continue
        const payload = JSON.parse(frame.payload.toString('utf8'))
        if (payload.action === 'get_login_info') {
          socket.write(encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, echo: payload.echo, data: { user_id: 10000 } })))
        } else if (payload.action === 'get_version_info') {
          socket.write(encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, echo: payload.echo, data: { app_name: 'NapCat.Onebot', app_version: '4.0' } })))
        } else if (payload.action === 'send_group_msg') {
          socket.write(encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, echo: payload.echo, data: { message_id: 77 } })))
        }
      }
    })
    setTimeout(() => {
      if (clientSocket) clientSocket.write(encodeFrame(JSON.stringify({ post_type: 'message', self_id: 10000, message_type: 'group', group_id: 1, user_id: 2, message_id: 3, message: [] })))
    }, 10)
  })
  const port = await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)) })
  const client = new OneBotClient({
    mode: 'ws', url: `ws://127.0.0.1:${port}/`, accessToken: 'token', reconnectMs: 10, requestTimeoutMs: 3000,
  }, {
    onEvent: event => events.push(event),
    onReady: payload => readyResolve(payload),
  })
  await client.start()
  const identity = await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('ready timeout')), 3000))])
  assert.equal(identity.state.selfId, '10000')
  assert.match(identity.state.implementation, /NapCat/u)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(events.length, 1)
  const result = await client.action('send_group_msg', { group_id: 1, message: [] })
  assert.equal(result.message_id, 77)
  await client.stop()
  try { clientSocket?.destroy() } catch {}
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
})


