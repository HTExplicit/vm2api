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
import { CODEX_SEARCH_URL } from '../../src/lib/protocol/codex-models.mjs'
import { openAIAccountHold, resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { summarizeVm, getVm, persistCodexUsage } from '../../src/lib/vm/vm-registry.mjs'
import { codexCredentialPath, readCodexAccounts, writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
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
      id_token: jwt({
        sub: 'subject-' + id,
        email: id + '@example.com',
        email_verified: true,
        [authClaim]: { chatgpt_account_id: 'workspace-' + id },
      }),
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

function renewalHits(f) {
  return f.hits.filter(({ init }) => String(init.body).startsWith('grant_type=refresh_token'))
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
        const code = form.get('code')
        assert.equal(form.get('client_id'), 'oaiapp_mock')
        assert.equal(form.get('resource'), SIWC_RESOURCE)
        assert.equal(form.get('redirect_uri'), SIWC_REDIRECT_URI)
        assert.equal(
          createHash('sha256').update(form.get('code_verifier')).digest('base64url'),
          authorize.searchParams.get('code_challenge'),
        )
        const subject = {
          'changed-subject': 'another-siwc-subject',
          'legacy-subject': 'subject-' + vm.id,
        }[code]
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
            sub: subject || 'siwc-subject-' + vm.id,
            email: code === 'wrong-account' ? 'someone-else@example.com' : vm.id.toUpperCase() + '@example.com',
            email_verified: code !== 'unverified-email',
            ...(code === 'wrong-workspace' ? { [authClaim]: { chatgpt_account_id: 'another-workspace' } } : {}),
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
  const wrongWorkspace = await f.start()
  await assert.rejects(
    f.siwc.finish(f.vm.id, wrongWorkspace.session_id, f.callback(wrongWorkspace, 'wrong-workspace')),
    {
      code: 'siwc_account_mismatch',
    },
  )
  const unverified = await f.start()
  await assert.rejects(f.siwc.finish(f.vm.id, unverified.session_id, f.callback(unverified, 'unverified-email')), {
    code: 'siwc_account_unverified',
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
  assert.equal(f.siwc.read(f.vm.id).siwc_subject, 'siwc-subject-' + f.vm.id)

  const returning = await f.start()
  const authUrl = new URL(returning.auth_url)
  assert.equal(authUrl.searchParams.get('client_id'), 'oaiapp_mock')
  assert.equal(authUrl.searchParams.get('ext_agent_host_id'), firstHost)
  const previous = f.siwc.read(f.vm.id)
  await assert.rejects(f.siwc.finish(f.vm.id, returning.session_id, f.callback(returning, 'changed-subject', '')), {
    code: 'siwc_account_mismatch',
  })
  assert.deepEqual(f.siwc.read(f.vm.id), previous)
  assert.equal((await f.siwc.setEnabled(f.vm.id, false)).bound, true)
  assert.equal((await f.siwc.setEnabled(f.vm.id, true)).enabled, true)
  assert.equal((await f.siwc.unbind(f.vm.id)).bound, false)
  assert.doesNotMatch(JSON.stringify(f.siwc.read(f.vm.id)), /access_token|refresh_token|id_token/)
  const rebind = await f.start()
  assert.equal((await f.siwc.finish(f.vm.id, rebind.session_id, f.callback(rebind, 'renew', ''))).enabled, true)
  assert.equal(
    f.hits.some(({ url }) => url.includes('/revoke')),
    false,
  )
})

test('a saved registration created before SIWC subjects were stored still reauthorizes', async (t) => {
  const f = fixture(t)
  const session = await f.start()
  const { host_id } = f.siwc.read(f.vm.id)
  await f.siwc.finish(f.vm.id, session.session_id, f.callback(session, 'legacy-subject'))
  const { siwc_subject, ...legacy } = f.siwc.read(f.vm.id)
  assert.equal(siwc_subject, 'subject-' + f.vm.id)
  writeCodexSiwc(f.root, f.vm.id, legacy)
  const rebind = await f.start()
  assert.equal(new URL(rebind.auth_url).searchParams.get('client_id'), 'oaiapp_mock')
  assert.equal((await f.siwc.finish(f.vm.id, rebind.session_id, f.callback(rebind, 'legacy-subject', ''))).bound, true)
  assert.equal(f.siwc.read(f.vm.id).host_id, host_id)
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
  const ordinaryFile = codexCredentialPath(f.root, f.vm.id)
  const ordinaryBefore = fs.readFileSync(ordinaryFile)
  await f.bind()
  f.addTime(56 * 60_000)
  await f.siwc.renew(f.vm.id)
  assert.equal(renewalHits(f).length, 0)
  f.addTime(2 * 60_000)
  const earliest = Math.floor((f.options.now() + 59 * 60_000) / 1000)
  f.setRefresh((form) => {
    assert.equal(form.get('client_id'), 'oaiapp_mock')
    assert.equal(form.get('refresh_token'), 'mock-refresh')
    return jsonResponse({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: '3600',
      earliest_refresh_at: String(earliest),
    })
  })
  await Promise.all([f.siwc.renew(f.vm.id), f.siwc.renew(f.vm.id), f.siwc.renew(f.vm.id)])
  assert.equal(renewalHits(f).length, 1)
  const restarted = new CodexSiwcService(f.options)
  assert.equal((await restarted.access(f.vm.id)).access_token, 'new-access')
  assert.equal(restarted.read(f.vm.id).refresh_token, 'new-refresh')
  assert.equal(restarted.read(f.vm.id).scope, scope)
  assert.equal(restarted.view(f.vm.id).next_refresh_at, earliest * 1000)
  assert.equal(renewalHits(f).length, 1)

  f.addTime(59 * 60_000)
  f.setRefresh((form) => {
    assert.equal(form.get('refresh_token'), 'new-refresh')
    return jsonResponse({
      access_token: 'newer-access',
      refresh_token: 'newer-refresh',
      expires_in: 3600,
      earliest_refresh_at: 'invalid',
    })
  })
  await restarted.renew(f.vm.id)
  assert.equal(restarted.view(f.vm.id).next_refresh_at, f.options.now() + 55 * 60_000)
  assert.equal(renewalHits(f).length, 2)
  assert.deepEqual(fs.readFileSync(ordinaryFile), ordinaryBefore)
})

test('an expired caller joins an in-flight renewal and waits for the new access token', async (t) => {
  const f = fixture(t)
  await f.bind()
  const started = Promise.withResolvers()
  const reply = Promise.withResolvers()
  f.setRefresh(() => {
    started.resolve()
    return reply.promise
  })
  f.addTime(58 * 60_000)
  assert.equal((await f.siwc.access(f.vm.id)).access_token, 'mock-access')
  await started.promise
  assert.equal(f.siwc.view(f.vm.id).status, 'refresh_pending')
  f.addTime(3 * 60_000)
  const expired = f.siwc.access(f.vm.id)
  reply.resolve(jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }))
  assert.equal((await expired).access_token, 'new-access')
  assert.equal(renewalHits(f).length, 1)
})

test('proxy preflight and connection failures persist bounded backoff until rotation succeeds', async (t) => {
  const f = fixture(t)
  await f.bind()
  f.addTime(58 * 60_000)
  f.siwc.proxyPool = { snapshot: () => ({ proxies: [{ id: 'px-bound', enabled: false }] }) }
  await f.siwc.renew(f.vm.id)
  assert.equal(renewalHits(f).length, 0)
  assert.equal(f.siwc.view(f.vm.id).status, 'refresh_backoff')
  assert.equal(f.siwc.view(f.vm.id).next_refresh_at, f.options.now() + 30_000)

  const restarted = new CodexSiwcService(f.options)
  await restarted.renew(f.vm.id)
  assert.equal(renewalHits(f).length, 0)
  f.addTime(30_000)
  f.setRefresh((form) => {
    assert.equal(form.get('refresh_token'), 'mock-refresh')
    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' })
  })
  for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
    const count = renewalHits(f).length
    await restarted.renew(f.vm.id)
    assert.equal(restarted.view(f.vm.id).status, 'refresh_backoff')
    assert.equal(restarted.view(f.vm.id).next_refresh_at, f.options.now() + delay)
    f.addTime(delay - 1)
    await restarted.renew(f.vm.id)
    assert.equal(renewalHits(f).length, count + 1)
    f.addTime(1)
  }
  f.setRefresh(() => jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }))
  assert.equal((await restarted.access(f.vm.id)).access_token, 'new-access')
  assert.equal(restarted.read(f.vm.id).refresh_failures, 0)
  assert.equal(restarted.read(f.vm.id).retry_at, null)
})

test('a pending renewal result cannot overwrite a newer binding', async (t) => {
  const f = fixture(t)
  await f.bind()
  const started = Promise.withResolvers()
  const reply = Promise.withResolvers()
  f.setRefresh(() => {
    started.resolve()
    return reply.promise
  })
  f.addTime(58 * 60_000)
  const renewal = f.siwc.renew(f.vm.id)
  await started.promise
  const revision = f.siwc.read(f.vm.id).revision
  await f.bind()
  const rebound = f.siwc.read(f.vm.id)
  assert.notEqual(rebound.revision, revision)
  reply.resolve(jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope }))
  await renewal
  assert.deepEqual(f.siwc.read(f.vm.id), rebound)
})

test('a response read failure never permits replay, even with a connect error code', async (t) => {
  const f = fixture(t)
  await f.bind()
  f.addTime(58 * 60_000)
  f.setRefresh(() => ({
    json: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' })
    },
  }))
  await f.siwc.renew(f.vm.id)
  assert.equal(f.siwc.view(f.vm.id).status, 'refresh_outcome_unknown')
  assert.equal(f.siwc.view(f.vm.id).next_refresh_at, null)
  assert.equal((await f.siwc.access(f.vm.id)).access_token, 'mock-access')
  f.addTime(3 * 60_000)
  await assert.rejects(f.siwc.access(f.vm.id), { code: 'siwc_reauth_required' })
  assert.equal(renewalHits(f).length, 1)
})

test('a renewed token without the ChatGPT plan scope requires rebinding', async (t) => {
  const f = fixture(t)
  await f.bind()
  f.addTime(58 * 60_000)
  f.setRefresh(() =>
    jsonResponse({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      scope: 'openid profile offline_access',
    }),
  )
  await f.siwc.renew(f.vm.id)
  assert.equal(f.siwc.view(f.vm.id).status, 'reauth_required')
  assert.equal(f.siwc.view(f.vm.id).next_refresh_at, null)
  await assert.rejects(f.siwc.access(f.vm.id), { code: 'siwc_reauth_required' })
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
  const extraRouting = {
    ...routing,
    compatibility: { openai_system_prompt: { enabled: true, text: 'Gateway prompt' } },
  }
  for (const [protocol, body, terminal] of inputs) {
    const json = await infer(f, protocol, { ...body, stream: false }, { extraRouting })
    assert.equal(json.status, 200, JSON.stringify(json.payload))
    assert.match(JSON.stringify(json.payload), /你好/)
    assert.equal(json.logBag.via, 'codex-siwc')
    assert.equal(json.logBag.failure_diagnostics.upstreamRequestId, 'mock-request-1')
    const stream = await infer(f, protocol, { ...body, stream: true }, { extraRouting })
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
    assert.equal(body.input[0].role, 'developer')
    assert.equal(body.input[0].content[0].text, 'Gateway prompt')
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

test('unsupported tools and standalone images never use either credential on a pinned SIWC slot', async (t) => {
  const f = fixture(t)
  await f.bind()
  const result = await infer(f, 'openai.responses', { input: 'hello', tools: [{ type: 'image_generation' }] })
  assert.equal(result.status, 400)
  assert.equal(result.payload.error.code, 'siwc_unsupported_capability')
  const answer = await handleCodexImages({
    req: { headers: { 'x-kin-vm': f.vm.id }, apiKeyKind: 'master' },
    res: {},
    json: (_res, status, payload) => ({ status, payload }),
    body: { model },
    kind: 'generations',
    projectRoot: f.root,
    stats: { errors: 0 },
    logBag: {},
    ops: { postCodexJson: () => assert.fail('ordinary image hop') },
  })
  assert.equal(answer.payload.error.code, 'siwc_unsupported_capability')
  assert.equal(f.hits.filter(({ url }) => url.endsWith('/responses')).length, 0)
})

async function searchOnSlot(f, { pin, key, fetchImpl = () => assert.fail('unexpected search hop'), refresh } = {}) {
  const logBag = {}
  const response = await handleCodexSearch({
    req: {
      headers: pin ? { 'x-kin-vm': pin } : {},
      apiKeyKind: key ? 'managed' : 'master',
      apiKeyRecord: key,
    },
    res: {},
    json: (_res, status, payload) => ({ status, payload }),
    body: { model: 'gpt-6.1-sol', commands: { search_query: [{ q: 'search fixture' }] } },
    projectRoot: f.root,
    stats: { requests: 0, errors: 0, by_route: {} },
    logBag,
    ops: { fetchImpl, refresh },
  })
  return { ...response, logBag }
}

test('automatic and pinned search use the ordinary OAuth grant of the selected SIWC slot', async (t) => {
  const f = fixture(t)
  await f.bind()
  const before = f.siwc.read(f.vm.id)
  for (const pin of [null, f.vm.id]) {
    let calls = 0
    const search = await searchOnSlot(f, {
      pin,
      fetchImpl: async (url, options) => {
        calls++
        assert.equal(url, CODEX_SEARCH_URL)
        assert.equal(options.headers.authorization, 'Bearer ordinary-access-' + f.vm.id)
        assert.equal(options.headers['chatgpt-account-id'], 'workspace-' + f.vm.id)
        assert.equal(JSON.parse(options.body).model, 'gpt-6.1-sol')
        return jsonResponse({ results: [{ type: 'text_result' }] })
      },
    })
    assert.equal(search.status, 200)
    assert.deepEqual(search.payload.results, [{ type: 'text_result' }])
    assert.equal(search.logBag.vm_id, f.vm.id)
    assert.equal(search.logBag.via, 'codex-search')
    assert.equal(search.logBag.attempt_count, 1)
    assert.equal(calls, 1)
  }
  const responses = await infer(f, 'openai.responses', { input: 'hello', stream: false }, { pin: null })
  assert.equal(responses.status, 200)
  assert.equal(responses.logBag.via, 'codex-siwc')
  assert.deepEqual(f.siwc.read(f.vm.id), before)
})

test('search refreshes only the ordinary grant of an SIWC slot on a 401', async (t) => {
  const f = fixture(t)
  await f.bind()
  const before = f.siwc.read(f.vm.id)
  const tokensUsed = []
  let refreshes = 0
  const search = await searchOnSlot(f, {
    fetchImpl: async (_url, options) => {
      const auth = options.headers.authorization
      tokensUsed.push(auth)
      return auth === 'Bearer rotated-access'
        ? jsonResponse({ results: [] })
        : jsonResponse({ error: { code: 'token_expired' } }, 401)
    },
    refresh: async ({ refreshToken }) => {
      refreshes++
      assert.equal(refreshToken, 'ordinary-refresh-' + f.vm.id)
      return { ok: true, access_token: 'rotated-access', refresh_token: 'rotated-refresh' }
    },
  })
  assert.equal(search.status, 200)
  assert.deepEqual(tokensUsed, ['Bearer ordinary-access-' + f.vm.id, 'Bearer rotated-access'])
  assert.equal(refreshes, 1)
  assert.equal(readCodexAccounts(f.root, f.vm.id)[0].refresh_token, 'rotated-refresh')
  assert.deepEqual(f.siwc.read(f.vm.id), before)
})

test('missing or rejected ordinary credentials block search while SIWC inference remains available', async (t) => {
  const f = fixture(t)
  await f.bind()
  const [ordinary] = readCodexAccounts(f.root, f.vm.id)
  writeCodexAccounts(f.root, f.vm.id, [{ ...ordinary, access_token: '', refresh_token: '' }])
  const missing = await searchOnSlot(f)
  assert.equal(missing.status, 503)
  assert.equal(missing.payload.error.code, 'no_codex_vm')
  assert.match(missing.logBag.error_message, /普通 Codex 凭据/)
  assert.equal((await searchOnSlot(f, { pin: f.vm.id })).payload.error.code, 'credential_blocked')

  const expiredAccess = jwt({ exp: Math.floor(Date.now() / 1000) - 60 })
  writeCodexAccounts(f.root, f.vm.id, [{ ...ordinary, access_token: expiredAccess, refresh_token: '' }])
  assert.equal((await searchOnSlot(f)).payload.error.code, 'no_codex_vm')
  assert.equal((await searchOnSlot(f, { pin: f.vm.id })).payload.error.code, 'credential_blocked')

  writeCodexAccounts(f.root, f.vm.id, [{ ...ordinary, refresh_token: '' }])
  const rejected = await searchOnSlot(f, {
    fetchImpl: async () => jsonResponse({ error: { code: 'token_revoked' } }, 401),
  })
  assert.equal(rejected.status, 401)
  assert.equal((await searchOnSlot(f, { pin: f.vm.id })).payload.error.code, 'credential_blocked')
  const responses = await infer(f, 'openai.responses', { input: 'hello', stream: false }, { pin: null })
  assert.equal(responses.status, 200)
  assert.equal(responses.logBag.via, 'codex-siwc')
})

test('SIWC search respects the scheduler, slot model allowlist, and key and owner scopes', async (t) => {
  const f = fixture(t)
  await f.bind()
  const recordFile = path.join(f.root, 'vms', f.vm.id + '.json')
  const confined = await searchOnSlot(f, { key: { group_type: 'openai', allowed_vms: ['another-slot'] } })
  assert.equal(confined.payload.error.code, 'no_codex_vm')

  fs.writeFileSync(recordFile, JSON.stringify({ ...f.vm, owner_user_id: 'tenant-slot-owner' }))
  const crossTenant = await searchOnSlot(f, { pin: f.vm.id })
  assert.equal(crossTenant.payload.error.code, 'key_group_mismatch')

  fs.writeFileSync(recordFile, JSON.stringify({ ...f.vm, policy: { allowed_models: [model] } }))
  assert.equal((await searchOnSlot(f)).payload.error.code, 'model_not_allowed')

  fs.writeFileSync(recordFile, JSON.stringify({ ...f.vm, schedulable: false, schedule_off: true }))
  assert.equal((await searchOnSlot(f)).payload.error.code, 'no_codex_vm')

  fs.writeFileSync(recordFile, JSON.stringify({ ...f.vm, status: 'stopped' }))
  assert.equal((await searchOnSlot(f)).payload.error.code, 'no_codex_vm')
  assert.equal((await searchOnSlot(f, { pin: f.vm.id })).payload.error.code, 'vm_stopped')
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

test('GPT slot detail exposes independent Codex and SIWC expiries with either chain selected', async (t) => {
  const f = fixture(t)
  const [ordinary] = readCodexAccounts(f.root, f.vm.id)
  const jwtExpiry = Math.floor(f.options.now() / 1000) + 1200
  const storedExpiry = jwtExpiry + 700
  const subscription = new Date((jwtExpiry + 86_400) * 1000).toISOString()
  writeCodexAccounts(f.root, f.vm.id, [
    {
      ...ordinary,
      access_token: jwt({ exp: jwtExpiry }),
      expires_at: storedExpiry,
      chatgpt_subscription_active_until: subscription,
    },
  ])
  await f.bind()
  const detail = async () =>
    (
      await buildVmDetail({
        cfg: { paths: { project: f.root }, rewrite: {}, base_url: '' },
        id: f.vm.id,
        accountQuota: { config: {}, snapshot: () => ({ accounts: [] }) },
      })
    ).data.vm

  const siwc = await detail()
  assert.equal(siwc.codex_access_expires_at, jwtExpiry * 1000)
  assert.equal(siwc.codex_siwc.expires_at, f.options.now() + 3600_000)
  assert.equal(siwc.expires_at, siwc.codex_siwc.expires_at)
  assert.equal(siwc.chatgpt_subscription_active_until, subscription)
  await f.siwc.setEnabled(f.vm.id, false)
  const codex = await detail()
  assert.equal(codex.codex_access_expires_at, jwtExpiry * 1000)
  assert.equal(codex.codex_siwc.expires_at, siwc.codex_siwc.expires_at)
  assert.equal(codex.expires_at, storedExpiry * 1000)

  writeCodexAccounts(f.root, f.vm.id, [{ ...ordinary, expires_at: storedExpiry }])
  assert.equal((await detail()).codex_access_expires_at, storedExpiry * 1000)
  writeCodexAccounts(f.root, f.vm.id, [ordinary])
  assert.equal((await detail()).codex_access_expires_at, null)
  await f.siwc.unbind(f.vm.id)
  assert.equal((await detail()).codex_siwc.expires_at, null)
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

async function listenGateway(t, f, { upstreamTransport, codexOps, logs = [], maxBodyBytes = 1024 * 1024 } = {}) {
  const routingWithWs = {
    ...routing,
    websocket: { enabled: true },
    codex: {
      ...routing.codex,
      websocket: { enabled: true },
      ...(upstreamTransport && { upstream_transport: upstreamTransport }),
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
    limits: { max_body_bytes: maxBodyBytes },
    paths: { project: f.root, data: f.root },
  }
  const { handleProtocol } = createHandleProtocol({
    json,
    requireAuth,
    cfg,
    routingConfig: routingWithWs,
    requestLog: { start: () => ({ id: 'mock-log' }), finish: (_ctx, row) => logs.push(row) },
    groupsRepo: { rateMultiplier: () => 1 },
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
    codexOps: codexOps || { writeCodexKernelConfig: () => assert.fail('native slot must stay untouched') },
  })
  const ws = createResponsesWsHandler({
    handleProtocol,
    requireAuth,
    json,
    maxBodyBytes,
    getRouting: () => routingWithWs,
  })
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

function wsTurn(socket, body) {
  return new Promise((resolve) => {
    const frames = []
    const onMessage = (message) => {
      const frame = JSON.parse(message)
      frames.push(frame)
      if (['error', 'response.completed', 'response.failed'].includes(frame.type)) {
        socket.off('message', onMessage)
        resolve(frames)
      }
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ type: 'response.create', ...body }))
  })
}

test('SIWC locally acknowledges chained WebSocket prewarms and sends only the generating continuation', {
  timeout: 10000,
}, async (t) => {
  const f = fixture(t)
  await f.bind()
  const outgoing = []
  f.setInference((body) => {
    outgoing.push(body)
    return sse([completion()])
  })
  const logs = []
  const host = await listenGateway(t, f, { upstreamTransport: 'http', logs })
  const client = new WebSocket('ws://' + host + '/v1/responses')
  const other = new WebSocket('ws://' + host + '/v1/responses')
  try {
    await Promise.all([once(client, 'open'), once(other, 'open')])
    const [created, completed] = await wsTurn(client, {
      model,
      generate: false,
      input: 'first',
      instructions: 'stay concise',
    })
    assert.equal(created.type, 'response.created')
    assert.equal(completed.type, 'response.completed')
    assert.equal(created.response.id, completed.response.id)
    assert.deepEqual(completed.response.usage, {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    })
    const [, next] = await wsTurn(client, {
      previous_response_id: completed.response.id,
      generate: false,
      input: 'second',
    })
    assert.equal(next.type, 'response.completed')
    assert.equal(next.response.model, model)
    assert.equal(outgoing.length, 0)
    assert.deepEqual(
      logs.map((row) => [row.via, row.final_state, row.attempt_count]),
      [
        ['siwc-prewarm', 'siwc-prewarm', 0],
        ['siwc-prewarm', 'siwc-prewarm', 0],
      ],
    )
    const [wrongConnection] = await wsTurn(other, { model, input: 'other', previous_response_id: next.response.id })
    assert.equal(wrongConnection.error.code, 'previous_response_not_found')
    assert.equal(outgoing.length, 0)
    const [generated] = await wsTurn(client, { previous_response_id: next.response.id, generate: true, input: 'third' })
    assert.equal(generated.type, 'response.completed')
    assert.equal(outgoing.length, 1)
    assert.deepEqual(
      outgoing[0].input.map((item) => item.content[0].text),
      ['first', 'second', 'third'],
    )
    assert.equal(outgoing[0].instructions, 'stay concise')
    assert.equal(outgoing[0].model, model)
    assert.equal(Object.hasOwn(outgoing[0], 'generate'), false)
    assert.equal(Object.hasOwn(outgoing[0], 'previous_response_id'), false)
    assert.equal(logs.at(-1).via, 'codex-siwc')
  } finally {
    client.terminate()
    other.terminate()
  }
})

test('oversized SIWC WebSocket prewarm receives no unusable response ID', { timeout: 10000 }, async (t) => {
  const f = fixture(t)
  await f.bind()
  const host = await listenGateway(t, f, { maxBodyBytes: 10 * 1024 * 1024 })
  const client = new WebSocket('ws://' + host + '/v1/responses')
  try {
    await once(client, 'open')
    const [frame] = await wsTurn(client, { model, generate: false, input: 'a'.repeat(8 * 1024 * 1024) })
    assert.equal(frame.type, 'error')
    assert.equal(frame.status, 413)
    assert.equal(frame.error.code, 'prewarm_input_too_large')
    assert.equal(f.hits.filter(({ url }) => url.endsWith('/responses')).length, 0)
  } finally {
    client.terminate()
  }
})

test('SIWC does not turn HTTP generate=false into inference and reports real upstream 400s', async (t) => {
  const f = fixture(t)
  await f.bind()
  const prewarm = await infer(f, 'openai.responses', { generate: false, input: 'prewarm' })
  assert.equal(prewarm.status, 400)
  assert.equal(prewarm.payload.error.code, 'unsupported_prewarm')
  assert.equal(f.hits.filter(({ url }) => url.endsWith('/responses')).length, 0)
  f.setInference((body) => {
    assert.equal(Object.hasOwn(body, 'generate'), false)
    return new Response(JSON.stringify({ detail: 'Unsupported parameter: example' }), {
      status: 400,
      headers: { 'x-request-id': 'mock-upstream-400' },
    })
  })
  const rejected = await infer(f, 'openai.responses', { generate: true, input: 'hello' })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.payload.error.message, 'Unsupported parameter: example')
  assert.equal(rejected.logBag.upstream_status, 400)
  assert.equal(rejected.logBag.via, 'codex-siwc')
  assert.equal(rejected.logBag.failure_diagnostics.upstreamHttpStatus, 400)
  assert.equal(rejected.logBag.failure_diagnostics.upstreamRequestId, 'mock-upstream-400')
})

test('native Codex retains generate=false on WebSocket and rejects it on the HTTP-only upstream', {
  timeout: 10000,
}, async (t) => {
  for (const upstreamTransport of ['prefer_websocket', 'http']) {
    const f = fixture(t)
    const nativeHops = []
    const host = await listenGateway(t, f, {
      upstreamTransport,
      codexOps: {
        writeCodexKernelConfig: () => null,
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async ({ body, onEvent }) => {
          nativeHops.push(body)
          const terminal = completion('resp_native_prewarm')
          await onEvent('data: ' + JSON.stringify(terminal))
          return { ok: true, status: 200, body: terminal.response, terminalState: 'verified' }
        },
      },
    })
    const client = new WebSocket('ws://' + host + '/v1/responses')
    try {
      await once(client, 'open')
      const [frame] = await wsTurn(client, { model, input: 'warmup', generate: false })
      if (upstreamTransport === 'http') {
        assert.equal(frame.error.code, 'unsupported_prewarm')
        assert.equal(nativeHops.length, 0)
      } else {
        assert.equal(frame.response.id, 'resp_native_prewarm')
        assert.equal(nativeHops[0].generate, false)
      }
    } finally {
      client.terminate()
    }
  }
})

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
