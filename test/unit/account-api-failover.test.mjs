import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Readable } from 'node:stream'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'

const complete =
  'data: ' +
  JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'resp-local',
      status: 'completed',
      model: 'gpt-test',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    },
  }) +
  '\n\n'
const response = (status, body, headers = {}) =>
  Object.assign(Readable.from([Buffer.from(body)]), { statusCode: status, headers })
const refusal = (code, status = 429) => response(status, JSON.stringify({ error: { code, message: code } }))

function fixture({ failover = {}, accountCount = 3, allowed = ['vm-a', 'vm-b', 'vm-c'], disableCooling = false } = {}) {
  const keys = Array.from({ length: accountCount }, (_, i) => {
    const name = String.fromCharCode(97 + i)
    return {
      id: 'ek-' + name,
      api_key: 'sk-local-' + name,
      source_account_id: 'acct-' + name,
      source_vm_id: 'vm-' + name,
    }
  })
  const endpoints = keys.map((key) => ({
    id: 'ep-' + key.id,
    kind: 'openai',
    protocol: 'openai',
    disable_cooling: disableCooling,
    api_key_entries: [key],
    models: [{ name: 'legacy-model', alias: 'legacy-model' }],
  }))
  const runtime = new Map(
    keys.map((key) => [
      key.source_vm_id,
      {
        accountId: key.source_account_id,
        enabled: true,
        email: key.source_account_id + '@local.invalid',
        proxyUrl: 'socks5h://' + key.source_vm_id + ':1080',
      },
    ]),
  )
  const scheduler = new ApiScheduler({
    getAccountModels: () => [{ name: 'gpt-test', alias: 'client-model' }],
    resolveAccountKey: (key) => runtime.get(key.source_vm_id),
  })
  scheduler.reload(endpoints)
  const store = {
    listRaw: () => endpoints,
    getKey: (id) => keys.find((key) => key.id === id),
    updateKey(id, patch) {
      Object.assign(
        keys.find((key) => key.id === id),
        patch,
      )
    },
    setKeyCooldown(id, value) {
      keys.find((key) => key.id === id).cooldown_until = value
    },
  }
  const attempts = []
  const attemptsRepo = {
    begin(value) {
      attempts.push({ ...value })
    },
    complete(id, number, value) {
      assert.equal(id, 'request-local')
      Object.assign(attempts[number - 1], value)
    },
  }
  const body = { model: 'client-model', input: 'hello', tools: [], stream: false }
  const options = {
    req: {
      apiKeyKind: 'managed',
      apiKeyRecord: { category: 'api', group_type: 'openai_apikey', allowed_vms: allowed },
    },
    cfg: {},
    scheduler,
    store,
    protocol: 'openai.responses',
    inbound: body,
    convertedBody: body,
    nativeResponsesBody: body,
    getRouting: () => ({ failover }),
    requestId: 'request-local',
    attemptsRepo,
    clientStream: false,
    deliveryMode: 'verified',
    converters: {},
  }
  return { options, keys, endpoints, runtime, attempts }
}

test('local HTTP rejection switches selected account without losing native tools, history or bound proxy', async () => {
  const f = fixture({ allowed: ['vm-a', 'vm-b'] })
  const input = [
    {
      type: 'function_call',
      id: 'item-call',
      call_id: 'call-1',
      name: 'read',
      namespace: 'functions',
      arguments: '{"path":"local"}',
    },
    { type: 'function_call_output', call_id: 'call-1', output: 'temporary fixture contents' },
    { type: 'reasoning', id: 'reason-1', encrypted_content: 'opaque-history' },
  ]
  const tools = [
    {
      type: 'namespace',
      name: 'functions',
      description: 'Local tools',
      tools: [
        {
          type: 'function',
          name: 'read',
          strict: true,
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    },
    { type: 'custom', name: 'apply_patch', format: { type: 'text' } },
  ]
  const body = {
    ...f.options.nativeResponsesBody,
    input,
    tools,
    tool_choice: { type: 'function', name: 'read', namespace: 'functions' },
    parallel_tool_calls: true,
  }
  const sent = [],
    proxies = []
  let resolves = 0
  const resolve = f.options.scheduler.resolveAccountKey
  f.options.scheduler.resolveAccountKey = (key) => {
    const source = resolve(key)
    return { ...source, proxyUrl: source.proxyUrl + (++resolves > 1 ? '?current' : '?initial') }
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      sent.push({ auth: req.headers.authorization, body: JSON.parse(raw) })
      if (sent.length === 1) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'credit_balance_exhausted', message: 'quota' } }))
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(complete)
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await runApiInference({
      ...f.options,
      nativeResponsesBody: body,
      forwardImpl(request) {
        proxies.push(request.proxyUrl)
        return new Promise((resolve, reject) => {
          const upstream = http.request(
            {
              hostname: '127.0.0.1',
              port: server.address().port,
              method: 'POST',
              path: '/responses',
              headers: request.headers,
            },
            resolve,
          )
          upstream.on('error', reject)
          upstream.end(JSON.stringify(request.body))
        })
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.accountId, 'ek-b')
    assert.equal(result.sourceAccountId, 'acct-b')
    assert.equal(result.sourceEmail, 'acct-b@local.invalid')
    assert.equal(result.vmId, null)
    assert.equal(result.attemptCount, 2)
    assert.equal(sent.length, 2)
    assert.deepEqual(
      sent.map((entry) => entry.auth),
      ['Bearer sk-local-a', 'Bearer sk-local-b'],
    )
    for (const entry of sent) {
      assert.equal(entry.body.model, 'gpt-test')
      assert.deepEqual(entry.body.input, input)
      assert.deepEqual(entry.body.tools, tools)
      assert.deepEqual(entry.body.tool_choice, body.tool_choice)
      assert.equal(entry.body.parallel_tool_calls, true)
    }
    assert.deepEqual(proxies, ['socks5h://vm-a:1080?current', 'socks5h://vm-b:1080?current'])
    assert.equal(f.keys[0].cooldown_until, '9999-12-31T23:59:59.999Z')
    assert.deepEqual(
      f.attempts.map((a) => [a.accountId, a.sourceAccountId, a.vmId, a.action]),
      [
        ['ek-a', 'acct-a', null, 'next_unit'],
        ['ek-b', 'acct-b', null, 'return'],
      ],
    )
    assert.equal(f.attempts[0].errorCode, 'credit_balance_exhausted')
    assert.equal(f.attempts[0].usage, undefined)
    assert.equal(f.attempts[1].usage.input_tokens, 3)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

for (const [name, code, status] of [
  ['invalid key', 'invalid_api_key', 401],
  ['rate limit', 'rate_limit_exceeded', 429],
  ['quota', 'insufficient_quota', 429],
]) {
  test(`explicit ${name} switches once to another selected account`, async () => {
    const f = fixture({ accountCount: 2, disableCooling: true })
    let count = 0
    const result = await runApiInference({
      ...f.options,
      forwardImpl: async () => (++count === 1 ? refusal(code, status) : response(200, complete)),
    })
    assert.equal(count, 2)
    assert.equal(result.ok, true)
    assert.equal(f.attempts[0].errorCode, code)
  })
}

test('all explicit refusals return the last official error without repeating any account', async () => {
  const f = fixture({ accountCount: 2, disableCooling: true })
  let count = 0
  const result = await runApiInference({ ...f.options, forwardImpl: async () => refusal('limit-' + ++count) })
  assert.equal(count, 2)
  assert.equal(result.body.error.code, 'limit-2')
  assert.equal(result.attemptCount, 2)
})

for (const failover of [{ max_total_attempts: 2 }, { max_account_switches: 1 }, { max_account_switches: 0 }]) {
  test(`attempt limits are hard: ${JSON.stringify(failover)}`, async () => {
    const f = fixture({ failover })
    let count = 0
    const result = await runApiInference({
      ...f.options,
      forwardImpl: async () => {
        count++
        return refusal('insufficient_quota')
      },
    })
    const expected = failover.max_account_switches === 0 ? 1 : 2
    assert.equal(count, expected)
    assert.equal(result.attemptCount, expected)
  })
}

test('retry deadline prevents starting another account but does not replace the official refusal', async () => {
  const f = fixture({ failover: { total_retry_deadline_ms: 1 } })
  let count = 0
  const result = await runApiInference({
    ...f.options,
    forwardImpl: async () => {
      count++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return refusal('insufficient_quota')
    },
  })
  assert.equal(count, 1)
  assert.equal(result.body.error.code, 'insufficient_quota')
})

for (const [name, forward] of [
  [
    'transport uncertainty',
    async () => {
      throw Object.assign(new Error('local network reset'), { code: 'ECONNRESET' })
    },
  ],
  ['model refusal', async () => refusal('model_not_found', 404)],
  ['server refusal', async () => refusal('server_error', 503)],
  [
    'HTTP 200 failure event',
    async () =>
      response(
        200,
        'data: ' +
          JSON.stringify({
            type: 'response.failed',
            response: { error: { code: 'insufficient_quota', message: 'quota', status: 429 } },
          }) +
          '\n\n',
      ),
  ],
]) {
  test(`${name} does not retry another account`, async () => {
    const f = fixture()
    let count = 0
    const result = await runApiInference({
      ...f.options,
      forwardImpl: async () => {
        count++
        return forward()
      },
    })
    assert.equal(count, 1)
    assert.equal(result.ok, false)
    assert.equal(f.attempts.length, 1)
    assert.ok(f.attempts[0].terminalState)
  })
}

test('a committed downstream response does not retry a rejected account', async () => {
  const f = fixture()
  let count = 0
  const result = await runApiInference({
    ...f.options,
    res: { headersSent: true },
    forwardImpl: async () => {
      count++
      return refusal('insufficient_quota')
    },
  })
  assert.equal(count, 1)
  assert.equal(result.attemptCount, 1)
})

test('client cancellation is terminal and completes its single attempt', async () => {
  const f = fixture()
  const controller = new AbortController()
  let count = 0
  const result = await runApiInference({
    ...f.options,
    signal: controller.signal,
    forwardImpl: async () => {
      count++
      controller.abort()
      throw new Error('cancelled')
    },
  })
  assert.equal(count, 1)
  assert.equal(result.clientCancelled, true)
  assert.equal(f.attempts[0].terminalState, 'cancelled')
})

test('late account unavailability preserves the preceding official refusal without a phantom attempt', async () => {
  const f = fixture({ accountCount: 2 })
  const original = f.options.scheduler.resolveAccountKey
  let secondChecks = 0
  f.options.scheduler.resolveAccountKey = (key) => {
    if (key.source_vm_id === 'vm-b' && ++secondChecks > 1) return null
    return original(key)
  }
  let count = 0
  const result = await runApiInference({
    ...f.options,
    forwardImpl: async () => {
      count++
      return refusal('insufficient_quota')
    },
  })
  assert.equal(count, 1)
  assert.equal(result.body.error.code, 'insufficient_quota')
  assert.equal(result.accountId, 'ek-a')
  assert.equal(result.attemptCount, 1)
  assert.equal(f.attempts.length, 1)
})

test('send-time resolution uses the current key secret and current effective state', async () => {
  const f = fixture({ accountCount: 1 })
  const original = f.options.scheduler.resolveAccountKey
  let count = 0
  f.options.scheduler.resolveAccountKey = (key) => ({
    ...original(key),
    key: { ...key, api_key: ++count === 1 ? 'sk-at-selection' : 'sk-at-send' },
    call_status: 'ready',
  })
  let authorization
  const result = await runApiInference({
    ...f.options,
    forwardImpl: async (request) => {
      authorization = request.headers.authorization
      return response(200, complete)
    },
  })
  assert.equal(result.ok, true)
  assert.equal(authorization, 'Bearer sk-at-send')
})

for (const [status, code] of [
  [401, 'invalid_api_key'],
  [429, 'insufficient_quota'],
  [429, 'rate_limit_exceeded'],
]) {
  test(`late ${code} for a replaced secret does not change the replacement state`, async () => {
    const f = fixture({ accountCount: 1 })
    let recorded = false
    f.options.scheduler.onAccountKeyError = () => {
      recorded = true
    }
    const result = await runApiInference({
      ...f.options,
      forwardImpl: async () => {
        f.keys[0].api_key = 'sk-new-secret'
        f.keys[0].disabled = false
        f.keys[0].cooldown_until = null
        return refusal(code, status)
      },
    })
    assert.equal(result.ok, false)
    assert.equal(f.keys[0].disabled, false)
    assert.equal(f.keys[0].cooldown_until, null)
    assert.equal(recorded, false)
    assert.equal(f.attempts[0].errorCode, code)
  })
}

test('late rejected response after local unbinding does not recreate or mutate the deleted key', async () => {
  const f = fixture({ accountCount: 1 })
  f.options.store.getKey = () => null
  f.options.store.updateKey = () => {
    throw new Error('deleted key must not be updated')
  }
  f.options.store.setKeyCooldown = () => {
    throw new Error('deleted key must not be cooled')
  }
  const result = await runApiInference({ ...f.options, forwardImpl: async () => refusal('invalid_api_key', 401) })
  assert.equal(result.body.error.code, 'invalid_api_key')
  assert.equal(f.attempts[0].sourceAccountId, 'acct-a')
})
