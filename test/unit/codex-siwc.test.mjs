import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { beforeEach, test } from 'node:test'
import { Response } from 'node-fetch'
import { CodexSiwcService, SIWC_REDIRECT_URI, SIWC_RESOURCE } from '../../src/lib/oauth/codex-siwc.mjs'
import { startNodeEgressSocks, stopNodeEgressSocks } from '../../src/lib/cluster/node-egress-socks.mjs'
import { handleCodexImages, handleCodexProtocol, handleCodexSearch } from '../../src/lib/protocol/handle-codex.mjs'
import { openAIAccountHold, resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { summarizeVm, getVm, persistCodexUsage } from '../../src/lib/vm/vm-registry.mjs'
import { writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { writeCodexSiwc } from '../../src/lib/vm/codex-siwc-store.mjs'
import { resolveTestModels, runVmTestChat } from '../../src/lib/admin/vm-test-chat.mjs'
import { buildVmDetail } from '../../src/lib/admin/panel-api.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { withVmLock } from '../../src/lib/vm/vm-file.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createResponsesWsHandler } from '../../src/lib/protocol/responses-ws.mjs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const issuer = 'https://auth.openai.com'
const authClaim = 'https://api.openai.com/auth'
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const model = 'gpt-5.4'

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
function jwt(claims) {
  const unsigned = b64({ alg: 'RS256', kid: 'mock-signing-key' }) + '.' + b64(claims)
  return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')
}

function slot(root, id, extra = {}) {
  const vm = {
    id,
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    proxy: { id: 'px-bound', type: 'http', url: 'http://127.0.0.1:18200' },
    ...extra,
  }
  fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', id + '.json'), JSON.stringify(vm))
  writeCodexAccounts(root, id, [
    {
      id_token: jwt({ sub: 'subject-' + id, [authClaim]: { chatgpt_account_id: 'workspace-' + id } }),
      access_token: 'ordinary-access-' + id,
      refresh_token: 'ordinary-refresh-' + id,
      chatgpt_account_id: 'workspace-' + id,
    },
  ])
  return vm
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function sse(events, headers = {}) {
  const body = events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('')
  const content = Buffer.from(body)
  // A split inside a UTF-8 character must not corrupt the streamed text.
  const split = content.indexOf(Buffer.from('你好')) + 1
  return new Response(Readable.from([content.subarray(0, split), content.subarray(split)]), {
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'mock-request-1', ...headers },
  })
}

function completion(id = 'resp_mock') {
  return {
    type: 'response.completed',
    response: {
      id,
      object: 'response',
      model,
      status: 'completed',
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    },
  }
}

function fixture(t, extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-siwc-'))
  t.after(() => fs.rmSync(root, { recursive: true }))
  const vm = slot(root, 'a-siwc', extra)
  let now = Date.now()
  let authorize
  let refresh = () =>
    jsonResponse({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      scope,
    })
  let inference = () =>
    sse([
      { type: 'response.created', response: { id: 'resp_mock', model } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '你好' },
      completion(),
    ])
  const hits = []
  const options = {
    projectRoot: root,
    getVm: (id) => getVm(root, id),
    now: () => now,
    async fetchImpl(url, init, exit) {
      hits.push({ url, init, exit })
      if (url.endsWith('/jwks.json')) {
        return jsonResponse({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'mock-signing-key' }] })
      }
      if (url.endsWith('/oauth/token')) {
        const form = new URLSearchParams(init.body)
        if (form.get('grant_type') === 'refresh_token') return refresh(form)
        assert.equal(form.get('client_id'), 'oaiapp_mock')
        assert.equal(form.get('resource'), SIWC_RESOURCE)
        assert.equal(form.get('redirect_uri'), SIWC_REDIRECT_URI)
        assert.equal(
          createHash('sha256').update(form.get('code_verifier')).digest('base64url'),
          authorize.searchParams.get('code_challenge'),
        )
        return jsonResponse({
          access_token: 'mock-access',
          refresh_token: 'mock-refresh',
          scope,
          expires_in: 3600,
          earliest_refresh_at: new Date(now + 58 * 60_000).toISOString(),
          id_token: jwt({
            iss: issuer,
            aud: 'oaiapp_mock',
            nonce: authorize.searchParams.get('nonce'),
            exp: Math.floor(now / 1000) + 3600,
            sub: form.get('code') === 'wrong-account' ? 'other-subject' : 'subject-' + vm.id,
            [authClaim]: { chatgpt_account_id: 'workspace-' + vm.id },
          }),
        })
      }
      if (url.endsWith('/models')) {
        assert.match(init.headers.authorization, /^Bearer (mock|new)-access$/)
        return jsonResponse({ models: [{ slug: model, display_name: 'Mock GPT', visibility: 'list' }] })
      }
      assert.equal(url, SIWC_RESOURCE + '/responses')
      assert.match(init.headers.authorization, /^Bearer (mock|new)-access$/)
      return inference(JSON.parse(init.body))
    },
  }
  const siwc = new CodexSiwcService(options)
  return {
    root,
    vm,
    hits,
    siwc,
    options,
    addTime: (ms) => {
      now += ms
    },
    setRefresh: (fn) => {
      refresh = fn
    },
    setInference: (fn) => {
      inference = fn
    },
    async start() {
      const session = await siwc.start(vm.id)
      authorize = new URL(session.auth_url)
      return session
    },
    callback(session, code = 'auth-code', client = '&client_id=oaiapp_mock') {
      return SIWC_REDIRECT_URI + '?state=' + session.session_id + '&code=' + code + client
    },
    async bind() {
      const session = await this.start()
      return siwc.finish(vm.id, session.session_id, this.callback(session))
    },
  }
}

beforeEach(() => resetOpenAIAccountRuntime())

test('binding verifies the same account, preserves Codex, and supports rebind, stop and local unbind', async (t) => {
  const f = fixture(t)
  const original = fs.readFileSync(path.join(f.root, 'vms', f.vm.id, 'codex-credentials.json'))
  const session = await f.start()
  await assert.rejects(
    f.siwc.finish(f.vm.id, session.session_id, f.callback(session).replace('state=', 'state=wrong')),
    {
      code: 'siwc_state_mismatch',
    },
  )
  assert.equal(f.hits.length, 0)
  await assert.rejects(f.siwc.finish(f.vm.id, session.session_id, f.callback(session, 'wrong-account')), {
    code: 'siwc_account_mismatch',
  })
  assert.equal(f.siwc.view(f.vm.id).enabled, false)
  const result = await f.bind()
  assert.equal(result.enabled, true)
  assert.equal(result.status, 'ready')
  assert.deepEqual(
    result.models.map((item) => item.id),
    [model],
  )
  assert.doesNotMatch(JSON.stringify(result), /mock-access|mock-refresh|oaiapp_mock/)
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'vms', f.vm.id, 'codex-credentials.json')), original)
  const firstHost = f.siwc.read(f.vm.id).host_id

  const returning = await f.start()
  const authUrl = new URL(returning.auth_url)
  assert.equal(authUrl.searchParams.get('client_id'), 'oaiapp_mock')
  assert.equal(authUrl.searchParams.get('ext_agent_host_id'), firstHost)
  assert.equal((await f.siwc.finish(f.vm.id, returning.session_id, f.callback(returning, 'renew', ''))).enabled, true)
  assert.equal((await f.siwc.setEnabled(f.vm.id, false)).bound, true)
  assert.equal((await f.siwc.setEnabled(f.vm.id, true)).enabled, true)
  assert.equal((await f.siwc.unbind(f.vm.id)).bound, false)
  assert.doesNotMatch(JSON.stringify(f.siwc.read(f.vm.id)), /access_token|refresh_token|id_token/)
  assert.equal(
    f.hits.some(({ url }) => url.includes('/revoke')),
    false,
  )
})

test('cancelling or replacing the native identity invalidates an outstanding binding', async (t) => {
  const f = fixture(t)
  const first = await f.start()
  assert.equal(f.siwc.cancel(f.vm.id, first.session_id), true)
  await assert.rejects(f.siwc.finish(f.vm.id, first.session_id, f.callback(first)), { code: 'siwc_session_expired' })
  const next = await f.start()
  writeCodexAccounts(f.root, f.vm.id, [{ id_token: jwt({ sub: 'other-user' }), access_token: 'different' }])
  await assert.rejects(f.siwc.finish(f.vm.id, next.session_id, f.callback(next)), { code: 'siwc_account_changed' })
  assert.equal(f.hits.length, 0)
})

test('slot lifecycle can cancel an exchanging callback while holding its record lock', { timeout: 3000 }, async (t) => {
  const f = fixture(t)
  const session = await f.start()
  const entered = Promise.withResolvers()
  const proceed = Promise.withResolvers()
  const fetch = f.siwc.fetchImpl
  f.siwc.fetchImpl = async (...args) => {
    if (args[0].endsWith('/oauth/token')) {
      entered.resolve()
      await proceed.promise
    }
    return fetch(...args)
  }
  const finish = f.siwc.finish(f.vm.id, session.session_id, f.callback(session))
  const rejected = assert.rejects(finish, { code: 'siwc_session_expired' })
  await entered.promise
  await withVmLock(path.join(f.root, 'vms', f.vm.id + '.json'), async () => {
    f.siwc.cancel(f.vm.id)
    proceed.resolve()
    await rejected
  })
  assert.equal(f.siwc.view(f.vm.id).enabled, false)
})

test('renewal respects the server window, single-flights a grant, and survives restart with the rotated record', async (t) => {
  const f = fixture(t)
  await f.bind()
  const renewals = () => f.hits.filter(({ init }) => String(init.body).startsWith('grant_type=refresh_token'))
  f.addTime(56 * 60_000)
  await f.siwc.renew(f.vm.id)
  assert.equal(renewals().length, 0)
  f.addTime(2 * 60_000)
  await Promise.all([f.siwc.renew(f.vm.id), f.siwc.renew(f.vm.id), f.siwc.renew(f.vm.id)])
  assert.equal(renewals().length, 1)
  const restarted = new CodexSiwcService(f.options)
  assert.equal((await restarted.access(f.vm.id)).access_token, 'new-access')
  assert.equal(restarted.read(f.vm.id).refresh_token, 'new-refresh')
  assert.equal(renewals().length, 1)
})

test('lost renewal and an interrupted process do not replay a possibly used grant', async (t) => {
  const f = fixture(t)
  await f.bind()
  f.setRefresh(() => {
    throw new Error('connection lost after submission')
  })
  f.addTime(58 * 60_000)
  await f.siwc.renew(f.vm.id)
  assert.equal(f.siwc.view(f.vm.id).status, 'refresh_outcome_unknown')
  assert.equal((await f.siwc.access(f.vm.id)).access_token, 'mock-access')
  writeCodexSiwc(f.root, f.vm.id, { ...f.siwc.read(f.vm.id), state: 'refresh_pending' })
  const restarted = new CodexSiwcService(f.options)
  f.addTime(3 * 60_000)
  await assert.rejects(restarted.access(f.vm.id), { code: 'siwc_reauth_required' })
  assert.equal(restarted.view(f.vm.id).enabled, true)
  assert.equal(f.hits.filter(({ init }) => String(init.body).startsWith('grant_type=refresh_token')).length, 1)
})

test('terminal refresh rejection keeps SIWC mode until the operator switches it off', async (t) => {
  const f = fixture(t)
  await f.bind()
  f.addTime(58 * 60_000)
  f.setRefresh(() => jsonResponse({ error: 'invalid_grant' }, 400))
  await f.siwc.renew(f.vm.id)
  assert.equal(f.siwc.view(f.vm.id).enabled, true)
  assert.equal(f.siwc.view(f.vm.id).status, 'reauth_required')
  const denied = await infer(f, 'openai.responses', { input: 'hello', stream: false })
  assert.equal(denied.status, 401)
  assert.equal(denied.payload.error.code, 'siwc_reauth_required')
  assert.equal(f.hits.filter(({ url }) => url.endsWith('/responses')).length, 0)
  await f.siwc.setEnabled(f.vm.id, false)
  const native = await infer(
    f,
    'openai.responses',
    { input: 'hello', stream: false },
    {
      native: async () => ({ ok: true, status: 200, body: completion().response }),
    },
  )
  assert.equal(native.status, 200)
  assert.equal(native.logBag.via, 'codex-kernel')
})

const routing = {
  codex: {
    protocols: { 'anthropic.messages': { mode: 'convert', enabled: true } },
    convert: { anthropic_to_codex: true },
  },
  failover: { max_same_account_retries: 0 },
}

async function infer(f, protocol, partial, { pin = f.vm.id, native, extraRouting = routing } = {}) {
  const body = { model, ...partial }
  const req = { headers: pin ? { 'x-kin-vm': pin } : {}, apiKeyKind: 'master' }
  const logBag = {}
  const res = {
    headersSent: false,
    setHeader(name, value) {
      ;(this.headers ||= {})[name] = value
    },
    write(chunk) {
      this.text = (this.text || '') + chunk
    },
    end() {},
  }
  await handleCodexProtocol({
    req,
    res,
    protocol,
    ctx: { body },
    inbound: body,
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, payload) => Object.assign(res, { status, payload }),
    writeSSEHeaders: () => {
      res.headersSent = true
    },
    projectRoot: f.root,
    routing: extraRouting,
    siwc: f.siwc,
    ops: {
      writeCodexKernelConfig: () => (native ? null : assert.fail('native Codex configuration')),
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: native || (() => assert.fail('native Codex call')),
    },
  })
  return { ...res, logBag }
}

test('Responses, Chat and Messages use SIWC over the bound exit in streaming and JSON modes', async (t) => {
  const f = fixture(t)
  await f.bind()
  const inputs = [
    ['openai.responses', { input: 'hello' }, /response.completed/],
    ['openai.chat', { messages: [{ role: 'user', content: 'hello' }] }, /\[DONE\]/],
    ['anthropic.messages', { messages: [{ role: 'user', content: 'hello' }], max_tokens: 16 }, /message_stop/],
  ]
  for (const [protocol, body, terminal] of inputs) {
    const json = await infer(f, protocol, { ...body, stream: false })
    assert.equal(json.status, 200, JSON.stringify(json.payload))
    assert.match(JSON.stringify(json.payload), /你好/)
    assert.equal(json.logBag.via, 'codex-siwc')
    assert.equal(json.logBag.failure_diagnostics.upstreamRequestId, 'mock-request-1')
    const stream = await infer(f, protocol, { ...body, stream: true })
    assert.match(stream.text, terminal)
    assert.match(stream.text, /你好/)
  }
  const calls = f.hits.filter(({ url }) => url.endsWith('/responses'))
  assert.equal(calls.length, 6)
  for (const call of calls) {
    assert.equal(call.exit.proxyUrl, 'http://127.0.0.1:18200')
    assert.equal(call.init.redirect, 'manual')
    const body = JSON.parse(call.init.body)
    assert.equal(body.stream, true)
    assert.equal(body.store, false)
    assert.ok(Array.isArray(body.input))
  }
})

test('the node local-exit forwarder is used for bind, catalog and inference', async (t) => {
  const f = fixture(t, { node_id: 'node-a', proxy: { id: 'px-local', type: 'local' } })
  await assert.rejects(f.start(), { code: 'proxy_unavailable' })
  const forwarder = await startNodeEgressSocks({ clientFor: () => assert.fail('mock used the real node link') })
  t.after(stopNodeEgressSocks)
  await f.bind()
  const result = await infer(f, 'openai.responses', { input: 'hello', stream: false })
  assert.equal(result.status, 200)
  assert.ok(f.hits.length >= 4)
  assert.ok(f.hits.every(({ exit }) => exit.proxyUrl === forwarder.url('node-a')))
})

test('unsupported tools and standalone routes never use either credential on a pinned SIWC slot', async (t) => {
  const f = fixture(t)
  await f.bind()
  const result = await infer(f, 'openai.responses', { input: 'hello', tools: [{ type: 'image_generation' }] })
  assert.equal(result.status, 400)
  assert.equal(result.payload.error.code, 'siwc_unsupported_capability')
  for (const route of [handleCodexImages, handleCodexSearch]) {
    const answer = await route({
      req: { headers: { 'x-kin-vm': f.vm.id }, apiKeyKind: 'master' },
      res: {},
      json: (_res, status, payload) => ({ status, payload }),
      body: { model },
      kind: 'generations',
      projectRoot: f.root,
      stats: { errors: 0 },
      logBag: {},
      ops: {
        postCodexJson: () => assert.fail('ordinary image hop'),
        postCodexSearch: () => assert.fail('ordinary search hop'),
      },
    })
    assert.equal(answer.payload.error.code, 'siwc_unsupported_capability')
  }
  assert.equal(f.hits.filter(({ url }) => url.endsWith('/responses')).length, 0)
})

test('an uncommitted SIWC 429 allows another eligible slot, with Retry-After applied to the first slot', async (t) => {
  const f = fixture(t)
  await f.bind()
  slot(f.root, 'z-ordinary')
  f.setInference(() =>
    sse(
      [
        { type: 'response.created', response: { id: 'limited', model } },
        {
          type: 'response.failed',
          response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limited' } },
        },
      ],
      { 'retry-after': '15' },
    ),
  )
  const swaps = []
  const result = await infer(
    f,
    'openai.responses',
    { input: 'hello', stream: false },
    {
      pin: null,
      native: async ({ exec }) => {
        swaps.push(exec.vmId)
        return { ok: true, status: 200, body: completion('resp_ordinary').response }
      },
    },
  )
  assert.deepEqual(swaps, ['z-ordinary'])
  assert.equal(result.status, 200)
  assert.equal(openAIAccountHold(f.vm.id).reason, 'siwc_rate_limited')
  assert.equal(f.siwc.view(f.vm.id).enabled, true)
  await f.siwc.setEnabled(f.vm.id, false)
  assert.equal(openAIAccountHold(f.vm.id), null)
})

test('partial SIWC streams never hop to native Codex or synthesize a completed response', async (t) => {
  const f = fixture(t)
  await f.bind()
  slot(f.root, 'z-ordinary')
  f.setInference(() =>
    sse([
      { type: 'response.created', response: { id: 'partial', model } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: '你好' },
    ]),
  )
  const result = await infer(f, 'openai.responses', { input: 'hello', stream: true }, { pin: null })
  assert.match(result.text, /你好/)
  assert.match(result.text, /siwc_upstream_stream_incomplete/)
  assert.doesNotMatch(result.text, /response.completed/)
  assert.equal(result.logBag.final_state, 'incomplete')
})

test('the account model directory constrains inference and the panel test catalog', async (t) => {
  const f = fixture(t)
  await f.bind()
  const view = await resolveTestModels({ projectRoot: f.root, vmId: f.vm.id })
  assert.deepEqual(
    view.items.map(({ id, label }) => [id, label]),
    [[model, 'Mock GPT']],
  )
  const denied = await infer(f, 'openai.responses', { model: 'gpt-6.1-sol', input: 'hello', stream: false })
  assert.equal(denied.payload.error.code, 'model_not_allowed')
  assert.equal(f.hits.filter(({ url }) => url.endsWith('/responses')).length, 0)
  assert.equal(summarizeVm(getVm(f.root, f.vm.id), f.root).has_token, true)
})

test('the panel exposes only SIWC summary and limits management to administrators', async (t) => {
  const f = fixture(t)
  await f.bind()
  const cfg = { paths: { project: f.root }, rewrite: {}, base_url: '' }
  const detail = await buildVmDetail({
    cfg,
    id: f.vm.id,
    accountQuota: { config: {}, snapshot: () => ({ accounts: [] }) },
  })
  assert.equal(detail.data.vm.codex_siwc.enabled, true)
  assert.doesNotMatch(JSON.stringify(detail.data.vm.codex_siwc), /mock-access|mock-refresh|oaiapp_mock/)

  const ctx = {
    cfg,
    routingConfig: {},
    codexSiwc: f.siwc,
    requireAuth: () => true,
    json: (res, status, body) => Object.assign(res, { status, body }),
    readBody: async () => ({ enabled: false }),
  }
  const panel = createPanelHandler(ctx)
  const url = new URL('http://localhost/api/panel/vms/' + f.vm.id + '/siwc')
  const call = async (method, panelRole) => {
    const res = { setHeader() {} }
    await panel({ method, headers: {}, panelUser: 'operator', panelRole }, res, url)
    return res
  }
  assert.equal((await call('PATCH', 'user')).status, 403)
  assert.equal(f.siwc.view(f.vm.id).enabled, true)
  const toggled = await call('PATCH', 'admin')
  assert.equal(toggled.status, 200, JSON.stringify(toggled.body))
  assert.equal(toggled.body.data.enabled, false)
  assert.equal((await call('DELETE', 'admin')).body.data.bound, false)
})

test('SIWC continues to respect the existing Codex usage window', async (t) => {
  const f = fixture(t)
  await f.bind()
  persistCodexUsage(f.root, f.vm.id, {
    headers: {
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '1200',
    },
  })
  const denied = await infer(f, 'openai.responses', { input: 'hello', stream: false })
  assert.equal(denied.payload.error.code, 'quota_exhausted')
  assert.equal(f.hits.filter(({ url }) => url.endsWith('/responses')).length, 0)
})

test('SIWC groups function tools while preserving the selected name and call IDs', async (t) => {
  const f = fixture(t)
  await f.bind()
  f.setInference((body) => {
    assert.deepEqual(body.input[0], {
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'function', name: 'lookup', description: '', parameters: { type: 'object', properties: {} } }],
    })
    assert.deepEqual(body.tool_choice, { type: 'function', name: 'lookup' })
    assert.equal(body.input.at(-1).call_id, 'call_prior')
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_next', name: 'lookup', arguments: '{}' }
    const completed = { ...completion(), response: { ...completion().response, output: [call] } }
    return sse([{ type: 'response.output_item.done', output_index: 0, item: call }, completed])
  })
  const result = await infer(f, 'openai.chat', {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', tool_calls: [{ id: 'call_prior', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_prior', content: 'result' },
    ],
    tools: [{ type: 'function', function: { name: 'lookup' } }],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
    stream: false,
  })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  assert.equal(result.payload.choices[0].message.tool_calls[0].id, 'call_next')
})

test('custom tools keep the public Chat shape and full upstream call history', async (t) => {
  const f = fixture(t)
  await f.bind()
  f.setInference((body) => {
    assert.deepEqual(body.input[0].tools, [{ type: 'custom', name: 'format', format: { type: 'text' } }])
    assert.deepEqual(body.tool_choice, { type: 'custom', name: 'format' })
    assert.deepEqual(body.input.slice(-2), [
      { type: 'custom_tool_call', call_id: 'prior', name: 'format', input: 'hello' },
      { type: 'custom_tool_call_output', call_id: 'prior', output: 'done' },
    ])
    const call = { type: 'custom_tool_call', id: 'ct_new', call_id: 'call_new', name: 'format', input: 'hello again' }
    const completed = { ...completion(), response: { ...completion().response, output: [call] } }
    return sse([{ type: 'response.output_item.done', output_index: 0, item: call }, completed])
  })
  const body = {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', tool_calls: [{ id: 'prior', type: 'custom', custom: { name: 'format', input: 'hello' } }] },
      { role: 'tool', tool_call_id: 'prior', content: 'done' },
    ],
    tools: [{ type: 'custom', custom: { name: 'format', format: { type: 'text' } } }],
    tool_choice: { type: 'custom', custom: { name: 'format' } },
  }
  const result = await infer(f, 'openai.chat', { ...body, stream: false })
  assert.equal(result.status, 200, JSON.stringify(result.payload))
  assert.deepEqual(result.payload.choices[0].message.tool_calls, [
    { id: 'call_new', type: 'custom', custom: { name: 'format', input: 'hello again' } },
  ])
  const stream = await infer(f, 'openai.chat', { ...body, stream: true })
  assert.match(stream.text, /"type":"custom","custom":\{"name":"format"/)
  assert.match(stream.text, /"custom":\{"input":"hello again"\}/)
})

async function listenGateway(t, f) {
  const routingWithWs = {
    ...routing,
    websocket: { enabled: true },
    codex: {
      ...routing.codex,
      websocket: { enabled: true },
      clients: { openai_compatible: 'allow', official_codex: 'allow', unknown: 'allow' },
    },
  }
  fs.mkdirSync(path.join(f.root, 'src', 'config'), { recursive: true })
  fs.writeFileSync(path.join(f.root, 'src', 'config', 'routing.json'), JSON.stringify(routingWithWs))
  const json = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const requireAuth = (req) => {
    req.apiKeyKind = 'master'
    req.presentedApiKey = 'mock-gateway-key'
    return true
  }
  const cfg = {
    rewrite: { enabled: false },
    distill: { enabled: false },
    intercept: { rules: [] },
    limits: { max_body_bytes: 1024 * 1024 },
    paths: { project: f.root, data: f.root },
  }
  const { handleProtocol } = createHandleProtocol({
    json,
    requireAuth,
    cfg,
    routingConfig: routingWithWs,
    requestLog: { start: () => ({ id: 'mock-log' }), finish() {} },
    readBody: async (req) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    },
    writeSSEHeaders: (res) => res.writeHead(200, { 'content-type': 'text/event-stream' }),
    apiScheduler: {},
    apiEndpointStore: {},
    accountQuota: { sessions: null, ingestHeaders() {} },
    stats: { requests: 0, errors: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    codexSiwc: f.siwc,
    codexOps: { writeCodexKernelConfig: () => assert.fail('native slot must stay untouched') },
  })
  const ws = createResponsesWsHandler({ handleProtocol, requireAuth, json, getRouting: () => routingWithWs })
  const server = http.createServer((req, res) => {
    void handleProtocol(req, res, 'openai.responses', '/v1/responses').catch((err) => res.destroy(err))
  })
  server.on('upgrade', (req, socket, head) => {
    if (!ws.handleUpgrade(req, socket, head)) socket.destroy()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return '127.0.0.1:' + server.address().port
}

test('existing WebSocket continuation and panel test chat both reach SIWC', { timeout: 5000 }, async (t) => {
  const f = fixture(t)
  await f.bind()
  const inputs = []
  f.setInference((body) => {
    assert.ok(body.input.every((item) => item.type !== 'configuration_update'))
    if (inputs.length === 1) assert.equal(body.reasoning.effort, 'high')
    assert.equal(Object.hasOwn(body, 'previous_response_id'), false)
    inputs.push(body.input)
    return sse([completion('resp_' + inputs.length)])
  })
  const host = await listenGateway(t, f)
  const client = new WebSocket('ws://' + host + '/v1/responses')
  try {
    await once(client, 'open')
    for (const id of [0, 1]) {
      const received = once(client, 'message')
      client.send(
        JSON.stringify({
          type: 'response.create',
          model,
          input: [
            ...(id ? [{ type: 'configuration_update', reasoning: { effort: 'high' } }] : []),
            { type: 'message', role: 'user', content: 'turn ' + id },
          ],
          ...(id ? { previous_response_id: 'resp_1' } : {}),
        }),
      )
      const [frame] = await received
      assert.equal(JSON.parse(frame).type, 'response.completed', frame.toString())
    }
    assert.deepEqual(
      inputs[1].map((item) => item.role),
      ['user', 'assistant', 'user'],
    )
  } finally {
    client.terminate()
  }
  const tested = await runVmTestChat({
    projectRoot: f.root,
    vmId: f.vm.id,
    model,
    prompt: 'panel test',
    apiKey: 'mock-gateway-key',
    baseUrl: 'http://' + host,
  })
  assert.equal(tested.ok, true, JSON.stringify(tested.error))
  assert.equal(tested.text, '你好')
  assert.equal(inputs.length, 3)
})
