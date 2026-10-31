import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { CodexBrowserLoginService, parseCodexBrowserCallback } from '../../src/lib/oauth/codex-browser-login.mjs'
import {
  cancelCodexAuthSession,
  exchangeCodexAuthCode,
  generateCodexAuthUrl,
} from '../../src/lib/oauth/codex-oauth.mjs'
import { openaiIdentityFromOauthTokens } from '../../src/lib/oauth/openai-jwt.mjs'

function tokens(email = 'first@example.test', accountId = 'account-first') {
  const claims = { email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }
  const token = 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature'
  return { access_token: token, id_token: token, refresh_token: 'refresh-private', expires_at: '2030-01-01' }
}

async function until(predicate) {
  const deadline = Date.now() + 1500
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('browser login did not settle')
    await sleep(2)
  }
}

function fixture(t, options = {}) {
  const vm = { id: 'vm-first', device_id: 'device-first', codex: { ...(options.identity || {}) } }
  const closeController = new AbortController()
  const calls = {
    acquired: [],
    generated: [],
    exchanged: [],
    committed: [],
    bound: [],
    persisted: [],
    statuses: [],
    cancelled: [],
  }
  let routeMatch, routeHandler, rejectAcquire
  let current = vm
  let tokenIdentity = options.tokenIdentity
  const live = {
    vmId: vm.id,
    proxyUrl: 'socks5h://bound-proxy.test:1080',
    closeSignal: closeController.signal,
    persistable: true,
    page: {
      async goto(url) {
        calls.navigation = url
      },
    },
    context: {
      async route(match, handler) {
        routeMatch = match
        routeHandler = handler
      },
      async unroute(match, handler) {
        assert.equal(match, routeMatch)
        assert.equal(handler, routeHandler)
        routeHandler = null
        calls.unrouted = true
      },
    },
  }
  let state = { status: 'closed', vm_id: vm.id }
  const manager = {
    async acquire(vmId, args) {
      calls.acquired.push({ vmId, ...args })
      state = { status: options.queued ? 'queued' : 'starting', vm_id: vmId }
      if (options.queued) return new Promise((_, reject) => (rejectAcquire = reject))
      return live
    },
    state() {
      return state
    },
    assertCurrent() {
      if (closeController.signal.aborted) throw Object.assign(Error('closed'), { code: 'oauth_cancelled' })
      if (options.proxyChanged?.()) throw Object.assign(Error('proxy changed'), { code: 'browser_proxy_changed' })
    },
    setStatus(_live, status, message, details = {}) {
      state = { status, message, ...details }
      calls.statuses.push(state)
    },
    async bindAccount(_live, accountId) {
      calls.bound.push(accountId)
    },
    async persist(_live) {
      if (options.persistError) throw Error('private storage failure')
      calls.persisted.push(true)
    },
    async cancel() {
      calls.queueCancelled = true
      rejectAcquire?.(Object.assign(Error('cancelled'), { code: 'oauth_cancelled' }))
    },
  }
  const service = new CodexBrowserLoginService({
    browserManager: manager,
    getVm: () => current,
    ...(options.tokenIdentity !== undefined ? { getAccountIdentity: () => tokenIdentity } : {}),
    async commitCredentials(value) {
      calls.committed.push(value)
      const identity = openaiIdentityFromOauthTokens(value.account)
      if (options.tokenIdentity !== undefined) tokenIdentity = identity
      if (!options.tokenOnly) vm.codex = { email: identity.email, chatgpt_account_id: identity.chatgpt_account_id }
      if (options.commitWait) await options.commitWait
      return { vm: { id: vm.id, email: identity.email }, platform: 'openai' }
    },
    generateAuthUrl(args) {
      calls.generated.push(args)
      const result = generateCodexAuthUrl(args)
      if (options.shortExpiry) result.expires_at = Date.now() + 15
      calls.grant = result
      return result
    },
    async exchangeCode(args) {
      calls.exchanged.push(args)
      return options.exchange ? options.exchange(args) : tokens()
    },
    cancelAuthSession(id) {
      calls.cancelled.push(id)
      cancelCodexAuthSession(id)
    },
  })
  t.after(() => service.stop())
  return {
    service,
    live,
    vm,
    manager,
    calls,
    close: () => closeController.abort(),
    remove: () => (current = null),
    setTokenIdentity: (identity) => (tokenIdentity = identity),
    async waiting() {
      await until(() => routeHandler && calls.navigation)
    },
    async callback(parameters = {}) {
      const authorize = new URL(new URL(calls.navigation).searchParams.get('authorize_url'))
      const url = new URL('http://localhost:1455/auth/callback')
      url.searchParams.set('code', parameters.code ?? 'private-code')
      url.searchParams.set('state', parameters.state ?? authorize.searchParams.get('state'))
      assert.equal(routeMatch(url), true)
      const replies = []
      await routeHandler({
        request: () => ({ url: () => url.href }),
        async fulfill(value) {
          replies.push(value)
        },
      })
      return replies
    },
  }
}

test('browser callback accepts only the exact redirect with a present matching state and code', () => {
  const url = 'http://localhost:1455/auth/callback?code=private&state=expected'
  assert.equal(parseCodexBrowserCallback(url, 'expected'), url)
  for (const invalid of [
    url.replace('localhost', 'localhost.attacker.test'),
    url.replace(':1455', ':1456'),
    url.replace('/auth/callback', '/other'),
    url.replace('&state=expected', ''),
    url.replace('state=expected', 'state=other'),
    url + '#fragment',
    url.replace('code=private', 'code='),
  ]) {
    assert.throws(() => parseCodexBrowserCallback(invalid, 'expected'))
  }
  assert.throws(() => parseCodexBrowserCallback(url.replace('code=private', 'error=access_denied'), 'expected'), {
    code: 'oauth_authorization_denied',
  })
})

test('first login commits through the shared chain, binds the slot profile and retains the browser', async (t) => {
  const f = fixture(t)
  f.service.start(f.vm.id)
  await f.waiting()
  const replies = await f.callback()
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.committed.length, 1)
  assert.equal(f.calls.committed[0].vmId, f.vm.id)
  assert.equal(f.calls.exchanged[0].proxyUrl, f.live.proxyUrl)
  assert.deepEqual(f.calls.bound, ['account-first'])
  assert.equal(f.calls.persisted.length, 1)
  const status = f.calls.statuses.at(-1)
  assert.equal(status.status, 'oauth_complete')
  assert.equal(status.result.vm.id, f.vm.id)
  assert.equal(replies[0].status, 200)
  assert.equal(f.live.closeSignal.aborted, false)
  assert.equal(f.calls.unrouted, true)
})

test('reauthorization verifies the existing identity before saving credentials', async (t) => {
  const f = fixture(t, { identity: { email: 'FIRST@example.test', chatgpt_account_id: 'account-first' } })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.committed.length, 1)
  assert.equal(f.calls.acquired[0].retain, true)
  assert.equal(f.calls.generated[0].installationId, f.vm.device_id)
})

test('token identity supports old slots whose VM metadata has no account id', async (t) => {
  const f = fixture(t, {
    identity: { email: 'first@example.test' },
    tokenIdentity: { email: 'FIRST@example.test', chatgpt_account_id: 'account-first' },
    tokenOnly: true,
  })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await until(() => !f.service.jobs.size)
  assert.equal(f.vm.codex.chatgpt_account_id, undefined)
  assert.equal(f.calls.committed.length, 1)
  assert.deepEqual(f.calls.bound, ['account-first'])
  assert.equal(f.calls.statuses.at(-1).status, 'oauth_complete')
})

test('token account id takes precedence over stale VM metadata for account verification', async (t) => {
  const f = fixture(t, {
    identity: { email: 'first@example.test', chatgpt_account_id: 'stale-metadata-account' },
    tokenIdentity: { email: 'first@example.test', accountId: 'current-token-account' },
    exchange: () => tokens('first@example.test', 'different-account'),
  })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.calls.statuses.at(-1).error, 'oauth_account_mismatch')
})

test('changes to the token identity invalidate a pending login even when VM metadata is unchanged', async (t) => {
  const f = fixture(t, {
    identity: { email: 'first@example.test' },
    tokenIdentity: { email: 'first@example.test', chatgpt_account_id: 'account-first' },
  })
  f.service.start(f.vm.id)
  await f.waiting()
  f.setTokenIdentity({ email: 'first@example.test', chatgpt_account_id: 'account-changed' })
  await f.callback()
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.exchanged.length, 0)
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.calls.statuses.at(-1).error, 'oauth_account_changed')
})

test('a different account is never committed or persisted over the slot owner', async (t) => {
  const f = fixture(t, { identity: { email: 'original@example.test', chatgpt_account_id: 'account-original' } })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.calls.persisted.length, 0)
  assert.equal(f.live.persistable, false)
  assert.equal(f.vm.codex.chatgpt_account_id, 'account-original')
  assert.equal(f.calls.statuses.at(-1).error, 'oauth_account_mismatch')
})

test('an invalid callback state cannot reach the token endpoint', async (t) => {
  const f = fixture(t)
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback({ state: 'other-session' })
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.exchanged.length, 0)
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.calls.statuses.at(-1).error, 'state_mismatch')
})

test('repeated start requests share one authorization operation', async (t) => {
  const f = fixture(t)
  f.service.start(f.vm.id)
  f.service.start(f.vm.id)
  await f.waiting()
  assert.equal(f.calls.acquired.length, 1)
  assert.equal(f.calls.generated.length, 1)
  await f.service.cancel(f.vm.id)
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.calls.cancelled.length, 1)
  assert.equal(f.live.closeSignal.aborted, false)
})

test('cancelling a queued login removes its pending browser request', async (t) => {
  const f = fixture(t, { queued: true })
  f.service.start(f.vm.id)
  await f.service.cancel(f.vm.id)
  assert.equal(f.calls.queueCancelled, true)
  assert.equal(f.calls.generated.length, 0)
  assert.equal(f.service.jobs.size, 0)
})

test('closing a waiting browser removes its callback route and authorization session', async (t) => {
  const f = fixture(t)
  f.service.start(f.vm.id)
  await f.waiting()
  const sessionId = f.calls.grant.session_id
  f.close()
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.unrouted, true)
  assert.deepEqual(f.calls.cancelled, [sessionId])
  await assert.rejects(
    exchangeCodexAuthCode({
      sessionId,
      vmId: f.vm.id,
      code: 'unused',
      fetchImpl() {
        throw Error('must not send')
      },
    }),
    { code: 'session_expired' },
  )
  assert.equal(f.calls.committed.length, 0)
})

test('closing while exchange is in flight prevents a late token from being committed', async (t) => {
  let exchanged
  const pending = new Promise((resolve) => (exchanged = resolve))
  const f = fixture(t, { exchange: () => pending })
  f.service.start(f.vm.id)
  await f.waiting()
  const callback = f.callback()
  await until(() => f.calls.exchanged.length)
  f.close()
  exchanged(tokens())
  await callback
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.committed.length, 0)
})

test('cancelling waits for an in-flight commit and never rewrites its removed browser profile', async (t) => {
  let finishCommit
  const commitWait = new Promise((resolve) => (finishCommit = resolve))
  const f = fixture(t, { commitWait })
  f.service.start(f.vm.id)
  await f.waiting()
  const callback = f.callback()
  await until(() => f.calls.committed.length)
  let cancelled = false
  const cancellation = f.service.cancel(f.vm.id).then(() => (cancelled = true))
  f.remove()
  f.close()
  await sleep(5)
  assert.equal(cancelled, false)
  assert.equal(f.service.jobs.size, 1)
  finishCommit()
  await Promise.all([callback, cancellation])
  assert.equal(cancelled, true)
  assert.equal(f.calls.bound.length, 0)
  assert.equal(f.calls.persisted.length, 0)
  assert.equal(
    f.calls.statuses.some((status) => status.status === 'oauth_complete'),
    false,
  )
  assert.equal(f.service.jobs.size, 0)
})

test('a different current identity after commit cannot receive the old browser session', async (t) => {
  let finishCommit
  const commitWait = new Promise((resolve) => (finishCommit = resolve))
  const f = fixture(t, { commitWait })
  f.service.start(f.vm.id)
  await f.waiting()
  const callback = f.callback()
  await until(() => f.calls.committed.length)
  f.vm.codex = { email: 'another@example.test', chatgpt_account_id: 'account-another' }
  finishCommit()
  await callback
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.bound.length, 0)
  assert.equal(f.calls.persisted.length, 0)
  assert.equal(
    f.calls.statuses.some((status) => status.status === 'error'),
    false,
  )
})

test('expired authorization stops waiting without restarting or closing the browser', async (t) => {
  const f = fixture(t, { shortExpiry: true })
  f.service.start(f.vm.id)
  await f.waiting()
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.statuses.at(-1).error, 'session_expired')
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.live.closeSignal.aborted, false)
})

test('a changed slot binding or proxy blocks completion before credential commit', async (t) => {
  let proxyChanged = false
  const f = fixture(t, { proxyChanged: () => proxyChanged })
  f.service.start(f.vm.id)
  await f.waiting()
  proxyChanged = true
  await f.callback()
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.exchanged.length, 0)
  assert.equal(f.calls.committed.length, 0)
})

test('a slot changed by another import cannot receive the pending browser grant', async (t) => {
  const f = fixture(t)
  f.service.start(f.vm.id)
  await f.waiting()
  f.vm.codex = { email: 'other@example.test', chatgpt_account_id: 'account-other' }
  await f.callback()
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.exchanged.length, 0)
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.calls.statuses.at(-1).error, 'oauth_account_changed')
})

test('an incomplete token identity is not installed in an empty slot', async (t) => {
  const f = fixture(t, { exchange: () => ({ access_token: 'opaque-private-token' }) })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.calls.bound.length, 0)
  assert.equal(f.calls.statuses.at(-1).error, 'oauth_identity_missing')
})

test('a webpage session save failure cannot revoke an already committed authorization', async (t) => {
  const f = fixture(t, { persistError: true })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await until(() => !f.service.jobs.size)
  assert.equal(f.calls.committed.length, 1)
  assert.equal(f.calls.statuses.at(-1).status, 'oauth_complete')
  assert.equal(f.calls.statuses.at(-1).result.vm.id, f.vm.id)
})
