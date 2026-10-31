import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'

function upstream(status, body, headers = {}) {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode: status, headers })
}

function fixture({ resolver, onError } = {}) {
  const key = { id: 'ek-a', api_key: 'sk-test-a', source_vm_id: 'vm-a', source_account_id: 'acct-a' }
  const endpoint = {
    id: 'ep-openai',
    kind: 'openai',
    protocol: 'openai',
    api_key_entries: [key],
    models: [{ name: 'gpt-fixture', alias: 'gpt-fixture' }],
  }
  const errors = []
  const scheduler = new ApiScheduler({
    resolveAccountKey:
      resolver || (() => ({ accountId: 'acct-a', enabled: true, proxyUrl: 'socks5h://current-proxy:1080' })),
    onAccountKeyError: onError || ((_key, error) => errors.push(error)),
  })
  scheduler.reload([endpoint])
  const store = {
    listRaw: () => [endpoint],
    updateKey: (id, patch) => {
      assert.equal(id, key.id)
      Object.assign(key, patch)
    },
    setKeyCooldown: (id, until) => {
      assert.equal(id, key.id)
      key.cooldown_until = until
    },
  }
  const options = {
    req: {
      apiKeyKind: 'managed',
      apiKeyRecord: { category: 'api', group_type: 'openai_apikey', allowed_vms: ['vm-a'] },
    },
    cfg: {},
    scheduler,
    store,
    protocol: 'openai.responses',
    inbound: { model: 'gpt-fixture' },
    convertedBody: { model: 'gpt-fixture', messages: [{ role: 'user', content: 'hello' }] },
    clientStream: false,
    deliveryMode: 'verified',
    converters: {},
  }
  return { key, endpoint, scheduler, store, options, errors }
}

const completed = `data: ${JSON.stringify({
  type: 'response.completed',
  response: {
    id: 'resp-fixture',
    model: 'gpt-fixture',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
})}\n\n`

test('account API forwarding re-resolves the bound proxy and keeps OAuth VM billing empty', async () => {
  let resolveCount = 0
  const f = fixture({
    resolver: () => ({
      accountId: 'acct-a',
      enabled: true,
      proxyUrl: ++resolveCount === 1 ? 'socks5h://old-proxy:1080' : 'socks5h://new-proxy:1080',
    }),
  })
  let sent
  const result = await runApiInference({
    ...f.options,
    forwardImpl: async (request) => {
      sent = request
      return upstream(200, completed)
    },
  })
  assert.equal(result.ok, true)
  assert.equal(sent.url, 'https://api.openai.com/v1/responses')
  assert.equal(sent.proxyUrl, 'socks5h://new-proxy:1080')
  assert.equal(sent.headers.authorization, 'Bearer sk-test-a')
  assert.equal(result.vmId, null)
  assert.equal(result.accountId, 'ek-a')
  assert.equal(result.sourceVmId, 'vm-a')
})

test('proxy disappearance between pick and send does not dispatch a direct request', async () => {
  let resolveCount = 0
  const f = fixture({
    resolver: () =>
      ++resolveCount === 1 ? { accountId: 'acct-a', enabled: true, proxyUrl: 'socks5h://old-proxy:1080' } : null,
  })
  let forwarded = false
  const result = await runApiInference({
    ...f.options,
    forwardImpl: async () => {
      forwarded = true
    },
  })
  assert.equal(forwarded, false)
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'api_account_unavailable')
})

test('HTTP balance exhaustion remains blocked until an authoritative balance refresh', async () => {
  const f = fixture()
  const result = await runApiInference({
    ...f.options,
    forwardImpl: async () =>
      upstream(429, JSON.stringify({ error: { code: 'credit_balance_exhausted', message: 'Balance exhausted' } })),
  })
  assert.equal(result.body.error.code, 'credit_balance_exhausted')
  assert.equal(result.body.error.upstream_code, 'credit_balance_exhausted')
  assert.equal(f.key.cooldown_until, '9999-12-31T23:59:59.999Z')
  assert.equal(f.errors[0].code, 'credit_balance_exhausted')
  assert.equal(f.scheduler.pick('gpt-fixture', Date.now(), f.options.req.apiKeyRecord).ok, false)
  f.store.setKeyCooldown(f.key.id, null)
  assert.equal(f.scheduler.pick('gpt-fixture', Date.now(), f.options.req.apiKeyRecord).ok, true)
})

test('invalid project key disables only that upstream entry and retains its identity', async () => {
  const f = fixture()
  const result = await runApiInference({
    ...f.options,
    forwardImpl: async () =>
      upstream(401, JSON.stringify({ error: { code: 'invalid_api_key', message: 'Invalid key' } })),
  })
  assert.equal(result.body.error.upstream_code, 'invalid_api_key')
  assert.equal(f.key.disabled, true)
  assert.equal(f.key.source_account_id, 'acct-a')
  assert.equal(f.key.api_key, 'sk-test-a')
  assert.equal(f.errors[0].code, 'invalid_api_key')
})

test('temporary rate limits use Retry-After without changing account API state', async () => {
  const f = fixture()
  const start = Date.now()
  const result = await runApiInference({
    ...f.options,
    forwardImpl: async () =>
      upstream(429, JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Slow down' } }), {
        'retry-after': '2',
      }),
  })
  assert.equal(result.body.error.upstream_code, 'rate_limit_exceeded')
  assert.ok(Date.parse(f.key.cooldown_until) >= start + 2000)
  assert.ok(Date.parse(f.key.cooldown_until) < start + 5000)
  assert.equal(f.key.disabled, undefined)
  assert.deepEqual(f.errors, [])
})

test('SSE response.failed preserves credit exhaustion and cools the account entry', async () => {
  const f = fixture()
  const event = {
    type: 'response.failed',
    response: {
      error: { code: 'credit_balance_exhausted', type: 'rate_limit_error', message: 'Balance exhausted', status: 429 },
    },
  }
  const result = await runApiInference({
    ...f.options,
    forwardImpl: async () => upstream(200, `data: ${JSON.stringify(event)}\n\n`),
  })
  assert.equal(result.ok, false)
  assert.equal(result.body.error.upstream_code, 'credit_balance_exhausted')
  assert.equal(f.key.cooldown_until, '9999-12-31T23:59:59.999Z')
  assert.equal(f.errors[0].code, 'credit_balance_exhausted')
})
