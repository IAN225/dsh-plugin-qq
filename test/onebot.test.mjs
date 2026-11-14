import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { OneBotClient } from '../lib/onebot.js'

function listen(server, port = 0) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)) })
}

test('OneBot HTTP transport authenticates events, probes identity and dispatches actions', async () => {
  let actionPort
  const actionServer = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const payload = JSON.parse(body)
    const data = payload.action === 'get_login_info' ? { user_id: 10000, nickname: 'bot' }
      : payload.action === 'get_version_info' ? { app_name: 'SnowLuma', app_version: '2.2.0' }
        : payload.action === 'send_private_msg' ? { message_id: 42 }
          : {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data, echo: payload.echo }))
  })
  actionPort = await listen(actionServer)
  const events = []
  let readyResolve
  const ready = new Promise(resolve => { readyResolve = resolve })
  const client = new OneBotClient({
    mode: 'http', httpUrl: `http://127.0.0.1:${actionPort}/`, accessToken: 'secret',
    listenHost: '127.0.0.1', listenPort: 0, listenPath: '/events', reconnectMs: 10,
  }, {
    onEvent: event => events.push(event),
    onReady: payload => readyResolve(payload),
  })
  // Node cannot listen on port 0 through the client's string option; pick a free port.
  const probe = http.createServer(); const port = await listen(probe); await new Promise(r => probe.close(r))
  client.options.listenPort = port
  await client.start()
  const identity = await ready
  assert.equal(identity.state.selfId, '10000')
  assert.match(identity.state.implementation, /SnowLuma/u)
  const response = await fetch(`http://127.0.0.1:${port}/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({ post_type: 'message', self_id: 10000, user_id: 20000, message_id: 1, message: [] }),
  })
  assert.equal(response.status, 204)
  assert.equal(events.length, 1)
  const sent = await client.action('send_private_msg', { user_id: 20000, message: [] })
  assert.equal(sent.message_id, 42)
  await client.stop()
  await new Promise(resolve => actionServer.close(resolve))
})
