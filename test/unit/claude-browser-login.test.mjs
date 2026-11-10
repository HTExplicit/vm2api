import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  ClaudeBrowserLoginService,
  parseClaudeBrowserCallback,
  probeClaudeBrowserIdentity,
} from '../../src/lib/oauth/claude-browser-login.mjs'
import { finishOAuthImport, runGuestOAuthAuthService } from '../../src/lib/oauth/guest-oauth-helper.mjs'

const redirect = 'https://platform.claude.com/oauth/code/callback'
const identity = { account_uuid: 'account-first', email: 'first@example.test', org_uuid: 'org-first' }
const grant = (extra = {}) => ({
  access_token: 'fixture-access',
  refresh_token: 'fixture-refresh',
  expires_at: Math.floor(Date.now() / 1000) + 28_800,
  scope: 'user:profile user:inference',
  source: 'fixture',
  ...identity,
  ...extra,
})

function latch() {
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

async function trackedGrant(events, extra = {}) {
  return runGuestOAuthAuthService(
    { operation: 'exchange_code' },
    {
      exec: { vmId: 'vm-11' },
      prepare: async () => ({
        exec: { vmId: 'vm-11', vm: { id: 'vm-11', runtime: { type: 'docker' } } },
        host: {
          bins: { oauthAuth: '/usr/local/bin/kin-oauth-auth' },
          execUser: () => '10011:987',
          dockerEnv: () => undefined,
        },
        configDir: '/home/kincli/.claude',
        home: '/home/kincli',
      }),
      runDocker: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, credential: grant(extra) }) }),
      postTelemetry: async (_exec, event) => {
        events.push(`attempt:${event.phase}`)
        return { ok: true }
      },
    },
  )
}

async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Claude browser login did not settle')
    await sleep(2)
  }
}

function fixture(t, options = {}) {
  const vm = {
    id: 'vm-11',
    status: options.running ? 'running' : 'stopped',
    runtime: { type: 'docker', stopped: !options.running },
    claude: { ...(options.identity || {}) },
    ...(options.scheduleOff ? { schedule_off: true, schedule_off_reason: 'disabled' } : {}),
    ...(options.hold ? { schedule_hold: structuredClone(options.hold) } : {}),
  }
  let current = vm
  const closed = new AbortController()
  const calls = {
    events: options.events || [],
    prepared: [],
    generated: [],
    cli: [],
    exchanged: [],
    probed: [],
    committed: [],
    statuses: [],
    cancelled: [],
    navigationUpdates: [],
    navigations: [],
  }
  let routeHandler, routeMatch, rejectAcquire
  let state = { vm_id: vm.id, status: 'closed' }
  const live = {
    vmId: vm.id,
    proxyUrl: 'socks5h://bound.fixture.test:1080',
    closeSignal: closed.signal,
    page: {
      async goto(url, navigationOptions) {
        calls.navigation = url
        calls.navigations.push({ url, options: navigationOptions })
        if (calls.navigations.length === 1 && options.initialGotoWait) await options.initialGotoWait
      },
    },
    stream: {
      sendNavigation() {
        calls.navigationUpdates.push(live.canReturnToAuthorization?.() || false)
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
      },
    },
  }
  const manager = {
    async acquire(id, args) {
      calls.acquire = { id, ...args }
      state = { vm_id: id, status: options.queued ? 'queued' : 'starting' }
      if (options.queued)
        return new Promise((_, reject) => {
          rejectAcquire = reject
        })
      return live
    },
    state() {
      return state
    },
    assertCurrent() {
      if (closed.signal.aborted) throw Object.assign(Error('closed'), { code: 'oauth_cancelled' })
      if (options.proxyChanged?.()) throw Object.assign(Error('proxy changed'), { code: 'api_proxy_changed' })
    },
    setStatus(_live, status, message, details = {}) {
      state = { vm_id: vm.id, status, message, ...details }
      calls.statuses.push(state)
      calls.events.push(status)
    },
    async bindAccount(_live, id) {
      calls.bound = id
    },
    async persist() {
      if (options.persistError) throw Error('storage failure')
      calls.persisted = true
    },
    async cancel() {
      calls.queueCancelled = true
      rejectAcquire?.(Object.assign(Error('cancelled'), { code: 'oauth_cancelled' }))
    },
  }
  function generated(args) {
    calls.generated.push(args)
    const result = {
      session_id: 'session-first',
      auth_url: `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(redirect)}&state=authorize-nonce`,
      expires_at: Date.now() + 60_000,
    }
    calls.grant = result
    return result
  }
  const service = new ClaudeBrowserLoginService({
    projectRoot: '/fixture',
    browserManager: manager,
    getVm: () => current,
    getAccountIdentity: () => vm.claude,
    getRouting: () => ({ inference: { engine: 'rust' } }),
    ...(options.now ? { now: options.now } : {}),
    async getRuntimeState() {
      calls.inspections = (calls.inspections || 0) + 1
      return { running: options.actualRunning ?? options.running ?? false }
    },
    async prepareOAuth(args) {
      calls.prepared.push(args)
      calls.events.push('prepare')
      if (!(options.actualRunning ?? options.running)) assert.ok(vm.schedule_hold)
      vm.runtime.stopped = false
      if (options.prepareError) throw Error('prepare failed')
    },
    generateAuthUrl: generated,
    async startCliLogin(args) {
      calls.cli.push(args)
      vm.runtime.stopped = false
      if (options.prepareError) throw Error('CLI prepare failed')
      return generated({ cli: true })
    },
    async completeCliLogin(args) {
      calls.exchanged.push(args)
      return options.tokensOnly ? grant({ email: null, account_uuid: null, org_uuid: null }) : grant(options.incoming)
    },
    async stopCliLogin(...args) {
      calls.cliStopped = args
      calls.events.push('cli-stop')
    },
    async exchangeCode(args) {
      calls.exchanged.push(args)
      if (options.exchangeWait) await options.exchangeWait
      return options.oauth || grant(options.incoming)
    },
    cancelAuthSession(id) {
      calls.cancelled.push(id)
    },
    async probeIdentity(args) {
      calls.probed.push(args)
      return options.profileMissing ? args.oauth : grant(options.incoming)
    },
    async commitCredentials(args) {
      calls.committed.push(args)
      calls.events.push('commit')
      if (options.commitWait) await options.commitWait
      if (options.commitFailure) return { ok: false, error: { code: 'import_rejected', message: 'fixture rejection' } }
      if (options.finishCommit) await finishOAuthImport(args.oauth, true)
      vm.claude = { ...vm.claude, ...args.oauth }
      return { ok: true, vm: { id: vm.id, status: vm.status, runtime: { stopped: vm.runtime.stopped } } }
    },
    async setHold(_id, detail) {
      calls.events.push('hold')
      vm.schedule_hold = { reason: 'maintenance', detail }
    },
    async clearHold(_id, tag) {
      calls.events.push('release-hold')
      if (vm.schedule_hold?.reason === 'maintenance' && vm.schedule_hold.detail?.tag === tag) delete vm.schedule_hold
    },
    async stopRuntime() {
      calls.events.push('stop')
      calls.stops = (calls.stops || 0) + 1
      if (options.failFirstStop && calls.stops === 1) return { ok: false }
      vm.runtime.stopped = true
      return { ok: true, runtime: { ...vm.runtime } }
    },
    async persistRuntime(id, runtime) {
      assert.equal(id, vm.id)
      calls.events.push('persist-runtime')
      vm.runtime = runtime
    },
  })
  t.after(() => service.stop())
  return {
    vm,
    live,
    calls,
    service,
    manager,
    remove: () => {
      current = null
    },
    close: () => closed.abort(),
    async waiting() {
      await until(() => routeHandler && calls.navigation)
    },
    async settled() {
      await until(() => !service.jobs.size)
    },
    async callback(params = {}) {
      const url = new URL(redirect)
      url.searchParams.set('code', params.code || 'fixture-code')
      if (params.state !== null) url.searchParams.set('state', params.state || 'provider-exchange-state')
      assert.equal(routeMatch(url), true)
      const handler = routeHandler
      const replies = []
      await handler({
        request: () => ({ url: () => url.href }),
        async fulfill(response) {
          replies.push(response)
        },
      })
      return replies
    },
  }
}

test('Claude callback extracts provider exchange state without comparing the authorize nonce', () => {
  assert.equal(parseClaudeBrowserCallback(`${redirect}?code=abc&state=provider`, redirect), 'abc#provider')
  assert.equal(parseClaudeBrowserCallback(`${redirect}?code=abc`, redirect), 'abc')
  assert.throws(() => parseClaudeBrowserCallback(`${redirect}?error=access_denied`, redirect), {
    code: 'oauth_authorization_denied',
  })
  assert.throws(() => parseClaudeBrowserCallback(`${redirect}?state=x`, redirect), { code: 'code_required' })
  assert.throws(() => parseClaudeBrowserCallback(`${redirect}?code=x#fragment`, redirect), {
    code: 'oauth_callback_invalid',
  })
  assert.throws(
    () => parseClaudeBrowserCallback(`https://platform.claude.com.attacker.test/oauth/code/callback?code=x`, redirect),
    { code: 'oauth_callback_invalid' },
  )
})

test('standard OAuth saves through the shared commit and stops a temporarily started slot before completion', async (t) => {
  const f = fixture(t)
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await f.settled()
  assert.equal(f.calls.prepared[0].preservePowerIntent, true)
  assert.equal(f.calls.exchanged[0].code, 'fixture-code#provider-exchange-state')
  assert.equal(f.calls.exchanged[0].preservePowerIntent, true)
  assert.equal(f.calls.exchanged[0].exec.vmId, f.vm.id)
  assert.equal(f.calls.committed.length, 1)
  assert.equal(f.calls.committed[0].prepareRuntime, false)
  assert.equal(f.calls.committed[0].preservePowerIntent, true)
  assert.equal(f.calls.committed[0].skipOfficialCc, true)
  assert.equal(f.vm.status, 'stopped')
  assert.equal(f.vm.runtime.stopped, true)
  assert.equal(f.vm.schedule_hold, undefined)
  assert.ok(f.calls.events.indexOf('stop') < f.calls.events.indexOf('oauth_complete'))
  assert.ok(f.calls.events.indexOf('persist-runtime') < f.calls.events.indexOf('release-hold'))
  assert.equal(f.calls.statuses.at(-1).result.vm.runtime.stopped, true)
  assert.equal(f.calls.bound, identity.account_uuid)
  assert.equal(f.calls.persisted, true)
})

for (const flavor of ['cai', 'claude_code']) {
  test(`${flavor} returns from an email page using the same original authorization and callback session`, async (t) => {
    const f = fixture(t)
    await f.service.start(f.vm.id, { flavor })
    await f.waiting()
    const original = f.calls.navigation
    assert.equal(f.live.canReturnToAuthorization(), true)
    await f.live.page.goto('https://claude.ai/login/email-link?token=fixture-mail&redirect=fixture')
    const statusesBefore = f.calls.statuses.length
    await f.live.returnToAuthorization()
    assert.equal(f.calls.navigation, original)
    assert.deepEqual(f.calls.navigations.at(-1).options, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    assert.equal(f.calls.statuses.length, statusesBefore)
    assert.equal(f.calls.generated.length, 1)
    assert.equal(f.calls.prepared.length, flavor === 'cai' ? 1 : 0)
    assert.equal(f.calls.cli.length, flavor === 'claude_code' ? 1 : 0)
    assert.equal(f.calls.stops, undefined)
    await f.callback()
    await f.settled()
    assert.equal(f.calls.exchanged[0].sessionId, 'session-first')
    assert.equal(f.calls.committed.length, 1)
    assert.equal(f.calls.stops, 1)
    assert.equal(f.live.returnToAuthorization, undefined)
    assert.equal(f.live.canReturnToAuthorization, undefined)
    assert.equal(f.live.authorizationInProgress, undefined)
    assert.deepEqual(f.calls.navigationUpdates, [true, false, false])
  })
}

test('Claude return navigation failure does not replace OAuth waiting status or regenerate the session', async (t) => {
  const f = fixture(t)
  await f.service.start(f.vm.id)
  await f.waiting()
  const goto = f.live.page.goto
  f.live.page.goto = async () => {
    throw Error('fixture navigation failed')
  }
  const previousStatus = f.calls.statuses.at(-1)
  await assert.rejects(f.live.returnToAuthorization(), /fixture navigation failed/)
  assert.equal(f.calls.statuses.at(-1), previousStatus)
  assert.equal(f.live.canReturnToAuthorization(), true)
  f.live.page.goto = goto
  await f.live.returnToAuthorization()
  await f.callback()
  await f.settled()
  assert.equal(f.calls.generated.length, 1)
})

test('a callback interrupting initial Claude navigation completes its commit before session cleanup', async (t) => {
  let interruptNavigation
  const initialGotoWait = new Promise((_, reject) => {
    interruptNavigation = reject
  })
  const commit = latch()
  const f = fixture(t, { initialGotoWait, commitWait: commit.promise })
  await f.service.start(f.vm.id)
  await f.waiting()
  const callback = f.callback()
  await until(() => f.calls.committed.length)
  assert.equal(f.live.authorizationInProgress(), true)
  interruptNavigation(Error('navigation interrupted by callback'))
  await sleep(5)
  assert.equal(f.service.jobs.size, 1)
  assert.equal(f.calls.cancelled.length, 0)
  assert.equal(f.calls.stops, undefined)
  assert.equal(
    f.calls.statuses.some((status) => status.status === 'error'),
    false,
  )
  commit.resolve()
  await callback
  await f.settled()
  assert.equal(f.calls.statuses.at(-1).status, 'oauth_complete')
  assert.equal(f.calls.committed.length, 1)
  assert.equal(f.calls.stops, 1)
  assert.equal(f.live.authorizationInProgress, undefined)
})

test('interrupted Claude navigation waits for the actual callback failure or explicit cancellation', async (t) => {
  let interruptNavigation
  const initialGotoWait = new Promise((_, reject) => {
    interruptNavigation = reject
  })
  const commit = latch()
  const f = fixture(t, { initialGotoWait, commitWait: commit.promise, commitFailure: true })
  await f.service.start(f.vm.id)
  await f.waiting()
  const callback = f.callback()
  await until(() => f.calls.committed.length)
  interruptNavigation(Error('navigation interrupted by callback'))
  await sleep(5)
  assert.equal(f.calls.cancelled.length, 0)
  assert.equal(
    f.calls.statuses.some((status) => status.status === 'error'),
    false,
  )
  commit.resolve()
  await callback
  await f.settled()
  assert.equal(f.calls.statuses.at(-1).error, 'import_rejected')

  let interruptSecond
  const secondGoto = new Promise((_, reject) => {
    interruptSecond = reject
  })
  const exchange = latch()
  const cancelled = fixture(t, { initialGotoWait: secondGoto, exchangeWait: exchange.promise })
  await cancelled.service.start(cancelled.vm.id)
  await cancelled.waiting()
  const lateCallback = cancelled.callback()
  await until(() => cancelled.calls.exchanged.length)
  interruptSecond(Error('navigation interrupted by callback'))
  const cancellation = cancelled.service.cancel(cancelled.vm.id)
  exchange.resolve()
  await Promise.all([lateCallback, cancellation])
  assert.equal(cancelled.calls.committed.length, 0)
  assert.equal(cancelled.calls.stops, 1)
  assert.equal(
    cancelled.calls.statuses.some((status) => status.status === 'error'),
    false,
  )
})

test('Claude return validates current proxy and account and refuses expired or cancelled authorization', async (t) => {
  let changed = false
  let now = Date.now()
  const f = fixture(t, { proxyChanged: () => changed, now: () => now })
  await f.service.start(f.vm.id)
  await f.waiting()
  const returnToAuthorization = f.live.returnToAuthorization
  changed = true
  await assert.rejects(returnToAuthorization(), { code: 'api_proxy_changed' })
  changed = false
  f.vm.claude = { account_uuid: 'other-account', email: 'other@example.test' }
  await assert.rejects(returnToAuthorization(), { code: 'oauth_account_changed' })
  f.vm.claude = {}
  now = f.calls.grant.expires_at
  assert.equal(f.live.canReturnToAuthorization(), false)
  await assert.rejects(returnToAuthorization(), { code: 'oauth_return_unavailable' })
  now = Date.now()
  await f.service.cancel(f.vm.id)
  await assert.rejects(returnToAuthorization(), { code: 'oauth_cancelled' })
  assert.equal(f.calls.navigations.length, 1)
  assert.equal(f.live.returnToAuthorization, undefined)
})

test('Claude disables return when exchange starts and cleanup leaves a newer capability owner intact', async (t) => {
  const exchange = latch()
  const f = fixture(t, { exchangeWait: exchange.promise })
  await f.service.start(f.vm.id)
  await f.waiting()
  const returnToAuthorization = f.live.returnToAuthorization
  const callback = f.callback()
  await until(() => f.calls.exchanged.length)
  assert.equal(f.live.canReturnToAuthorization(), false)
  await assert.rejects(returnToAuthorization(), { code: 'oauth_return_unavailable' })
  const newerReturn = async () => {}
  const newerCapability = () => true
  const newerProgress = () => false
  f.live.returnToAuthorization = newerReturn
  f.live.canReturnToAuthorization = newerCapability
  f.live.authorizationInProgress = newerProgress
  exchange.resolve()
  await callback
  await f.settled()
  assert.equal(f.live.returnToAuthorization, newerReturn)
  assert.equal(f.live.canReturnToAuthorization, newerCapability)
  assert.equal(f.live.authorizationInProgress, newerProgress)
  assert.deepEqual(f.calls.navigationUpdates, [true, false])
})

test('official CLI runs isolated and verifies token-only credentials before installing them', async (t) => {
  const f = fixture(t, { tokensOnly: true })
  f.service.start(f.vm.id, { flavor: 'claude_code' })
  await f.waiting()
  await f.callback()
  await f.settled()
  assert.equal(f.calls.prepared.length, 0)
  assert.equal(f.calls.cli[0].isolated, true)
  assert.equal(f.calls.cli[0].preservePowerIntent, true)
  assert.equal(f.calls.cli[0].signal.aborted, false)
  assert.equal(f.calls.exchanged[0].code, 'fixture-code#provider-exchange-state')
  assert.equal(f.calls.probed.length, 1)
  assert.equal(f.calls.probed[0].oauth.account_uuid, null)
  assert.equal(f.calls.committed[0].oauth.account_uuid, identity.account_uuid)
  assert.equal(f.calls.cliStopped[2].sessionId, 'session-first')
  assert.ok(f.calls.events.indexOf('cli-stop') < f.calls.events.indexOf('stop'))
})

test('running reauthorization preserves power and manual scheduling without a restart or maintenance hold', async (t) => {
  const f = fixture(t, { running: true, scheduleOff: true, identity })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback({ state: null })
  await f.settled()
  assert.equal(f.calls.exchanged[0].code, 'fixture-code')
  assert.equal(f.calls.stops, undefined)
  assert.equal(f.calls.events.includes('hold'), false)
  assert.equal(f.vm.status, 'running')
  assert.equal(f.vm.runtime.stopped, false)
  assert.equal(f.vm.schedule_off, true)
  assert.equal(f.vm.schedule_off_reason, 'disabled')
})

test('actual runtime wins over stale stopped metadata and a paused running slot stays paused', async (t) => {
  const f = fixture(t, { actualRunning: true, identity })
  await f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await f.settled()
  assert.equal(f.calls.inspections, 1)
  assert.equal(f.calls.stops, undefined)
  assert.equal(f.calls.events.includes('hold'), false)
  assert.equal(f.vm.status, 'stopped')
  assert.equal(f.vm.runtime.stopped, false)

  const paused = fixture(t, { running: true, scheduleOff: true, identity })
  paused.vm.status = 'paused'
  await paused.service.start(paused.vm.id)
  await paused.waiting()
  await paused.callback()
  await paused.settled()
  assert.equal(paused.vm.status, 'paused')
  assert.equal(paused.vm.schedule_off, true)
  assert.equal(paused.calls.stops, undefined)
})

test('the same flavor reuses its login and changing flavor waits for old runtime cleanup', async (t) => {
  const f = fixture(t)
  await f.service.start(f.vm.id)
  await f.waiting()
  await f.service.start(f.vm.id)
  assert.equal(f.calls.generated.length, 1)
  await f.service.start(f.vm.id, { flavor: 'claude_code' })
  await until(() => f.calls.cli.length && f.calls.generated.length === 2)
  assert.equal(f.calls.cancelled.length, 1)
  assert.equal(f.calls.stops, 1)
  await f.waiting()
  await f.callback()
  await f.settled()
  assert.equal(f.calls.committed.length, 1)
})

test('a preexisting hold is preserved and a later hold never gets cleared by an old login', async (t) => {
  const hold = { reason: 'proxy_cooldown', detail: { tag: 'original-proxy' } }
  const f = fixture(t, { hold })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await f.settled()
  assert.deepEqual(f.vm.schedule_hold, hold)
  assert.equal(f.calls.events.includes('hold'), false)

  const g = fixture(t)
  g.service.start(g.vm.id)
  await g.waiting()
  g.vm.schedule_hold = { reason: 'maintenance', detail: { tag: 'newer-operation' } }
  await g.service.cancel(g.vm.id)
  assert.equal(g.vm.schedule_hold.detail.tag, 'newer-operation')
})

test('different account UUID is rejected before commit and its browser state cannot be saved', async (t) => {
  const f = fixture(t, { identity, incoming: { account_uuid: 'other-account' } })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await f.settled()
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.live.persistable, false)
  assert.equal(f.calls.statuses.at(-1).error, 'oauth_account_mismatch')
  assert.equal(f.vm.runtime.stopped, true)
})

test('a rejected incoming grant finishes its real OAuth attempt before temporary shutdown', async (t) => {
  const events = []
  const oauth = await trackedGrant(events, { account_uuid: 'other-account' })
  const f = fixture(t, { identity, oauth, events })
  await f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await f.settled()
  assert.equal(f.calls.committed.length, 0)
  assert.deepEqual(
    events.filter((event) => event.startsWith('attempt:')),
    ['attempt:start', 'attempt:failure'],
  )
  assert.ok(events.indexOf('attempt:failure') < events.indexOf('stop'))
})

test('cancelling after exchange begins finishes its returned grant attempt before stopping', async (t) => {
  const events = []
  const oauth = await trackedGrant(events)
  const exchange = latch()
  const f = fixture(t, { oauth, events, exchangeWait: exchange.promise })
  await f.service.start(f.vm.id)
  await f.waiting()
  const callback = f.callback()
  await until(() => f.calls.exchanged.length)
  const cancel = f.service.cancel(f.vm.id)
  exchange.resolve()
  await Promise.all([callback, cancel])
  assert.equal(f.calls.committed.length, 0)
  assert.deepEqual(
    events.filter((event) => event.startsWith('attempt:')),
    ['attempt:start', 'attempt:failure'],
  )
  assert.ok(events.indexOf('attempt:failure') < events.indexOf('stop'))
})

test('successful shared commit closes its attempt once and cleanup does not report a false failure', async (t) => {
  const events = []
  const oauth = await trackedGrant(events)
  const f = fixture(t, { oauth, events, finishCommit: true })
  await f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await f.settled()
  assert.deepEqual(
    events.filter((event) => event.startsWith('attempt:')),
    ['attempt:start', 'attempt:success'],
  )
  assert.equal(f.calls.statuses.at(-1).status, 'oauth_complete')
  assert.match(f.calls.statuses.at(-1).message, /已恢复原启停与调度设置/)
  assert.doesNotMatch(f.calls.statuses.at(-1).message, /开机并完成/)
})

test('the same account may change organization and email while UUID remains authoritative', async (t) => {
  const f = fixture(t, { identity, incoming: { org_uuid: 'new-org', email: 'alias@example.test' } })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await f.settled()
  assert.equal(f.calls.committed[0].oauth.org_uuid, 'new-org')
  assert.equal(f.calls.committed[0].oauth.email, 'alias@example.test')
  assert.equal(f.calls.statuses.at(-1).status, 'oauth_complete')
})

test('old slots without UUID use their email to reject an unrelated account', async (t) => {
  const f = fixture(t, { identity: { email: 'old@example.test' } })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await f.settled()
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.calls.statuses.at(-1).error, 'oauth_account_mismatch')
})

test('missing incoming identity never borrows the currently bound account metadata', async (t) => {
  const f = fixture(t, { identity, tokensOnly: true, profileMissing: true })
  f.service.start(f.vm.id, { flavor: 'claude_code' })
  await f.waiting()
  await f.callback()
  await f.settled()
  assert.equal(f.calls.probed.length, 1)
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.calls.statuses.at(-1).error, 'oauth_identity_missing')
})

test('cancellation waits for an outstanding exchange and prevents its late credential commit', async (t) => {
  const exchange = latch()
  const f = fixture(t, { exchangeWait: exchange.promise })
  f.service.start(f.vm.id)
  await f.waiting()
  const callback = f.callback()
  await until(() => f.calls.exchanged.length)
  let cancelled = false
  const cancel = f.service.cancel(f.vm.id).then(() => {
    cancelled = true
  })
  await sleep(5)
  assert.equal(cancelled, false)
  exchange.resolve()
  await Promise.all([callback, cancel])
  assert.equal(f.calls.committed.length, 0)
  assert.equal(f.vm.runtime.stopped, true)
  assert.equal(
    f.calls.statuses.some((status) => status.status === 'oauth_complete'),
    false,
  )
})

test('cancellation waits for an already started commit, keeps saved credentials and restores power', async (t) => {
  const commit = latch()
  const f = fixture(t, { commitWait: commit.promise })
  f.service.start(f.vm.id)
  await f.waiting()
  const callback = f.callback()
  await until(() => f.calls.committed.length)
  let cancelled = false
  const cancel = f.service.cancel(f.vm.id).then(() => {
    cancelled = true
  })
  await sleep(5)
  assert.equal(cancelled, false)
  commit.resolve()
  await Promise.all([callback, cancel])
  assert.equal(f.vm.claude.account_uuid, identity.account_uuid)
  assert.equal(f.vm.runtime.stopped, true)
  assert.equal(
    f.calls.statuses.some((status) => status.status === 'oauth_complete'),
    false,
  )
})

test('duplicate callbacks do not exchange or commit twice', async (t) => {
  const commit = latch()
  const f = fixture(t, { commitWait: commit.promise })
  f.service.start(f.vm.id)
  await f.waiting()
  const first = f.callback()
  await until(() => f.calls.committed.length)
  const duplicate = await f.callback()
  assert.equal(duplicate[0].status, 409)
  commit.resolve()
  await first
  await f.settled()
  assert.equal(f.calls.exchanged.length, 1)
  assert.equal(f.calls.committed.length, 1)
})

test('failed temporary shutdown retains its hold until close retries cleanup', async (t) => {
  const f = fixture(t, { failFirstStop: true })
  f.service.start(f.vm.id)
  await f.waiting()
  await f.callback()
  await until(() => f.service.jobs.get(f.vm.id)?.cleanupError)
  assert.ok(f.vm.schedule_hold)
  assert.equal(f.calls.statuses.at(-1).error, 'oauth_runtime_stop_failed')
  await f.service.cancel(f.vm.id)
  assert.equal(f.calls.stops, 2)
  assert.equal(f.vm.schedule_hold, undefined)
  assert.equal(f.service.jobs.size, 0)
  assert.equal(f.calls.committed.length, 1)
})

test('a rejected credential commit is an error and a browser storage failure cannot erase a saved grant', async (t) => {
  const failed = fixture(t, { commitFailure: true })
  failed.service.start(failed.vm.id)
  await failed.waiting()
  await failed.callback()
  await failed.settled()
  assert.equal(failed.calls.statuses.at(-1).error, 'import_rejected')
  const saved = fixture(t, { persistError: true })
  saved.service.start(saved.vm.id)
  await saved.waiting()
  await saved.callback()
  await saved.settled()
  assert.equal(saved.calls.statuses.at(-1).status, 'oauth_complete')
  assert.match(saved.calls.statuses.at(-1).message, /网页会话保存失败/)
})

test('a queued cancelled login never starts a slot and a failed CLI prepare still cleans its partial session', async (t) => {
  const queued = fixture(t, { queued: true })
  queued.service.start(queued.vm.id)
  await queued.service.cancel(queued.vm.id)
  assert.equal(queued.calls.queueCancelled, true)
  assert.equal(queued.calls.prepared.length, 0)
  assert.equal(queued.calls.stops, undefined)
  const failed = fixture(t, { prepareError: true })
  failed.service.start(failed.vm.id, { flavor: 'claude_code' })
  await failed.settled()
  assert.ok(failed.calls.cliStopped)
  assert.equal(failed.vm.runtime.stopped, true)
  assert.equal(failed.vm.schedule_hold, undefined)
})

test('incoming identity profile uses isolated credentials and commits the final temporary grant', async () => {
  const calls = []
  const events = []
  const oauth = await trackedGrant(events, { email: null, account_uuid: null })
  let config, credential
  const result = await probeClaudeBrowserIdentity(
    {
      vm: { id: 'vm-11', runtime: { type: 'docker' } },
      oauth,
      jobId: 'profile-fixture',
    },
    {
      async runDocker(argv, options) {
        calls.push(argv)
        if (argv.includes('/run/kin/worker.json'))
          return {
            code: 0,
            stdout: JSON.stringify({
              vm_id: 'vm-11',
              egress_mode: 'transparent',
              credential_path: '/home/kincli/.claude/credentials.json',
            }),
          }
        if (options.stdin) {
          const lines = options.stdin.trim().split('\n')
          config = JSON.parse(lines[0])
          credential = JSON.parse(lines[1])
        }
        if (argv.some((arg) => arg.endsWith('/credentials.json'))) {
          return {
            code: 0,
            stdout: JSON.stringify({
              claudeAiOauth: {
                accessToken: 'rotated-stage-access',
                refreshToken: 'rotated-stage-refresh',
                expiresAt: Date.now() + 28_800_000,
              },
            }),
          }
        }
        return { code: 0, stdout: '' }
      },
      async slotOauth(exec, op, options) {
        assert.equal(exec.vmId, 'vm-11')
        assert.equal(op, 'profile')
        assert.equal(options.configPath, '/home/kincli/.cache/oauth-browser-profile/profile-fixture/worker.json')
        return {
          ok: true,
          body: {
            account: { uuid: identity.account_uuid, email_address: identity.email },
            organization: { uuid: 'new-org' },
          },
        }
      },
    },
  )
  assert.equal(config.egress_mode, 'transparent')
  assert.equal(config.credential_path, '/home/kincli/.cache/oauth-browser-profile/profile-fixture/credentials.json')
  assert.equal(credential.claudeAiOauth.accessToken, 'fixture-access')
  assert.equal(result.account_uuid, identity.account_uuid)
  assert.equal(result.org_uuid, 'new-org')
  assert.equal(result.access_token, 'rotated-stage-access')
  assert.equal(result.refresh_token, 'rotated-stage-refresh')
  assert.equal(result.source, 'fixture')
  assert.equal(result.scope, 'user:profile user:inference')
  assert.equal(calls.length, 4)
  assert.ok(calls[0].includes('/run/kin/worker.json'))
  assert.ok(calls[1].includes('oauth-profile'))
  assert.ok(calls[2].includes('/home/kincli/.cache/oauth-browser-profile/profile-fixture/credentials.json'))
  assert.ok(calls.at(-1).includes('rm -rf -- "$1"'))
  await finishOAuthImport(result, true)
  await finishOAuthImport(oauth, false)
  assert.deepEqual(events, ['attempt:start', 'attempt:success'])
})
