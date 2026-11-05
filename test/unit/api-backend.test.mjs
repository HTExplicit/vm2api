import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { CRS_OFFICIAL_AGENT_PROMPT, CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
import { OFFICIAL_303_HARNESS } from '../../src/lib/identity/official-profiles.mjs'
import { sessionIdFromOutboundBody } from '../../src/lib/identity/identity-rewrite.mjs'
import { DEFAULT_AGENT_STANDING } from '../../src/lib/identity/persona-template.mjs'
import {
  isOpenAIResponsesCommitEvent,
  resolveInferenceBackend,
  messagesUrl,
  runApiInference,
} from '../../src/lib/pool/api-protocol.mjs'
import { createClaudeMessageAssembler, applyClaudeSSELineToMessage } from '../../src/lib/protocol/convert.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import { classifierFixture } from '../fixtures/auto-mode.mjs'
import { classifyClaudeRequestPurpose } from '../../src/lib/protocol/request-purpose.mjs'
import { isOfficialClaudeCodeTraffic } from '../../src/lib/identity/crs-persona.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test

function fakeResponse() {
  return { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
}

function messageStart() {
  return `data: ${JSON.stringify({
    type: 'message_start',
    message: { type: 'message', role: 'assistant', content: [], model: 'upstream-model' },
  })}\n\n`
}

function messageStop() {
  return `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`
}

function completeAnthropicSse(extraEvents = '') {
  return messageStart() + extraEvents + messageStop()
}

test('only a managed key explicitly marked api uses the Anthropic address path', () => {
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'managed', apiKeyRecord: { category: 'api' } }), 'api')
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'managed', apiKeyRecord: { category: ' API ' } }), 'api')
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'managed', apiKeyRecord: { category: 'oauth' } }), 'oauth')
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'managed', apiKeyRecord: {} }), 'oauth')
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'master', headers: { 'x-kin-backend': 'api' } }), 'oauth')
  assert.equal(resolveInferenceBackend({ apiKeyKind: 'master', apiKeyRecord: { category: 'api' } }), 'oauth')
  assert.equal(resolveInferenceBackend({ headers: { 'x-kin-backend': 'api' } }), 'oauth')
})

test('tenant api-category keys cannot reach platform API endpoints', async () => {
  const response = fakeResponse()
  let picked = 0
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: os.tmpdir() },
    },
    requestLog: { start: () => ({ request_id: 'api-tenant-test' }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, users: { getById: () => ({ role: 'user' }) } },
    apiScheduler: {
      pick: () => {
        picked += 1
        return { ok: false }
      },
    },
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfig: { failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-tenant', 'user-agent': 'test-client' },
    apiKeyKind: 'managed',
    apiKeyRecord: { category: 'api', user_id: 'u1' },
    once() {},
    off() {},
  }
  await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'api_backend_forbidden')
  assert.equal(picked, 0)
})

test('messagesUrl appends /v1/messages?beta=true', () => {
  assert.equal(messagesUrl('https://api.example.com'), 'https://api.example.com/v1/messages?beta=true')
  assert.equal(messagesUrl('https://api.example.com/'), 'https://api.example.com/v1/messages?beta=true')
})

async function runOfficialFullApiFixture({ input = {}, extraEvents = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-persona-'))
  const routingFile = path.join(root, 'routing.json')
  const socketPath = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  fs.writeFileSync(
    routingFile,
    JSON.stringify({
      compatibility: {
        persona_preset: 'official_full',
        overlay_preset: 'off',
        agent_standing_presets: { official_full: true },
      },
    }),
  )
  let received = null
  const kernel = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(completeAnthropicSse(extraEvents))
    })
  })
  await new Promise((resolve, reject) => {
    kernel.once('error', reject)
    kernel.listen(socketPath, resolve)
  })
  const response = fakeResponse()
  const stats = { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }], ...input }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root },
    },
    requestLog: { start: () => ({ request_id: 'api-persona-test' }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: {
      pick: () => ({
        ok: true,
        endpoint: { id: 'ep-test', kind: 'claude', protocol: 'anthropic', base_url: 'https://upstream.invalid' },
        upstream_model: 'claude-haiku-4-5',
        key: { id: 'key-test', api_key: 'secret' },
      }),
    },
    apiEndpointStore: {},
    stats,
    routingConfigPath: routingFile,
    routingConfig: {
      compatibility: {
        persona_preset: 'official_full',
        overlay_preset: 'off',
        agent_standing_presets: { official_full: true },
      },
      failover: {},
    },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-api', 'user-agent': 'test-client' },
    apiKeyKind: 'managed',
    apiKeyRecord: { category: 'api' },
    once() {},
    off() {},
  }
  try {
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    assert.equal(response.status, 200)
    assert.ok(received)
    const outbound = JSON.parse(received.body)
    const texts = outbound.system.map((block) => String(block.text || ''))
    const shape = JSON.stringify({
      system: texts.map((t) => t.slice(0, 60)),
      roles: outbound.messages.map((m) => m.role),
    })
    assert.match(texts[0], /^x-anthropic-billing-header: /, shape)
    assert.equal(texts[1], CRS_OFFICIAL_CLI_SYSTEM, shape)
    assert.ok(texts[2].startsWith(`${DEFAULT_AGENT_STANDING}\n${OFFICIAL_303_HARNESS}`), shape)
    assert.equal(
      texts.some((text) => text.includes(CRS_OFFICIAL_AGENT_PROMPT.slice(0, 80))),
      false,
      shape,
    )
    // claude-haiku-4-5 rejects mid-conversation role=system: the Environment must not reach the wire as a message.
    assert.equal(
      outbound.messages.some((message) => message.role === 'system'),
      false,
      shape,
    )
    assert.ok(
      texts.some((text) => text.includes('# Environment')),
      shape,
    )
    return { outbound, response }
  } finally {
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('API backend applies the global official_full persona setting', () => runOfficialFullApiFixture())

test('Anthropic API direct restores a rewritten tool name in its assembled response', async () => {
  const events = [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tool-api', name: 'mcp__read_file', input: { path: 'example.txt' } },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
  ]
  const run = await runOfficialFullApiFixture({
    input: { tools: [{ name: 'read_file', input_schema: { type: 'object', properties: {} } }] },
    extraEvents: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  })
  assert.equal(run.outbound.tools[0].name, 'mcp__read_file')
  assert.equal(run.response.body.content[0].name, 'read_file')
  assert.equal(run.response.body.content[0].id, 'tool-api')
})

test('OAuth cli-hop applies the resolved Protocol custom persona template', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-persona-'))
  const routingFile = path.join(root, 'routing.json')
  const compatibility = {
    persona_preset: 'custom',
    persona_inject: 'rewrite',
    // e358143c: {{timezone}} renders only when the per-preset timezone switch is on.
    persona_timezone_presets: { custom: true },
    persona_templates: {
      custom: [{ id: 'custom', type: 'text', text: 'CUSTOM_PERSONA {{timezone}}' }],
    },
  }
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility }))
  const vm = { id: 'vm-01', claude: { mode: 'oauth' } }
  const selected = {
    vmId: vm.id,
    accountId: 'account-1',
    vm,
    exec: {
      vmId: vm.id,
      vm,
      homeDir: path.join(root, 'home'),
      oauth: { account_uuid: 'account-1' },
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
    },
  }
  let prepared = null
  const response = fakeResponse()
  const stats = { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'slot-persona-test' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    stats,
    routingConfigPath: routingFile,
    routingConfig: { compatibility, failover: {} },
    failoverRunner: {
      async run(opts) {
        prepared = await opts.applyAttempt(opts.canonicalBody, selected)
        return {
          ok: false,
          status: 503,
          body: { error: { type: 'server_error', code: 'upstream_error', message: 'test stop' } },
          headers: {},
        }
      },
    },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer master', 'user-agent': 'Go-http-client/2.0' },
    apiKeyKind: 'master',
    once() {},
    off() {},
  }

  try {
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    assert.equal(response.status, 503)
    assert.ok(prepared?.body)
    // The rendered custom prompt plus billing survives without a second
    // official-system rebuild inserting an extra identity block.
    assert.equal(prepared.body.system.length, 2)
    assert.ok(prepared.body.system.some((block) => String(block.text || '').includes('CUSTOM_PERSONA UTC')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('logs the session id actually sent upstream, not the caller one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-outbound-session-'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {} }))
  const vm = { id: 'vm-01', claude: { mode: 'oauth' } }
  const selected = {
    vmId: vm.id,
    accountId: 'account-1',
    vm,
    exec: { vmId: vm.id, vm, homeDir: path.join(root, 'home'), oauth: { account_uuid: 'account-1' } },
  }
  let prepared = null
  let logged = null
  const response = { ...fakeResponse(), on: (event, fn) => event === 'finish' && (response.finish = fn) }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { user_id: JSON.stringify({ device_id: 'caller-dev', session_id: 'caller-sess' }) },
    }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: 'outbound-session-test', mode: 'normal' }),
      finish: (_ctx, extra) => {
        logged = extra
      },
    },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: {}, failover: {} },
    failoverRunner: {
      async run(opts) {
        prepared = await opts.applyAttempt(opts.canonicalBody, selected)
        return { ok: false, status: 503, body: { error: { type: 'server_error', code: 'x', message: 'stop' } } }
      },
    },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer master', 'user-agent': 'claude-cli/2.1.241 (external, cli)' },
    apiKeyKind: 'master',
    once() {},
    off() {},
  }
  try {
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    response.finish?.()
    const sent = sessionIdFromOutboundBody(prepared.body) || prepared.meta.sessionId
    assert.ok(sent)
    assert.equal(logged.session_id, 'caller-sess')
    assert.equal(logged.outbound_session_id, sent)
    assert.notEqual(logged.outbound_session_id, 'caller-sess')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

for (const previousVm of [null, 'vm-01']) {
  test(`queued OAuth turns reuse the outbound session ${previousVm ? 'after a VM move' : 'on first bind'}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-queued-session-'))
    const routingFile = path.join(root, 'routing.json')
    fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {} }))
    const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
    const key = sticky.canonicalSessionKey('queued-caller')
    if (previousVm) {
      sticky.bind(key, { accountId: 'account-1', vmId: previousVm, sessionId: 'previous-outbound' })
    }
    const vm = { id: 'vm-02', claude: { mode: 'oauth' } }
    const selected = {
      ok: true,
      vmId: vm.id,
      accountId: 'account-1',
      vm,
      exec: { vmId: vm.id, vm, homeDir: path.join(root, 'home'), oauth: { account_uuid: 'account-1' } },
    }
    const runner = new FailoverRunner({
      scheduler: { selectAndReserve: async () => selected, markSuccess() {} },
      stickyRouter: sticky,
    })
    let releaseFirst
    let enteredFirst
    let enteredSecond
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve
    })
    const firstReady = new Promise((resolve) => {
      enteredFirst = resolve
    })
    const secondReady = new Promise((resolve) => {
      enteredSecond = resolve
    })
    t.after(() => {
      releaseFirst()
      sticky.db.close()
      fs.rmSync(root, { recursive: true, force: true })
    })
    const sent = []
    const logged = []
    let runs = 0
    let requests = 0
    const handler = createHandleProtocol({
      json: (res, status, body) => {
        res.status = status
        return body
      },
      writeSSEHeaders() {},
      readBody: async () => ({
        model: 'claude-haiku-4-5',
        stream: false,
        max_tokens: 32,
        messages: [
          { role: 'user', content: 'Continue this diagnostic conversation with the same device and session.' },
        ],
        metadata: { user_id: JSON.stringify({ device_id: 'queued-device', session_id: 'queued-caller' }) },
      }),
      requireAuth: () => true,
      cfg: {
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
        paths: { data: path.join(root, 'data'), project: root },
      },
      requestLog: {
        start: () => ({ request_id: `queued-${++requests}`, mode: 'normal', t0: Date.now() }),
        finish: (_ctx, extra) => logged.push(extra.outbound_session_id),
      },
      stickyRouter: sticky,
      accountQuota: {},
      apiKeyStore: {},
      apiScheduler: {},
      apiEndpointStore: {},
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      routingConfigPath: routingFile,
      routingConfig: { compatibility: {}, failover: {} },
      groupsRepo: { rateMultiplier: () => 1 },
      failoverRunner: {
        async run(opts) {
          const index = ++runs
          if (index === 2) enteredSecond()
          return runner.run({
            ...opts,
            applyAttempt: async (body, candidate, extra) => {
              if (index === 1) {
                enteredFirst()
                await firstGate
              }
              return opts.applyAttempt(body, candidate, { ...extra, attemptStartedAt: index * 1000 })
            },
            callAttempt: async ({ body }) => {
              sent.push(sessionIdFromOutboundBody(body))
              return {
                ok: true,
                status: 200,
                terminalState: 'verified',
                body: {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'text', text: 'continued' }],
                  stop_reason: 'end_turn',
                },
              }
            },
          })
        },
      },
    })
    async function invoke() {
      const res = {
        ...fakeResponse(),
        on: (event, fn) => {
          if (event === 'finish') res.finish = fn
        },
      }
      const req = {
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: 'Bearer master', 'user-agent': 'claude-cli/2.1.293 (external, cli)' },
        apiKeyKind: 'master',
        once() {},
        off() {},
      }
      await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
      res.finish?.()
      assert.equal(res.status, 200)
    }
    const first = invoke()
    await firstReady
    const second = invoke()
    await secondReady
    releaseFirst()
    await Promise.all([first, second])
    await invoke()
    assert.notEqual(sent[0], 'queued-caller')
    assert.notEqual(sent[0], 'previous-outbound')
    assert.deepEqual(sent, [sent[0], sent[0], sent[0]])
    assert.deepEqual(logged, [sent[0], sent[0], sent[0]])
    assert.equal(sticky.resolve(key).sessionId, sent[0])
    assert.equal(sticky.resolve(key).vmId, vm.id)
  })
}

async function runManagedKeyHop(root, result) {
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {} }))
  const vm = { id: 'vm-01', claude: { mode: 'oauth' } }
  const selected = {
    vmId: vm.id,
    accountId: 'account-1',
    vm,
    exec: { vmId: vm.id, vm, homeDir: path.join(root, 'home'), oauth: { account_uuid: 'account-1' } },
  }
  const charges = []
  const logged = []
  const response = { ...fakeResponse(), on: (event, fn) => event === 'finish' && (response.finish = fn) }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'key-billing', mode: 'normal' }), finish: (_c, row) => logged.push(row) },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: {
      acquire: () => ({ ok: true }),
      release() {},
      recordUsage: (key, usage, opts) => charges.push({ key, usage, opts }),
    },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: {}, failover: {} },
    failoverRunner: {
      async run(opts) {
        await opts.applyAttempt(opts.canonicalBody, selected)
        return result
      },
    },
    groupsRepo: { rateMultiplier: () => 2 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-x', 'user-agent': 'claude-cli/2.1.241 (external, cli)' },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key-1', group_id: 1 },
    once() {},
    off() {},
  }
  await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
  response.finish?.()
  return { charges, logged }
}

test('a managed key is charged exactly once for a hop billed inline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-key-inline-'))
  try {
    const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 }
    const { charges, logged } = await runManagedKeyHop(root, {
      ok: false,
      status: 503,
      accountId: 'account-1',
      usage,
      body: { error: { type: 'server_error', code: 'x', message: 'stop' } },
    })
    assert.equal(charges.length, 1)
    assert.equal(charges[0].opts.rateMultiplier, 2)
    assert.equal(charges[0].opts.officialCost, logged[0].total_cost)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('native mixed TTL usage is billed from upstream buckets rather than the panel default', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-key-mixed-cache-'))
  try {
    const usage = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 400,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 },
    }
    const { charges, logged } = await runManagedKeyHop(root, {
      ok: false,
      status: 503,
      accountId: 'account-1',
      usage,
      body: { error: { type: 'server_error', code: 'x', message: 'stop' } },
    })
    assert.deepEqual(logged[0].usage.cache_creation, usage.cache_creation)
    assert.deepEqual(charges[0].usage.cache_creation, usage.cache_creation)
    // Haiku 4.5 writes: 100 × $1.25/M + 300 × $2/M, not 400 × $2/M.
    assert.ok(Math.abs(logged[0].cache_creation_cost - 0.000725) < 1e-12)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('OpenAI chat carrying claude-opus-4-8 uses the Claude pool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-opus-platform-'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'zero' } }))
  let poolCalls = 0
  let requestedModel = null
  const response = fakeResponse()
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({
      model: 'claude-opus-4-8',
      stream: false,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'opus-platform-test' }), finish() {} },
    stickyRouter: { extractPoolKey: () => 'opus-session', collectPoolKeys: () => ['opus-session'] },
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: { persona_preset: 'zero' }, failover: {} },
    failoverRunner: {
      async run(opts) {
        poolCalls += 1
        requestedModel = opts.model
        return {
          ok: false,
          status: 503,
          body: { error: { type: 'server_error', code: 'pool_probe', message: 'Claude pool selected' } },
          headers: {},
        }
      },
    },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer master', 'user-agent': 'OpenAI/Node' },
    apiKeyKind: 'master',
    once() {},
    off() {},
  }

  try {
    await handler.handleProtocol(req, response, 'openai.chat', '/v1/chat/completions')
    assert.equal(poolCalls, 1)
    assert.equal(requestedModel, 'claude-opus-4-8')
    assert.equal(response.status, 503)
    assert.equal(response.body.error.message, 'Claude pool selected')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function companionHaikuBody(sessionId, deviceId = 'device-probe') {
  return {
    model: 'claude-haiku-4-5',
    stream: false,
    max_tokens: 64,
    tools: [],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.280.e2f; cch=test' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Compress into one routing hint of at most 12 words: WHEN to use; WHEN NOT' }],
      },
    ],
    metadata: { user_id: JSON.stringify({ device_id: deviceId, session_id: sessionId }) },
  }
}

function protocolHarness({ body, stickyRouter, failoverRunner, apiKeyRecord = null, headers = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-protocol-seat-'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'zero' } }))
  const response = fakeResponse()
  const stats = { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 }
  const apiKeyCalls = { acquire: 0, release: 0 }
  const authCalls = { count: 0 }
  const handler = createHandleProtocol({
    json: (_res, status, payload) => {
      response.status = status
      response.body = payload
      return payload
    },
    writeSSEHeaders() {},
    readBody: async () => body,
    requireAuth: () => {
      authCalls.count += 1
      return true
    },
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'seat-probe-test' }), finish() {} },
    stickyRouter,
    accountQuota: {},
    apiKeyStore: {
      acquire: () => {
        apiKeyCalls.acquire += 1
        return { ok: true }
      },
      release: () => {
        apiKeyCalls.release += 1
      },
    },
    apiScheduler: {},
    apiEndpointStore: {},
    stats,
    routingConfigPath: routingFile,
    routingConfig: { compatibility: { persona_preset: 'zero' }, failover: {} },
    failoverRunner,
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer test', 'user-agent': 'Go-http-client/2.0', ...headers },
    apiKeyKind: apiKeyRecord ? 'managed' : 'master',
    apiKeyRecord,
    once() {},
    off() {},
  }
  return { root, handler, req, response, stats, apiKeyCalls, authCalls }
}

test('companion Haiku probe clears session sticky and skips session seat', async () => {
  let runOpts = null
  const stickyCalls = { extract: 0, collect: 0, device: 0 }
  const stickyRouter = {
    extractPoolKey: () => {
      stickyCalls.extract += 1
      return 'session-key'
    },
    collectPoolKeys: () => {
      stickyCalls.collect += 1
      return ['session-key']
    },
    canonicalDeviceKey: (deviceId) => {
      stickyCalls.device += 1
      return `dev2:${deviceId}`
    },
  }
  const harness = protocolHarness({
    body: companionHaikuBody('probe-session', 'probe-device'),
    stickyRouter,
    apiKeyRecord: { id: 'managed-key-1', group_id: 1 },
    failoverRunner: {
      async run(opts) {
        runOpts = opts
        return {
          ok: false,
          status: 503,
          body: { error: { type: 'server_error', code: 'probe_stop', message: 'stop' } },
          headers: {},
        }
      },
    },
  })
  try {
    await harness.handler.handleProtocol(harness.req, harness.response, 'anthropic.messages', '/v1/messages')
    assert.equal(harness.authCalls.count, 1)
    assert.equal(harness.apiKeyCalls.acquire, 1)
    assert.equal(harness.apiKeyCalls.release, 1)
    assert.equal(stickyCalls.extract, 1)
    assert.equal(stickyCalls.collect, 1)
    assert.equal(stickyCalls.device, 1)
    assert.equal(runOpts.stickyKey, null)
    assert.deepEqual(runOpts.stickyKeys, [])
    assert.equal(runOpts.skipSessionSeat, true)
    assert.equal(runOpts.stickyDeviceId, 'probe-device')
    assert.equal(runOpts.deviceKey, 'dev2:probe-device')
    assert.equal(harness.response.status, 503)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('ordinary Haiku with tools keeps session sticky and session seat', async () => {
  let runOpts = null
  const body = {
    ...companionHaikuBody('normal-session', 'normal-device'),
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],
  }
  const harness = protocolHarness({
    body,
    stickyRouter: {
      extractPoolKey: () => 'normal-sticky',
      collectPoolKeys: () => ['normal-sticky'],
      canonicalDeviceKey: (deviceId) => `dev2:${deviceId}`,
    },
    failoverRunner: {
      async run(opts) {
        runOpts = opts
        return {
          ok: false,
          status: 503,
          body: { error: { type: 'server_error', code: 'normal_stop', message: 'stop' } },
          headers: {},
        }
      },
    },
  })
  try {
    await harness.handler.handleProtocol(harness.req, harness.response, 'anthropic.messages', '/v1/messages')
    assert.equal(runOpts.stickyKey, 'normal-sticky')
    assert.deepEqual(runOpts.stickyKeys, ['normal-sticky'])
    assert.equal(runOpts.skipSessionSeat, false)
    assert.equal(runOpts.deviceKey, 'dev2:normal-device')
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

async function captureRunOpts({ body, stickyRouter, apiKeyRecord, headers }) {
  let runOpts = null
  const harness = protocolHarness({
    body,
    stickyRouter,
    apiKeyRecord,
    headers,
    failoverRunner: {
      async run(opts) {
        runOpts = opts
        return {
          ok: false,
          status: 503,
          body: { error: { type: 'server_error', code: 'identity_stop', message: 'stop' } },
          headers: {},
        }
      },
    },
  })
  try {
    await harness.handler.handleProtocol(harness.req, harness.response, 'anthropic.messages', '/v1/messages')
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
  return runOpts
}

function sessionBody(userId, extra = {}) {
  return {
    model: 'claude-sonnet-4-5',
    stream: false,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
    metadata: { user_id: typeof userId === 'string' ? userId : JSON.stringify(userId) },
    ...extra,
  }
}

function realStickyRouter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-identity-sticky-'))
  return { dir, router: new StickyRouter({ dataDir: dir, config: { sticky: { enabled: true, ttl_seconds: 600 } } }) }
}

test('inbound session and device keys match across API keys at the protocol entry', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const body = sessionBody({ device_id: 'dev-cross', account_uuid: 'acct-a', session_id: 'sess-cross' })
    const a = await captureRunOpts({ body, stickyRouter: router, apiKeyRecord: { id: 'key-a', group_id: 1 } })
    const b = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-cross', account_uuid: 'acct-b', session_id: 'sess-cross' }),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-b', group_id: 1 },
    })
    assert.equal(a.stickyKey, 'sess:sess-cross')
    assert.equal(b.stickyKey, a.stickyKey)
    assert.deepEqual(b.stickyKeys, [a.stickyKey])
    assert.equal(a.deviceKey, 'dev2:dev-cross')
    assert.equal(b.deviceKey, a.deviceKey)
    for (const opts of [a, b]) {
      for (const key of [opts.stickyKey, ...opts.stickyKeys, opts.deviceKey, opts.familyKey]) {
        assert.doesNotMatch(String(key), /key-a|key-b|^k|:k/)
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the protocol entry seats each client session, even on the same device', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const turn = {
      messages: [{ role: 'user', content: 'please refactor the scheduler module and explain every single change' }],
    }
    const a = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-seat', session_id: 'sess-seat' }, turn),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-a', group_id: 1 },
    })
    const b = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-seat', session_id: 'sess-other' }, turn),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-b', group_id: 1 },
    })
    assert.equal(a.skipSessionSeat, false)
    assert.equal(a.seatKey, 'seat:sess:sess-seat')
    assert.equal(b.seatKey, 'seat:sess:sess-other')
    assert.notEqual(b.seatKey, a.seatKey)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('shared API key keeps different devices apart at the protocol entry', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const apiKeyRecord = { id: 'shared-key', group_id: 1 }
    const a = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-one', session_id: 'sess-one' }),
      stickyRouter: router,
      apiKeyRecord,
    })
    const b = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-two', session_id: 'sess-two' }),
      stickyRouter: router,
      apiKeyRecord,
    })
    assert.notEqual(a.stickyKey, b.stickyKey)
    assert.notEqual(a.deviceKey, b.deviceKey)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('explicit body device_id is the fallback when metadata has no device', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const opts = await captureRunOpts({
      body: sessionBody({ session_id: 'sess-fallback' }, { device_id: 'dev-explicit' }),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-fallback', group_id: 1 },
    })
    assert.equal(opts.stickyKey, 'sess:sess-fallback')
    assert.equal(opts.stickyDeviceId, 'dev-explicit')
    assert.equal(opts.deviceKey, 'dev2:dev-explicit')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy API-key-scoped session row migrates lazily at the protocol entry', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const apiKeyRecord = { id: 'key-old', group_id: 1 }
    const legacyKey = 'p:anthropic:kkey-old:sess-legacy'
    router.bind(legacyKey, { accountId: 'acc-legacy', vmId: 'vm-legacy', sessionId: 'out-legacy', slotIndex: 1 })
    router.bind('p:anthropic:kkey-old:unrelated', { accountId: 'acc-x', vmId: 'vm-x' })
    const opts = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-legacy', session_id: 'sess-legacy' }),
      stickyRouter: router,
      apiKeyRecord,
    })
    assert.equal(opts.stickyKey, 'sess:sess-legacy')
    assert.deepEqual(opts.stickyKeys, ['sess:sess-legacy', legacyKey])
    const hit = router.resolve('sess:sess-legacy')
    assert.equal(hit.vmId, 'vm-legacy')
    assert.equal(hit.accountId, 'acc-legacy')
    assert.equal(router.resolve('dev2:dev-legacy').vmId, 'vm-legacy')
    assert.equal(router.resolve(legacyKey).vmId, 'vm-legacy')
    assert.equal(router.resolve('p:anthropic:kkey-old:unrelated').vmId, 'vm-x')

    // A different API key now reaches the same session binding.
    const other = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-legacy', session_id: 'sess-legacy' }),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-new', group_id: 1 },
    })
    assert.equal(other.stickyKey, 'sess:sess-legacy')
    assert.deepEqual(other.stickyKeys, ['sess:sess-legacy'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('parent and child family key is shared across API keys and inherits a live legacy family', async () => {
  const { dir, router } = realStickyRouter()
  try {
    router.bind('p:anthropic:kkey-p:family:parent-sess', { accountId: 'acc-fam', vmId: 'vm-fam' })
    const parent = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-fam', session_id: 'parent-sess' }),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-p', group_id: 1 },
    })
    const child = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-fam', session_id: 'child-sess', parent_session_id: 'parent-sess' }),
      stickyRouter: router,
      apiKeyRecord: { id: 'key-c', group_id: 1 },
    })
    assert.equal(parent.familyKey, 'family2:parent-sess')
    assert.equal(child.familyKey, parent.familyKey)
    assert.equal(parent.familyVmId, 'vm-fam')
    assert.equal(child.familyVmId, 'vm-fam')
    assert.notEqual(child.stickyKey, parent.stickyKey)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Claude Code sub-agent hops run as child sessions of the main session', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const apiKeyRecord = { id: 'key-cc', group_id: 1 }
    const body = sessionBody({ device_id: 'dev-cc', session_id: 'main-sess' })
    const main = await captureRunOpts({ body, stickyRouter: router, apiKeyRecord })
    router.bind(main.stickyKey, { accountId: 'acc-cc', vmId: 'vm-cc', slotIndex: 0 })
    router.bind(main.familyKey, { accountId: 'acc-cc', vmId: 'vm-cc' })
    const agentHop = (agentId, parentAgentId) =>
      captureRunOpts({
        body,
        stickyRouter: router,
        apiKeyRecord,
        headers: {
          'x-claude-code-session-id': 'main-sess',
          'x-claude-code-agent-id': agentId,
          ...(parentAgentId ? { 'x-claude-code-parent-agent-id': parentAgentId } : {}),
        },
      })
    const a = await agentHop('agent-a')
    const aAgain = await agentHop('agent-a')
    const b = await agentHop('agent-b')
    const nested = await agentHop('agent-c', 'agent-a')

    assert.equal(main.stickyKey, 'sess:main-sess')
    // A one-shot short turn ('hello') holds no seat even with a device id.
    assert.equal(main.skipSessionSeat, true)
    assert.equal(main.seatKey, null)
    // Each agent queues on its own session, never behind the main one.
    const keys = [main.stickyKey, a.stickyKey, b.stickyKey, nested.stickyKey]
    assert.equal(new Set(keys).size, keys.length)
    assert.equal(aAgain.stickyKey, a.stickyKey)
    assert.deepEqual(a.stickyKeys, [a.stickyKey])
    for (const child of [a, b, nested]) {
      assert.match(child.stickyKey, /^sess:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.equal(child.familyKey, 'family2:main-sess')
      assert.equal(child.familyVmId, 'vm-cc')
      assert.equal(child.deviceKey, main.deviceKey)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('request without trusted session id keeps the legacy scoped sticky key', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const body = {
      model: 'claude-sonnet-4-5',
      stream: false,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'no identity here' }],
    }
    const opts = await captureRunOpts({ body, stickyRouter: router, apiKeyRecord: { id: 'key-anon', group_id: 1 } })
    assert.match(String(opts.stickyKey), /^p:anthropic:kkey-anon:ch:/)
    assert.equal(opts.deviceKey, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('one-shot test call skips the session seat but keeps its sticky key', async () => {
  const { dir, router } = realStickyRouter()
  try {
    const probe = await captureRunOpts({
      body: sessionBody({ device_id: 'dev-probe', session_id: 'sess-probe' }, { max_tokens: 1024 }),
      stickyRouter: router,
    })
    assert.equal(probe.skipSessionSeat, true)
    assert.equal(probe.stickyKey, 'sess:sess-probe')
    const turn = await captureRunOpts({
      body: sessionBody(
        { device_id: 'dev-probe', session_id: 'sess-probe' },
        {
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'go on' },
          ],
        },
      ),
      stickyRouter: router,
    })
    assert.equal(turn.skipSessionSeat, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Responses API backend keeps parallel done-only tools in one stream state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-tools-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const items = [0, 1].map((index) => ({
    type: 'function_call',
    id: `fc_${index}`,
    call_id: `call_${index}`,
    name: 'edit',
    arguments: JSON.stringify({ path: `${index}.txt` }),
  }))
  const events = [
    ...items.map((item, index) => ({
      type: 'response.output_item.added',
      output_index: index,
      item: { ...item, arguments: '' },
    })),
    ...items.map((item, index) => ({
      type: 'response.function_call_arguments.done',
      output_index: index,
      item_id: item.id,
      arguments: item.arguments,
    })),
    { type: 'response.completed', response: { output: items } },
  ]
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  let wire = ''
  const res = {
    headersSent: false,
    write: (chunk) => {
      wire += chunk
    },
  }
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res,
      protocol: 'openai.chat',
      clientStream: true,
      deliveryMode: 'verified',
      convertedBody: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'edit' }] },
      inbound: {},
      converters: {
        writeSSEHeaders: () => {
          res.headersSent = true
        },
      },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'openai', protocol: 'openai', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'gpt-5.4',
        }),
      },
    })
    assert.equal(result.ok, true)
    const chunks = wire
      .split('\n\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)))
    const calls = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls || [])
    for (let index = 0; index < items.length; index++) {
      const tool = calls.filter((call) => call.index === index)
      assert.equal(tool.find((call) => call.id)?.id, items[index].call_id)
      assert.deepEqual(JSON.parse(tool.map((call) => call.function?.arguments || '').join('')), {
        path: `${index}.txt`,
      })
    }
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
    assert.equal(wire.split('data: [DONE]').length - 1, 1)
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('API Anthropic non-stream rejects message_start without message_stop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-incomplete-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(messageStart())
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res: { headersSent: false, write: () => {} },
      protocol: 'anthropic.messages',
      clientStream: false,
      deliveryMode: 'verified',
      convertedBody: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      inbound: {},
      converters: { createClaudeMessageAssembler, applyClaudeSSELineToMessage },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'claude', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'claude-haiku-4-5',
        }),
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.terminalState, 'incomplete')
    assert.equal(result.sawMessageStop, false)
    assert.equal(result.body?.type, 'message')
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('API Anthropic non-stream rejects stop_reason and text without message_stop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-delta-no-stop-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        {
          type: 'message_start',
          message: { type: 'message', role: 'assistant', content: [], model: 'claude-haiku-4-5' },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ]
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res: { headersSent: false, write: () => {} },
      protocol: 'anthropic.messages',
      clientStream: false,
      deliveryMode: 'verified',
      convertedBody: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      inbound: {},
      converters: { createClaudeMessageAssembler, applyClaudeSSELineToMessage },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'claude', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'claude-haiku-4-5',
        }),
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.terminalState, 'incomplete')
    assert.equal(result.sawMessageStop, false)
    assert.equal(result.body?.content?.[0]?.text, 'hello')
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('API Anthropic non-stream accepts message_stop as terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-complete-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(completeAnthropicSse())
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res: { headersSent: false, write: () => {} },
      protocol: 'anthropic.messages',
      clientStream: false,
      deliveryMode: 'verified',
      convertedBody: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      inbound: {},
      converters: { createClaudeMessageAssembler, applyClaudeSSELineToMessage },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'claude', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'claude-haiku-4-5',
        }),
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.terminalState, 'verified')
    assert.equal(result.sawMessageStop, true)
    assert.equal(result.body?.type, 'message')
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('API backend non-stream maps incomplete assistant hops to incomplete_response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-incomplete-http-'))
  const routingFile = path.join(root, 'routing.json')
  const socketPath = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'zero' } }))
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(messageStart())
    })
  })
  await new Promise((resolve) => kernel.listen(socketPath, resolve))
  const response = fakeResponse()
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({
      model: 'claude-haiku-4-5',
      stream: false,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root },
    },
    requestLog: { start: () => ({ request_id: 'api-incomplete-test' }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: {
      pick: () => ({
        ok: true,
        endpoint: { id: 'ep-test', kind: 'claude', protocol: 'anthropic', base_url: 'https://upstream.invalid' },
        upstream_model: 'claude-haiku-4-5',
        key: { id: 'key-test', api_key: 'secret' },
      }),
    },
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: { persona_preset: 'zero' }, failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-api', 'user-agent': 'test-client' },
    apiKeyKind: 'managed',
    apiKeyRecord: { category: 'api' },
    once() {},
    off() {},
  }
  try {
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    assert.equal(response.status, 502)
    assert.equal(response.body.error.code, 'incomplete_response')
  } finally {
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Responses API backend returns 502 for conflicting tool arguments when the client is not streaming', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-tools-ns-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const events = [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_0', call_id: 'call_0', name: 'edit', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_0', delta: '{"path":"a' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_0', arguments: '{"path":"b.txt"}' },
    { type: 'response.completed', response: { output: [] } },
  ]
  const kernel = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res: { headersSent: false, write: () => {} },
      protocol: 'anthropic.messages',
      clientStream: false,
      deliveryMode: 'verified',
      convertedBody: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'edit' }] },
      inbound: {},
      converters: { writeSSEHeaders: () => {} },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'openai', protocol: 'openai', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'gpt-5.4',
        }),
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 502)
    assert.equal(result.body.error.code, 'tool_arguments_mismatch')
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
test('OpenAI Responses lifecycle metadata does not commit downstream output', () => {
  for (const type of [
    'response.created',
    'response.queued',
    'response.in_progress',
    'response.metadata',
    'keepalive',
  ]) {
    assert.equal(isOpenAIResponsesCommitEvent({ type }), false, type)
  }
  assert.equal(isOpenAIResponsesCommitEvent({ type: 'error', error: { code: 'server_is_overloaded' } }), false)
  assert.equal(isOpenAIResponsesCommitEvent({ type: 'response.failed' }), false)
  assert.equal(
    isOpenAIResponsesCommitEvent({ type: 'response.output_item.added', item: { type: 'reasoning', summary: [] } }),
    false,
  )
  assert.equal(isOpenAIResponsesCommitEvent({ type: 'response.output_text.delta', delta: 'hello' }), true)
})

async function runOpenAIResponsesFixture(events) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-metadata-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const kernel = http.createServer((req, response) => {
    req.resume()
    req.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  let wire = ''
  const res = {
    headersSent: false,
    write(chunk) {
      wire += chunk
    },
  }
  try {
    const result = await runApiInference({
      cfg: { paths: { data: root } },
      res,
      protocol: 'openai.responses',
      clientStream: true,
      deliveryMode: 'verified',
      convertedBody: { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hello' }] },
      inbound: {},
      converters: {
        writeSSEHeaders: () => {
          res.headersSent = true
        },
      },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'openai', protocol: 'openai', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'gpt-5.4',
        }),
      },
    })
    return { result, wire, headersSent: res.headersSent }
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

unixTest('API OpenAI metadata followed by overload remains uncommitted for failover', async () => {
  const run = await runOpenAIResponsesFixture([
    { type: 'response.created', response: { id: 'resp_meta' } },
    { type: 'response.queued', response: { id: 'resp_meta' } },
    { type: 'response.metadata', response: { id: 'resp_meta' } },
    { type: 'error', error: { type: 'server_error', code: 'server_is_overloaded', status: 503, message: 'busy' } },
    {
      type: 'response.failed',
      response: { error: { type: 'server_error', code: 'server_is_overloaded', status: 503, message: 'busy' } },
    },
  ])
  assert.equal(run.result.ok, false)
  assert.equal(run.result.status, 503)
  assert.equal(run.result.committed, false)
  assert.equal(run.headersSent, false)
  assert.equal(run.wire, '')
})

unixTest('API OpenAI flushes buffered metadata with the first real output', async () => {
  const run = await runOpenAIResponsesFixture([
    { type: 'response.created', response: { id: 'resp_ok' } },
    { type: 'response.queued', response: { id: 'resp_ok' } },
    { type: 'response.output_text.delta', delta: 'hello' },
    { type: 'response.completed', response: { id: 'resp_ok', output: [] } },
  ])
  assert.equal(run.result.ok, true)
  assert.equal(run.result.committed, true)
  assert.equal(run.result.terminalState, 'verified')
  assert.match(run.wire, /response\.created/)
  assert.match(run.wire, /response\.queued/)
  assert.match(run.wire, /response\.output_text\.delta/)
  assert.match(run.wire, /response\.completed/)
})

async function runAccountApiProtocol(inbound, protocol, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-account-api-protocol-'))
  const socket =
    process.platform === 'win32' ? '\\\\.\\pipe\\' + path.basename(root) : path.join(root, 'api-kernel.sock')
  const previousSocket = process.env.KIN_API_KERNEL_SOCK
  process.env.KIN_API_KERNEL_SOCK = socket
  const routingFile = path.join(root, 'routing.json')
  const routing = {
    compatibility: {
      persona_preset: 'custom',
      persona_inject: 'rewrite',
      min_max_tokens: 4096,
      persona_templates: { custom: [{ id: 'custom', type: 'text', text: 'MUST_NOT_BE_IN_ACCOUNT_API' }] },
    },
    codex: { model_mappings: { o3: 'gpt-5.4', 'gpt-4.1-nano': 'gpt-5.4' } },
    failover: {},
  }
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const sent = [],
    billed = [],
    logs = []
  let acquired = 0
  const kernel = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      const envelope = JSON.parse(raw)
      const body = JSON.parse(envelope.body)
      sent.push({ ...envelope, body })
      const message = {
        type: 'message',
        id: 'msg_offline',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'OK' }],
      }
      const events = options.events
        ? options.events(body)
        : [
            {
              type: 'response.created',
              response: { id: 'resp_offline', model: body.model, status: 'in_progress', output: [] },
            },
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...message, status: 'in_progress', content: [] },
            },
            { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'OK' },
            {
              type: 'response.completed',
              response: {
                id: 'resp_offline',
                model: body.model,
                status: 'completed',
                output: [message],
                usage: { input_tokens: 7, output_tokens: 1, total_tokens: 8 },
              },
            },
          ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n')
    })
  })
  await new Promise((resolve, reject) => {
    kernel.once('error', reject)
    kernel.listen(socket, resolve)
  })
  const response = Object.assign(new EventEmitter(), {
    headersSent: false,
    wire: '',
    statusCode: 200,
    write(chunk) {
      this.wire += chunk
    },
    end() {
      this.emit('finish')
    },
    setHeader() {},
  })
  const scheduler = new ApiScheduler({
    getAccountModels: () => ['o3', 'gpt-4.1-nano'].map((id) => ({ name: id, alias: id })),
    resolveAccountKey: (key) => ({
      accountId: key.source_account_id,
      enabled: true,
      proxyUrl: 'socks5h://bound-current:1080',
    }),
  })
  scheduler.reload([
    {
      id: 'ep-b',
      kind: 'openai',
      protocol: 'openai',
      models: [{ name: 'o3', alias: 'o3' }],
      api_key_entries: [
        { id: 'api-key-b', api_key: 'fixture-b', source_vm_id: 'vm-b', source_account_id: 'account-b' },
      ],
    },
    {
      id: 'ep-global',
      kind: 'openai',
      protocol: 'openai',
      models: [{ name: 'o3', alias: 'o3' }],
      api_key_entries: [{ id: 'api-key-global', api_key: 'fixture-global' }],
    },
    {
      id: 'ep-a',
      kind: 'openai',
      protocol: 'openai',
      models: [
        { name: 'o3', alias: 'o3' },
        { name: 'gpt-4.1-nano', alias: 'gpt-4.1-nano' },
      ],
      api_key_entries: [
        { id: 'api-key-a', api_key: 'fixture-a', source_vm_id: 'vm-a', source_account_id: 'account-a' },
      ],
    },
  ])
  const handler = createHandleProtocol({
    json: (_response, status, body) => {
      response.statusCode = status
      response.body = body
      response.emit('finish')
      return body
    },
    writeSSEHeaders: () => {
      response.headersSent = true
    },
    readBody: async () => inbound,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: options.intercept || [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { project: root, data: root },
    },
    requestLog: {
      start: () => ({ request_id: 'account-api-fixture', t0: Date.now() }),
      finish: (_context, row) => logs.push(row),
    },
    stickyRouter: new Proxy(
      {},
      {
        get() {
          throw new Error('account API must not touch OAuth sticky state')
        },
      },
    ),
    accountQuota: new Proxy(
      {},
      {
        get() {
          throw new Error('account API must not touch OAuth quota state')
        },
      },
    ),
    apiKeyStore: {
      acquire: () => {
        acquired++
        return options.keyGate || { ok: true }
      },
      release() {},
      recordUsage: (...args) => billed.push(args),
      users: { getById: () => ({ role: options.ownerRole || 'admin' }) },
    },
    apiScheduler: scheduler,
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfig: routing,
    routingConfigPath: routingFile,
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const request = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: options.path || '/v1/messages',
    headers: options.headers || { 'user-agent': 'offline-api-fixture' },
    apiKeyKind: 'managed',
    apiKeyRecord: {
      id: 'managed-a',
      category: options.category || 'api',
      group_type: options.groupType || 'openai_apikey',
      allowed_vms: ['vm-a'],
      ...(options.ownerRole ? { user_id: 'owner' } : {}),
    },
  })
  try {
    await handler.handleProtocol(request, response, protocol, request.url)
    return { response, sent, billed, logs, acquired }
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    if (previousSocket === undefined) delete process.env.KIN_API_KERNEL_SOCK
    else process.env.KIN_API_KERNEL_SOCK = previousSocket
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

for (const [protocol, route, inbound, answer] of [
  [
    'openai.chat',
    '/v1/chat/completions',
    { model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'hello' }], max_completion_tokens: 16 },
    (body) => body.choices?.[0]?.message?.content,
  ],
  [
    'openai.completions',
    '/v1/completions',
    { model: 'o3', prompt: 'hello', max_tokens: 16 },
    (body) => body.choices?.[0]?.text,
  ],
  [
    'openai.responses',
    '/v1/responses',
    { model: 'o3', input: 'hello', max_output_tokens: 16 },
    (body) =>
      body.output?.find((item) => item.type === 'message')?.content?.find((block) => block.type === 'output_text')
        ?.text,
  ],
  [
    'anthropic.messages',
    '/v1/messages',
    { model: 'o3', messages: [{ role: 'user', content: 'hello' }], max_tokens: 16 },
    (body) => body.content?.find((block) => block.type === 'text')?.text,
  ],
]) {
  test(`account API ${protocol} reaches only the selected API key, retains model/budget, and returns text`, async () => {
    const run = await runAccountApiProtocol({ ...inbound, stream: false }, protocol, { path: route })
    assert.equal(run.response.statusCode, 200, JSON.stringify(run.response.body))
    assert.equal(answer(run.response.body), 'OK')
    assert.equal(run.sent.length, 1)
    assert.equal(run.sent[0].url, 'https://api.openai.com/v1/responses')
    assert.equal(run.sent[0].headers.authorization, 'Bearer fixture-a')
    assert.equal(run.sent[0].proxy_url, 'socks5h://bound-current:1080')
    assert.equal(run.sent[0].body.model, inbound.model, 'OAuth model mappings must not rewrite account API models')
    assert.equal(
      run.sent[0].body.max_output_tokens,
      16,
      'OAuth/Claude minimum budgets must not inflate the API request',
    )
    assert.equal(JSON.stringify(run.sent[0].body).includes('MUST_NOT_BE_IN_ACCOUNT_API'), false)
    assert.equal(run.sent[0].body.store, false)
    assert.equal(run.billed.length, 1)
    assert.equal(run.billed[0][0].id, 'managed-a')
    assert.equal(run.logs[0].via, 'api-kernel')
    assert.equal(run.logs[0].account_id, 'api-key-a')
    assert.equal(run.logs[0].final_account_id, 'api-key-a')
    assert.equal(run.logs[0].vm_id, null)
  })
}

test('account API does not turn a caller classifier contract into the Claude classifier workflow', async () => {
  const inbound = { ...classifierFixture({ model: 'o3' }), max_tokens: 16, stream: false }
  inbound.metadata = { user_id: { device_id: 'fixture-device', session_id: 'fixture-session' } }
  inbound.system.push({ type: 'text', text: '## Session Context\nCWD: /work' })
  const headers = { 'user-agent': 'claude-cli/2.1.303 (external, cli)', 'x-app': 'cli' }
  assert.equal(isOfficialClaudeCodeTraffic(headers, inbound), true)
  assert.ok(classifyClaudeRequestPurpose(inbound, { officialTraffic: true }))
  const run = await runAccountApiProtocol(inbound, 'anthropic.messages', { headers })
  assert.equal(run.response.statusCode, 200, JSON.stringify(run.response.body))
  assert.equal(run.sent.length, 1)
  assert.equal(run.sent[0].body.model, 'o3')
  assert.equal(run.sent[0].body.max_output_tokens, 16)
  assert.equal(run.logs[0].classifier, undefined)
})

test('account API forced tools with reasoning bypass Claude-only tool-choice restrictions', async () => {
  const run = await runAccountApiProtocol(
    {
      model: 'o3',
      messages: [{ role: 'user', content: 'Use the tool.' }],
      tools: [{ type: 'function', function: { name: 'chosen', parameters: { type: 'object', properties: {} } } }],
      tool_choice: { type: 'function', function: { name: 'chosen' } },
      reasoning_effort: 'high',
      stream: false,
    },
    'openai.chat',
  )
  assert.equal(run.response.statusCode, 200, JSON.stringify(run.response.body))
  assert.equal(run.sent.length, 1)
  assert.deepEqual(run.sent[0].body.tool_choice, { type: 'function', name: 'chosen' })
})

test('an unknown account API model is rejected by its scoped API catalog without an OAuth hop', async () => {
  const run = await runAccountApiProtocol(
    { model: 'not-in-selected-api-catalog', messages: [{ role: 'user', content: 'hello' }] },
    'openai.chat',
  )
  assert.equal(run.response.statusCode, 404)
  assert.equal(run.logs[0].error_code, 'model_not_found')
  assert.equal(run.sent.length, 0)
  assert.equal(run.billed.length, 0)
  assert.equal(run.logs[0].via, 'api-kernel')
})

for (const [protocol, route, content] of [
  ['openai.chat', '/v1/chat/completions', { messages: [{ role: 'user', content: 'Draw a cat.' }] }],
  ['openai.responses', '/v1/responses', { input: 'Draw a cat.' }],
]) {
  test(`account API ${protocol} image model stays in its API catalog without an OAuth Images call`, async () => {
    const run = await runAccountApiProtocol(
      { model: 'gpt-image-2.5-flare', ...content, size: '1024x1024', quality: 'high' },
      protocol,
      { path: route },
    )
    assert.equal(run.response.statusCode, 404)
    assert.equal(run.response.body.error.code, 'model_not_found')
    assert.equal(run.sent.length, 0)
    assert.equal(run.billed.length, 0)
    assert.equal(run.acquired, 0)
    assert.equal(run.logs[0].via, 'api-kernel')
    assert.equal(run.logs[0].protocol, protocol)
    assert.equal(run.logs[0].error_code, 'model_not_found')
  })
}

for (const [name, fields] of [
  ['stored response', { previous_response_id: 'resp_other_key' }],
  ['file reference', { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_other_key' }] }] }],
  ['namespace MCP', { tools: [{ type: 'namespace', name: 'remote', tools: [{ type: 'mcp' }] }] }],
  [
    'Lite MCP',
    {
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [{ type: 'namespace', name: 'remote', tools: [{ type: 'mcp' }] }],
        },
      ],
      client_metadata: { 'x-openai-internal-codex-responses-lite': 'true' },
    },
  ],
]) {
  test(`account API rejects ${name} before key admission or forwarding`, async () => {
    const run = await runAccountApiProtocol({ model: 'o3', input: 'hello', ...fields }, 'openai.responses')
    assert.equal(run.response.statusCode, 400)
    assert.equal(run.response.body.error.code, 'api_shared_resource_forbidden')
    assert.equal(run.acquired, 0)
    assert.equal(run.sent.length, 0)
    assert.equal(run.billed.length, 0)
  })
}

for (const [category, groupType, model] of [
  ['oauth', 'anthropic', 'gpt-4.1-nano'],
  ['oauth', 'openai', 'claude-haiku-4-5'],
  ['oauth', 'openai_apikey', 'gpt-4.1-nano'],
]) {
  test(`the account API exception does not widen ${category}/${groupType} model permissions`, async () => {
    const run = await runAccountApiProtocol({ model, messages: [{ role: 'user', content: 'hello' }] }, 'openai.chat', {
      category,
      groupType,
    })
    assert.equal(run.response.statusCode, 403)
    assert.equal(run.response.body.error.code, 'key_group_mismatch')
    assert.equal(run.sent.length, 0)
    assert.equal(run.billed.length, 0)
  })
}

test('tenant account API keys retain the existing platform API permission gate', async () => {
  const run = await runAccountApiProtocol(
    { model: 'o3', messages: [{ role: 'user', content: 'hello' }] },
    'openai.chat',
    { ownerRole: 'user' },
  )
  assert.equal(run.response.statusCode, 403)
  assert.equal(run.response.body.error.code, 'api_backend_forbidden')
  assert.equal(run.sent.length, 0)
  assert.equal(run.billed.length, 0)
})

test('account API retains the managed-key quota gate before any upstream request', async () => {
  const run = await runAccountApiProtocol(
    { model: 'o3', messages: [{ role: 'user', content: 'hello' }] },
    'openai.chat',
    { keyGate: { ok: false, status: 429, code: 'api_key_quota_exhausted', message: 'quota exhausted' } },
  )
  assert.equal(run.response.statusCode, 429)
  assert.equal(run.response.body.error.code, 'api_key_quota_exhausted')
  assert.equal(run.sent.length, 0)
  assert.equal(run.billed.length, 0)
})

test('account API Completions stream reaches the same key and ends exactly once', async () => {
  const run = await runAccountApiProtocol(
    { model: 'o3', prompt: 'hello', max_tokens: 16, stream: true },
    'openai.completions',
    { path: '/v1/completions' },
  )
  assert.equal(run.response.statusCode, 200)
  assert.equal(run.sent.length, 1)
  const data = run.response.wire
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
  assert.equal(data.filter((value) => value === '[DONE]').length, 1)
  const chunks = data.filter((value) => value !== '[DONE]').map((value) => JSON.parse(value))
  assert.ok(chunks.length)
  assert.ok(chunks.every((chunk) => chunk.object === 'text_completion'))
  assert.equal(
    chunks
      .flatMap((chunk) => chunk.choices || [])
      .map((choice) => choice.text || '')
      .join(''),
    'OK',
  )
  assert.equal(run.logs[0].account_id, 'api-key-a')
  assert.equal(run.logs[0].vm_id, null)
  assert.equal(run.billed.length, 1)
})

function nativeToolsRequest() {
  return {
    model: 'o3',
    stream: false,
    instructions: 'Use the supplied client tools.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Read and patch a.txt.' }] },
      { type: 'reasoning', id: 'rs_previous', summary: [], encrypted_content: 'opaque-reasoning' },
      {
        type: 'function_call',
        id: 'fc_previous',
        call_id: 'call_previous',
        namespace: 'functions',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      },
      { type: 'function_call_output', call_id: 'call_previous', output: 'file contents' },
      {
        type: 'custom_tool_call',
        id: 'ct_previous',
        call_id: 'call_patch_previous',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** End Patch',
      },
      { type: 'custom_tool_call_output', call_id: 'call_patch_previous', output: 'patch applied' },
    ],
    tools: [
      {
        type: 'namespace',
        name: 'functions',
        description: 'Workspace tools',
        tools: [
          {
            type: 'function',
            name: 'read_file',
            description: 'Read a file',
            strict: true,
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
      {
        type: 'custom',
        name: 'apply_patch',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: /[a-z]+/' },
      },
      { type: 'function', name: 'lookup', strict: false, parameters: { type: 'object', properties: {} } },
    ],
    tool_choice: { type: 'function', namespace: 'functions', name: 'read_file' },
    parallel_tool_calls: false,
    reasoning: { effort: 'high', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    text: { verbosity: 'low' },
    max_output_tokens: 17,
    temperature: 0.2,
    top_p: 0.9,
    store: false,
  }
}

function nativeToolResponse() {
  return {
    id: 'resp_native',
    object: 'response',
    model: 'o3',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_native', summary: [], encrypted_content: 'opaque-result' },
      {
        type: 'function_call',
        id: 'fc_native',
        call_id: 'call_native',
        namespace: 'functions',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
        status: 'completed',
      },
      {
        type: 'custom_tool_call',
        id: 'ct_native',
        call_id: 'call_patch',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** End Patch',
        status: 'completed',
      },
    ],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    error: null,
    incomplete_details: null,
  }
}

test('account API native Responses preserves Codex tools, history, parameters, and before-upstream changes', async () => {
  const inbound = nativeToolsRequest()
  inbound.store = true
  const officialResponse = nativeToolResponse()
  const run = await runAccountApiProtocol(inbound, 'openai.responses', {
    path: '/v1/responses',
    events: () => [{ type: 'response.completed', response: officialResponse }],
    intercept: [
      {
        phase: 'before_upstream',
        match: { protocol: 'openai.responses' },
        action: { set_body_field: { instructions: 'Changed by configured intercept', max_output_tokens: 19 } },
      },
    ],
  })
  assert.equal(run.response.statusCode, 200, JSON.stringify(run.response.body))
  assert.deepEqual(run.sent[0].body, {
    ...inbound,
    instructions: 'Changed by configured intercept',
    max_output_tokens: 19,
    stream: true,
    store: false,
  })
  assert.deepEqual(run.response.body, officialResponse)
  assert.equal(run.sent[0].proxy_url, 'socks5h://bound-current:1080')
  assert.equal(run.logs[0].account_id, 'api-key-a')
  assert.equal(run.logs[0].vm_id, null)
  assert.equal(run.billed.length, 1)
})

test('account API native Responses completes a two-round function and custom tool exchange', async () => {
  const firstRequest = nativeToolsRequest()
  const officialResponse = nativeToolResponse()
  const first = await runAccountApiProtocol(firstRequest, 'openai.responses', {
    events: () => [{ type: 'response.completed', response: officialResponse }],
  })
  assert.equal(first.response.statusCode, 200)
  const secondRequest = {
    ...firstRequest,
    tool_choice: 'auto',
    input: [
      ...firstRequest.input,
      ...first.response.body.output,
      { type: 'function_call_output', call_id: 'call_native', output: 'next file contents' },
      { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'updated a.txt' },
    ],
  }
  const second = await runAccountApiProtocol(secondRequest, 'openai.responses')
  assert.equal(second.response.statusCode, 200)
  assert.deepEqual(second.sent[0].body.input, secondRequest.input)
  assert.deepEqual(second.sent[0].body.tools, firstRequest.tools)
  assert.equal(second.sent[0].body.tool_choice, 'auto')
  assert.equal(second.billed.length, 1)
})

for (const stream of [false, true]) {
  test(`account API Responses Lite preserves ordered tool declarations and strips only internal metadata for ${stream ? 'streaming' : 'JSON'} clients`, async () => {
    const standard = nativeToolsRequest()
    const { tools, instructions, ...request } = standard
    const internalMetadata = { content_item_metadata: [{ provenance: { type: 'harness', hook: false } }] }
    const input = [
      { type: 'additional_tools', role: 'developer', id: 'at_functions', tools: [tools[0]] },
      {
        type: 'message',
        role: 'developer',
        id: 'msg_instructions',
        content: [{ type: 'input_text', text: instructions }],
        internal_chat_message_metadata_passthrough: internalMetadata,
      },
      { ...standard.input[0], internal_chat_message_metadata_passthrough: internalMetadata },
      ...standard.input.slice(1, 4),
      { type: 'additional_tools', role: 'developer', id: 'at_patch', tools: [tools[1]] },
      ...standard.input.slice(4),
    ]
    const inbound = {
      ...request,
      stream,
      input,
      tool_choice: 'auto',
      reasoning: { ...standard.reasoning, context: 'all_turns' },
      metadata: { integration: 'codex-lite' },
      client_metadata: { 'x-openai-internal-codex-responses-lite': 'true' },
    }
    const original = structuredClone(inbound)
    const expectedInput = input.map((item) => {
      const { internal_chat_message_metadata_passthrough, ...publicItem } = item
      return publicItem
    })
    const officialResponse = nativeToolResponse()
    const run = await runAccountApiProtocol(inbound, 'openai.responses', {
      events: () => [{ type: 'response.completed', response: officialResponse }],
    })
    assert.equal(run.response.statusCode, 200, JSON.stringify(run.response.body))
    const { client_metadata, ...publicRequest } = inbound
    assert.deepEqual(run.sent[0].body, { ...publicRequest, input: expectedInput, stream: true })
    assert.equal(run.sent[0].body.tools, undefined)
    assert.deepEqual(
      run.sent[0].body.input.filter((item) => item.type === 'additional_tools'),
      [input[0], input[6]],
    )
    assert.deepEqual(inbound, original)
    assert.equal(run.logs[0].has_tools, true)
    assert.equal(run.logs[0].account_id, 'api-key-a')
    assert.equal(run.logs[0].vm_id, null)
    assert.equal(run.sent[0].proxy_url, 'socks5h://bound-current:1080')
    assert.equal(run.billed.length, 1)
  })
}

test('account API native Responses streams original tool events and emits DONE once', async () => {
  const officialResponse = nativeToolResponse()
  const events = [
    { type: 'response.created', response: { id: officialResponse.id, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: officialResponse.output[1] },
    {
      type: 'response.custom_tool_call_input.delta',
      item_id: 'ct_native',
      output_index: 1,
      delta: '*** Begin Patch\n*** End Patch',
    },
    { type: 'response.output_item.done', output_index: 1, item: officialResponse.output[2] },
    { type: 'response.completed', response: officialResponse },
  ]
  const run = await runAccountApiProtocol({ ...nativeToolsRequest(), stream: true }, 'openai.responses', {
    events: () => events,
  })
  assert.equal(run.response.statusCode, 200)
  assert.equal(
    run.response.wire,
    events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n',
  )
  assert.equal(run.logs[0].final_state, 'verified')
  assert.equal(run.billed.length, 1)
})

async function runNativeResponsesFixture(events, { clientStream = false, streamError = false, native = true, onModels } = {}) {
  const nativeResponsesBody = nativeToolsRequest()
  const sent = []
  let wire = ''
  const res = {
    headersSent: false,
    write(chunk) {
      wire += chunk
    },
  }
  const result = await runApiInference({
    req: {
      apiKeyKind: 'managed',
      apiKeyRecord: { category: 'api', group_type: 'openai_apikey', allowed_vms: ['vm-a'] },
    },
    res,
    cfg: {},
    protocol: 'openai.responses',
    inbound: nativeResponsesBody,
    nativeResponsesBody: native ? nativeResponsesBody : null,
    convertedBody: native ? null : { model: nativeResponsesBody.model, messages: [{ role: 'user', content: 'hi' }] },
    clientStream,
    deliveryMode: 'realtime',
    onModels,
    converters: {
      writeSSEHeaders() {
        res.headersSent = true
      },
    },
    scheduler: {
      pick(model) {
        assert.equal(model, nativeResponsesBody.model)
        return {
          ok: true,
          endpoint: { id: 'ep-a', kind: 'openai', protocol: 'openai', base_url: 'https://fixture.invalid' },
          key: {
            id: 'api-key-a',
            api_key: 'fixture-a',
            source_vm_id: 'vm-a',
            source_account_id: 'account-a',
            proxy_url: 'socks5h://bound-current:1080',
          },
          upstream_model: 'official-upstream-model',
        }
      },
    },
    forwardImpl: async (request) => {
      sent.push(request)
      return {
        statusCode: 200,
        headers: {},
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield Buffer.from('data: ' + JSON.stringify(event) + '\n\n')
          if (streamError) throw new Error('fixture stream disconnected')
          yield Buffer.from('data: [DONE]\n\n')
        },
      }
    },
  })
  return { result, sent, wire, headersSent: res.headersSent, nativeResponsesBody }
}

test('native Responses API replaces only endpoint model and transport stream mode', async () => {
  const response = nativeToolResponse()
  const run = await runNativeResponsesFixture([{ type: 'response.completed', response }])
  assert.equal(run.result.ok, true)
  assert.deepEqual(run.sent[0].body, { ...run.nativeResponsesBody, model: 'official-upstream-model', stream: true })
  assert.equal(run.nativeResponsesBody.stream, false)
  assert.equal(run.sent[0].proxyUrl, 'socks5h://bound-current:1080')
  assert.deepEqual(run.result.nativeResponse, response)
  assert.equal(run.result.accountId, 'api-key-a')
  assert.equal(run.result.model, 'official-upstream-model')
  assert.equal(run.result.sentModel, 'official-upstream-model')
  assert.equal(run.result.upstreamResponseModel, response.model)
})

for (const clientStream of [false, true]) {
  test(`API Responses records only declared response models for ${clientStream ? 'streaming' : 'JSON'} clients`, async () => {
    const response = nativeToolResponse()
    delete response.model
    const models = []
    const run = await runNativeResponsesFixture(
      [
        { type: 'response.created', response: { id: response.id, model: 'reported-at-start' } },
        { type: 'response.in_progress', response: { model: 'reported-later' } },
        { type: 'response.completed', response },
      ],
      { clientStream, onModels: (value) => models.push(value) },
    )
    assert.equal(run.result.ok, true)
    assert.equal(run.result.sentModel, 'official-upstream-model')
    assert.equal(run.result.model, 'official-upstream-model')
    assert.equal(run.result.upstreamResponseModel, 'reported-later')
    assert.deepEqual(models, [
      { sentModel: 'official-upstream-model', upstreamResponseModel: null },
      { sentModel: 'official-upstream-model', upstreamResponseModel: 'reported-at-start' },
      { sentModel: 'official-upstream-model', upstreamResponseModel: 'reported-later' },
    ])

    const missing = await runNativeResponsesFixture([{ type: 'response.completed', response }], { clientStream })
    assert.equal(missing.result.ok, true)
    assert.equal(missing.result.sentModel, 'official-upstream-model')
    assert.equal(missing.result.upstreamResponseModel, null)
  })

  test(`API Anthropic records sent and declared models separately for ${clientStream ? 'streaming' : 'JSON'} clients`, async () => {
    for (const responseModel of ['declared-claude-model', null]) {
      const events = [
        {
          type: 'message_start',
          message: {
            type: 'message',
            role: 'assistant',
            content: [],
            ...(responseModel ? { model: responseModel } : {}),
          },
        },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]
      let sentModel
      const models = []
      const result = await runApiInference({
        cfg: {},
        res: { headersSent: false, write() {} },
        protocol: 'anthropic.messages',
        inbound: { model: 'caller-alias' },
        convertedBody: { model: 'caller-alias', messages: [{ role: 'user', content: 'hi' }] },
        clientStream,
        onModels: (value) => models.push(value),
        converters: { createClaudeMessageAssembler, applyClaudeSSELineToMessage, writeSSEHeaders() {} },
        scheduler: {
          pick: () => ({
            ok: true,
            endpoint: { id: 'ep', kind: 'claude', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
            key: { id: 'key', api_key: 'fixture' },
            upstream_model: 'sent-claude-model',
          }),
        },
        forwardImpl: async ({ body }) => {
          sentModel = body.model
          return {
            statusCode: 200,
            headers: { 'x-model': 'header-model-must-not-be-used' },
            async *[Symbol.asyncIterator]() {
              for (const event of events) yield Buffer.from('data: ' + JSON.stringify(event) + '\n\n')
            },
          }
        },
      })
      assert.equal(result.ok, true)
      assert.equal(sentModel, 'sent-claude-model')
      assert.equal(result.sentModel, sentModel)
      assert.equal(result.model, 'sent-claude-model')
      assert.equal(result.upstreamResponseModel, responseModel)
      assert.deepEqual(models[0], { sentModel: 'sent-claude-model', upstreamResponseModel: null })
      assert.deepEqual(models.at(-1), { sentModel: 'sent-claude-model', upstreamResponseModel: responseModel })
    }
  })
}

test('account API compatible Responses keeps its stream error while reporting the declared model', async () => {
  const models = []
  const run = await runNativeResponsesFixture(
    [{ type: 'response.created', response: { model: 'reported-before-error' } }],
    { native: false, streamError: true, onModels: (value) => models.push(value) },
  )
  assert.equal(run.result.ok, false)
  assert.equal(run.result.status, 502)
  assert.equal(run.result.body.error.message, 'fixture stream disconnected')
  assert.equal(run.result.sentModel, 'official-upstream-model')
  assert.equal(run.result.upstreamResponseModel, 'reported-before-error')
  assert.deepEqual(models, [
    { sentModel: 'official-upstream-model', upstreamResponseModel: null },
    { sentModel: 'official-upstream-model', upstreamResponseModel: 'reported-before-error' },
  ])
})

test('API HTTP errors retain declared response models without changing error mapping', async () => {
  for (const declaration of [{ model: 'reported-error-model' }, { response: { model: 'reported-error-model' } }, {}]) {
    const payload = {
      ...declaration,
      error: { code: 'bad_request', type: 'invalid_request_error', message: 'original upstream message' },
    }
    const models = []
    const result = await runApiInference({
      cfg: {},
      protocol: 'openai.responses',
      nativeResponsesBody: { model: 'caller-model', input: [] },
      onModels: (value) => models.push(value),
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'ep', kind: 'openai', protocol: 'openai', base_url: 'https://fixture.invalid' },
          key: { id: 'key', api_key: 'fixture' },
          upstream_model: 'sent-model',
        }),
      },
      forwardImpl: async () => ({
        statusCode: 400,
        headers: { 'x-model': 'header-model-must-not-be-used' },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify(payload))
        },
      }),
    })
    const expected = declaration.model || declaration.response?.model || null
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    assert.equal(result.model, 'sent-model')
    assert.equal(result.sentModel, 'sent-model')
    assert.equal(result.upstreamResponseModel, expected)
    assert.deepEqual(models.at(-1), { sentModel: 'sent-model', upstreamResponseModel: expected })
    assert.deepEqual(result.body, {
      type: 'error',
      error: { upstream_code: 'bad_request', code: 'bad_request', type: 'api_error', message: payload.error.message },
    })
  }
})

test('native Responses API repairs a missing completed-output tool with its namespace and freeform input', async () => {
  const response = nativeToolResponse()
  const run = await runNativeResponsesFixture([
    { type: 'response.output_item.done', output_index: 0, item: response.output[1] },
    { type: 'response.output_item.done', output_index: 1, item: response.output[2] },
    { type: 'response.completed', response: { ...response, output: response.output.slice(0, 1) } },
  ])
  assert.equal(run.result.ok, true)
  assert.deepEqual(
    run.result.nativeResponse.output.map(({ status, ...item }) => item),
    response.output.map(({ status, ...item }) => item),
  )
})

for (const clientStream of [false, true]) {
  test(`native Responses API requires an official completed terminal for ${clientStream ? 'streaming' : 'JSON'} clients`, async () => {
    const response = nativeToolResponse()
    for (const terminal of [
      null,
      {
        type: 'response.incomplete',
        response: { ...response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      },
    ]) {
      const run = await runNativeResponsesFixture(
        [
          { type: 'response.output_item.done', output_index: 0, item: response.output[1] },
          ...(terminal ? [terminal] : []),
        ],
        { clientStream },
      )
      assert.equal(run.result.ok, false)
      assert.equal(run.result.terminalState, 'incomplete')
    }
    const failed = await runNativeResponsesFixture(
      [
        {
          type: 'response.failed',
          response: {
            id: response.id,
            status: 'failed',
            error: { code: 'server_is_overloaded', type: 'server_error', status: 503, message: 'busy' },
          },
        },
      ],
      { clientStream },
    )
    assert.equal(failed.result.ok, false)
    assert.equal(failed.result.status, 503)
    assert.equal(failed.result.body.error.upstream_code, 'server_is_overloaded')
    assert.equal(failed.headersSent, false)
    const lateFailure = await runNativeResponsesFixture(
      [
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'response.failed',
          response: { status: 'failed', error: { code: 'server_is_overloaded', status: 503, message: 'busy' } },
        },
      ],
      { clientStream },
    )
    assert.equal(lateFailure.result.ok, false)
    assert.equal(lateFailure.result.status, 503)
    assert.equal(lateFailure.result.terminalState, 'incomplete')
  })

  test(`native Responses API reports interrupted ${clientStream ? 'streaming' : 'JSON'} output without success`, async () => {
    const run = await runNativeResponsesFixture(
      [
        { type: 'response.created', response: { model: 'reported-before-interruption' } },
        { type: 'response.output_text.delta', delta: 'partial' },
      ],
      { clientStream, streamError: true },
    )
    assert.equal(run.result.ok, false)
    assert.equal(run.result.status, 502)
    assert.equal(run.result.body.error.code, 'upstream_stream_interrupted')
    assert.equal(run.result.terminalState, 'incomplete')
    assert.equal(run.result.upstreamResponseModel, 'reported-before-interruption')
    assert.equal(run.result.sentModel, 'official-upstream-model')
    const beforeOutput = await runNativeResponsesFixture(
      [{ type: 'response.created', response: { id: 'resp_interrupted', status: 'in_progress', output: [] } }],
      { clientStream, streamError: true },
    )
    assert.equal(beforeOutput.result.ok, false)
    assert.equal(beforeOutput.result.status, 502)
    assert.equal(beforeOutput.result.committed, false)
    assert.equal(beforeOutput.headersSent, false)
    assert.equal(beforeOutput.result.upstreamResponseModel, null)
  })
}
