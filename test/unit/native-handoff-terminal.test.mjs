import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

const MODEL = 'claude-haiku-4-5'
const HEALTH = {
  ok: true,
  runtime_variant: 'crag-v2',
  gateway_policy_v1: true,
  capabilities: ['native_handoff_v1'],
}
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const summary = (overrides = {}) => ({
  type: 'kin_provider_result',
  message_id: 'msg_native_terminal',
  model: MODEL,
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 2 },
  usage_complete: true,
  ...overrides,
})
const partial = () =>
  [
    {
      type: 'message_start',
      message: {
        type: 'message',
        id: 'msg_native_terminal',
        role: 'assistant',
        model: MODEL,
        content: [],
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial output' } },
  ]
    .map(frame)
    .join('')

function response() {
  return {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    chunks: [],
    writeHead(status) {
      this.statusCode = status
      this.headersSent = true
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end() {
      this.writableEnded = true
    },
    on() {},
    once() {},
    off() {},
    setHeader() {},
  }
}

function handler({ root, protocol, run }) {
  const routing = { compatibility: {}, failover: { stream_keepalive_ms: 1000, queue_keepalive_delay_ms: 5000 } }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const input = {
    model: MODEL,
    max_tokens: 32,
    stream: true,
    ...(protocol === 'openai.completions'
      ? { prompt: 'one offline inference turn' }
      : { messages: [{ role: 'user', content: 'one offline inference turn' }] }),
  }
  return createHandleProtocol({
    json(res, status, body) {
      res.writeHead(status)
      res.body = body
      res.end()
      return body
    },
    writeSSEHeaders: (res) => res.writeHead(200),
    readBody: async () => input,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: {
        max_body_bytes: 1024 * 1024,
        upstream_timeout_ms: 2000,
        stream_idle_timeout_ms: 2000,
        stream_keepalive_ms: 1000,
        queue_keepalive_delay_ms: 5000,
      },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: 'native-terminal', mode: 'normal', t0: Date.now() }),
      finish() {},
    },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: { run },
  })
}

async function invoke(instance, res, protocol) {
  const url = {
    'openai.chat': '/v1/chat/completions',
    'openai.completions': '/v1/completions',
    'openai.responses': '/v1/responses',
  }[protocol]
  await instance.handleProtocol(
    {
      method: 'POST',
      url,
      headers: { authorization: 'Bearer master' },
      apiKeyKind: 'master',
      once() {},
      off() {},
    },
    res,
    protocol,
    url,
  )
}

async function fixture(t, protocol, emit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-native-terminal-'))
  const socketPath =
    process.platform === 'win32' ? `\\\\.\\pipe\\kin-native-terminal-${randomUUID()}` : path.join(root, 'kernel.sock')
  const tokenPath = path.join(root, 'internal.token')
  fs.writeFileSync(tokenPath, 'offline-native-terminal-token')
  let executions = 0
  const requests = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    executions++
    emit(res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const exec = {
    projectRoot: root,
    homeDir: path.join(root, 'cli-home'),
    vm: {
      id: 'native-terminal-test',
      runtime: { kernel_socket: socketPath, worker_run_dir: root, worker_token_file: tokenPath },
    },
  }
  const instance = handler({
    root,
    protocol,
    run: async ({ callAttempt }) =>
      callAttempt({
        candidate: { exec, vmId: 'native-terminal-test' },
        body: { model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'offline turn' }], stream: true },
        attemptMeta: {
          cliHop: true,
          cragPrint: true,
          preparedHop: { decision: { wanted: 'rust', blocked: false }, ready: { ok: true, health: HEALTH } },
        },
        deliveryMode: 'realtime',
        onCommit() {},
      }),
  })
  const res = response()
  await invoke(instance, res, protocol)
  assert.equal(executions, 1)
  assert.equal(requests[0].gateway_policy.native_handoff_v1, true)
  return res
}

const failures = {
  'missing provider summary': (res) => res.end(),
  'conflicting provider summary': (res) => res.end(frame(summary({ message_id: 'msg_other' }))),
  'provider error': (res) =>
    res.end(
      frame(
        summary({
          stop_reason: null,
          usage_complete: false,
          http_status: 502,
          error: { type: 'api_error', code: 'provider_failed', message: 'offline provider failure' },
        }),
      ),
    ),
}

for (const protocol of ['openai.chat', 'openai.completions']) {
  for (const [name, end] of Object.entries(failures)) {
    test(`${protocol} native partial output reports ${name} once and closes without success`, async (t) => {
      const res = await fixture(t, protocol, (upstream) => {
        upstream.writeHead(200, { 'content-type': 'text/event-stream' })
        upstream.write(partial())
        end(upstream)
      })
      const output = res.chunks.join('')
      const data = output
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
      const events = data.filter((value) => value !== '[DONE]').map((value) => JSON.parse(value))
      assert.equal(res.statusCode, 200)
      assert.equal(res.writableEnded, true)
      assert.match(output, /partial output/)
      assert.equal(events.filter((event) => event.error).length, 1)
      assert.equal(data.filter((value) => value === '[DONE]').length, 1)
      assert.ok(events.at(-1).error)
      assert.equal(
        events.some((event) => event.choices?.some((choice) => choice.finish_reason != null)),
        false,
      )
      assert.doesNotMatch(output, /kin_provider_result|response\.completed|message_stop/)
    })
  }

  test(`${protocol} native failure before output keeps its JSON error status`, async (t) => {
    const res = await fixture(t, protocol, (upstream) => {
      upstream.writeHead(200, { 'content-type': 'text/event-stream' })
      upstream.end()
    })
    assert.equal(res.statusCode, 502)
    assert.ok(res.body.error)
    assert.equal(res.chunks.length, 0)
  })

  test(`${protocol} native client cancellation closes without an error or successful terminal`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-native-cancel-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const res = response()
    const instance = handler({
      root,
      protocol,
      run: async () => {
        res.writeHead(200)
        return { ok: false, nativeHandoff: true, status: 499, terminalState: 'cancelled', committed: true }
      },
    })
    await invoke(instance, res, protocol)
    assert.equal(res.writableEnded, true)
    assert.equal(res.chunks.length, 0)
  })
}

test('Claude Responses remains rejected before native worker selection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-native-responses-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let selected = 0
  const instance = handler({
    root,
    protocol: 'openai.responses',
    run: async () => {
      selected++
    },
  })
  const res = response()
  await invoke(instance, res, 'openai.responses')
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'protocol_not_allowed')
  assert.equal(selected, 0)
})
