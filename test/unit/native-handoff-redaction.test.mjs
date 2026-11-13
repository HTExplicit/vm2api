import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { streamGoWorker } from '../../src/lib/transport/go-worker-client.mjs'
import { consumeNativeHandoffStream, createNativeHandoffState } from '../../src/lib/protocol/native-handoff.mjs'
import { normalizeRedaction } from '../../src/lib/redaction/policy.mjs'
import { createSseRestorer, publishRedactionForTests } from '../../src/lib/redaction/runtime.mjs'

const MODEL = 'claude-sonnet-5-actual'
const USAGE = { input_tokens: 7, output_tokens: 3 }
const TAG = '{{R_API_KEY_abcdefghijklmnopqrstuvwxyz}}'
const SECRET = 'restored-account-value'
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const summary = (stop = 'end_turn') => ({
  type: 'kin_provider_result',
  message_id: 'msg_native_redaction',
  model: MODEL,
  stop_reason: stop,
  stop_sequence: null,
  usage: USAGE,
  usage_complete: true,
})
const start = () =>
  frame({
    type: 'message_start',
    message: {
      id: 'msg_native_redaction',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  })
const terminal = (stop = 'end_turn') =>
  frame(summary(stop)) +
  frame({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: USAGE }) +
  frame({ type: 'message_stop' })
const text = (value) =>
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } }) +
  frame({ type: 'content_block_stop', index: 0 })
const eventsFrom = (lines) => lines.filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))

async function fixture(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-native-restore-'))
  const socket =
    process.platform === 'win32' ? `\\\\.\\pipe\\kin-native-${randomUUID()}` : path.join(root, 'worker.sock')
  const token = path.join(root, 'internal.token')
  fs.writeFileSync(token, 'native-restore-fixture')
  const server = http.createServer(async (req, res) => {
    if (req.url === '/internal/v1/cancel') {
      req.resume()
      res.end('{}')
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    await handler(res, JSON.parse(Buffer.concat(chunks).toString('utf8')))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  t.after(async () => {
    publishRedactionForTests(null)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    exec: {
      homeDir: path.join(root, 'home'),
      workerStatus: { runtime_variant: 'crag-v2', capabilities: ['native_handoff_v1'] },
      vm: { runtime: { worker_socket: socket, worker_token_file: token } },
    },
    managedCrag: true,
    envelope: {
      body: { model: 'claude-sonnet-5-requested', max_tokens: 32, messages: [{ role: 'user', content: 'fixture' }] },
      headers: {},
      stream: true,
    },
    timeoutMs: 3000,
  }
}

function redactionFixture(t) {
  const policy = normalizeRedaction({ enabled: true, secrets: true, personal: false })
  const restored = []
  publishRedactionForTests({
    enabled: true,
    ready: true,
    policy,
    client: {
      async mask({ body }) {
        return { body }
      },
      async restore({ principal, session, maxBodyBytes, body }) {
        assert.equal(principal, 'native-principal')
        assert.equal(session, 'native-session')
        assert.equal(maxBodyBytes, 64 * 1024 * 1024)
        restored.push(JSON.parse(body))
        return { body: body.replaceAll(TAG, SECRET) }
      },
    },
  })
  t.after(() => publishRedactionForTests(null))
  return {
    routing: { redaction: policy, failover: { max_request_mib: 64 } },
    redactionPrincipal: 'native-principal',
    redactionSession: 'native-session',
    restored,
  }
}

for (const [field, block, deltaType] of [
  ['text', { type: 'text', text: '' }, 'text_delta'],
  ['thinking', { type: 'thinking', thinking: '' }, 'thinking_delta'],
  ['partial_json', { type: 'tool_use', id: 'tool_native', name: 'lookup', input: {} }, 'input_json_delta'],
]) {
  test(`native SSE restores a split ${field} placeholder before terminal validation`, async (t) => {
    const stop = field === 'partial_json' ? 'tool_use' : 'end_turn'
    const pieces = [TAG.slice(0, 1), TAG.slice(1, -1), TAG.slice(-1)]
    if (field === 'partial_json') {
      pieces[0] = `{"query":"${pieces[0]}`
      pieces[2] += '"}'
    }
    const wire =
      start() +
      frame({ type: 'content_block_start', index: 2, content_block: block }) +
      pieces
        .map((value) => frame({ type: 'content_block_delta', index: 2, delta: { type: deltaType, [field]: value } }))
        .join('') +
      frame({ type: 'content_block_stop', index: 2 }) +
      terminal(stop)
    const args = await fixture(t, (res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.end(wire)
    })
    const redaction = redactionFixture(t)
    const lines = []
    const received = await streamGoWorker({ ...args, ...redaction, onEvent: (line) => lines.push(line) })
    assert.equal(received.ok, true)
    assert.equal(received.upstreamResponseModel, MODEL)
    const blockValue = received.body.content.find((value) => value?.type === block.type)
    assert.equal(field === 'partial_json' ? blockValue.input.query : blockValue[field], SECRET)
    const restoredDeltas = eventsFrom(lines).filter((event) => event.type === 'content_block_delta')
    const value = restoredDeltas.map((event) => event.delta[field]).join('')
    assert.equal(field === 'partial_json' ? JSON.parse(value).query : value, SECRET)
    assert.equal(
      redaction.restored.some((event) => event.type === 'kin_provider_result'),
      false,
    )
    assert.doesNotMatch(lines.join('\n'), /kin_provider_result|\{\{R_API_KEY_/)
  })
}

test('native SSE emits a literal redaction tail before its block stop', async (t) => {
  const args = await fixture(t, (res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.end(start() + text('literal {') + terminal())
  })
  const lines = []
  const received = await streamGoWorker({ ...args, ...redactionFixture(t), onEvent: (line) => lines.push(line) })
  assert.equal(received.ok, true)
  assert.equal(received.body.content[0].text, 'literal {')
  const events = eventsFrom(lines)
  const tail = events.findIndex((event) => event.delta?.text === '{')
  assert.ok(tail > 0)
  assert.ok(tail < events.findIndex((event) => event.type === 'content_block_stop'))
})

test('native EOF flushes a literal tail before rejecting the missing terminal', async (t) => {
  redactionFixture(t)
  const wire =
    start() +
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'literal {' } })
  const response = Readable.from([wire])
  response.headers = {}
  response.trailers = {}
  const lines = []
  await assert.rejects(
    consumeNativeHandoffStream(response, {
      state: createNativeHandoffState(),
      sseRestorer: createSseRestorer({
        principal: 'native-principal',
        session: 'native-session',
        maxBodyBytes: 64 * 1024 * 1024,
      }),
      onEvent: (line) => lines.push(line),
      isCommitEvent: (event) => event.type === 'content_block_delta' && !!event.delta?.text,
    }),
    { code: 'native_handoff_missing' },
  )
  const events = eventsFrom(lines)
  assert.equal(
    events
      .filter((event) => event.type === 'content_block_delta')
      .map((event) => event.delta.text)
      .join(''),
    'literal {',
  )
  assert.equal(
    events.some((event) => event.type === 'message_stop'),
    false,
  )
})

for (const ending of ['complete', 'missing-terminal', 'transport-error']) {
  test(`native ${ending} keeps the observed response model instead of the requested model`, async (t) => {
    const args = await fixture(t, async (res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.write(start() + text('observed output'))
      if (ending === 'transport-error') {
        await new Promise((resolve) => setTimeout(resolve, 20))
        res.destroy()
      } else res.end(ending === 'complete' ? terminal() : '')
    })
    const received = await streamGoWorker(args)
    assert.equal(received.ok, ending === 'complete')
    assert.equal(received.upstreamResponseModel, MODEL)
  })
}

test('native metadata alone does not fill the response model log', async (t) => {
  const args = await fixture(t, (res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.end(frame(summary()))
  })
  const received = await streamGoWorker(args)
  assert.equal(received.ok, false)
  assert.equal(received.body.error.code, 'native_handoff_incomplete')
  assert.equal(received.upstreamResponseModel, null)
})

test('native HTTP errors keep a response model reported in the error body', async (t) => {
  const args = await fixture(t, (res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        type: 'error',
        response: { model: MODEL },
        error: { type: 'rate_limit_error', message: 'fixture limit' },
      }),
    )
  })
  const received = await streamGoWorker(args)
  assert.equal(received.ok, false)
  assert.equal(received.status, 429)
  assert.equal(received.upstreamResponseModel, MODEL)
})
