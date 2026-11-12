import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { SlotBrowserManager } from '../../src/lib/browser/slot-browser-manager.mjs'

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-browser-manager-'))
  const sessionOverrides = options.sessionOverrides
  const records = new Map()
  const vms = new Map(
    ['a', 'b', 'c'].map((id) => [id, { id, proxy: { url: `socks5h://127.0.0.1:${id === 'a' ? 1080 : 1081}` } }]),
  )
  const calls = { launched: [], closed: [], saved: [], routes: [], navigation: [] }
  const repo = {
    get(id) {
      return records.get(id) || null
    },
    upsert(id, patch) {
      const value = { ...(records.get(id) || {}), ...patch }
      records.set(id, value)
      return value
    },
    remove(id) {
      return records.delete(id)
    },
  }
  class Stream {
    constructor(config) {
      this.config = config
      this.clients = new Set()
    }
    attach(ws) {
      this.clients.add(ws)
    }
    sendNavigation() {
      calls.navigation.push({
        canReturnToAuthorization: this.config.canReturnToAuthorization(),
        inputLocked: this.config.isInputLocked(),
      })
    }
    close() {
      this.closed = true
      for (const ws of this.clients) ws.close()
    }
  }
  const manager = new SlotBrowserManager({
    cfg: { paths: { project: root } },
    profileRepo: repo,
    getVm: (id) => vms.get(id),
    resolveProxy: (vm) => vm.proxy?.url,
    Stream,
    async createSession(options) {
      calls.launched.push(options)
      if (options.signal?.aborted) throw Error('closed')
      if (options.signal?.aborted) throw Error('closed')
      const page = new EventEmitter()
      const context = {
        async route(pattern, handler) {
          calls.routes.push([pattern, handler])
        },
      }
      return {
        page,
        context,
        async storageState() {
          return { cookies: [], origins: [{ origin: 'https://auth.openai.com' }] }
        },
        async close() {
          calls.closed.push(options.proxyUrl)
        },
        ...sessionOverrides,
      }
    },
    ...options,
  })
  t.after(async () => {
    await manager.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, manager, vms, records, repo, calls }
}

test('slot identities persist and a retained same-slot session is reused without relaunch or duplicate routing', async (t) => {
  const f = fixture(t)
  const first = await f.manager.acquire('a', { interactive: true, purpose: 'oauth' })
  f.manager.bindAccount(first, 'account-a')
  f.vms.get('a').codex = { chatgpt_account_id: 'account-a' }
  const again = await f.manager.acquire('a', { interactive: true, purpose: 'platform' })
  assert.equal(first, again)
  assert.equal(f.calls.launched.length, 1)
  assert.equal(f.calls.routes.length, 1)
  await f.manager.release(first)
  assert.equal(f.manager.state('a').active, true)
  await f.manager.close('a')
  assert.equal(f.records.get('a').account_id, 'account-a')
  assert.deepEqual(f.records.get('a').storage_state.cookies, [])
  const restored = await f.manager.acquire('a')
  assert.equal(f.calls.launched[1].profileDir, f.calls.launched[0].profileDir)
  assert.deepEqual(f.calls.launched[1].storageState, f.records.get('a').storage_state)
  await f.manager.release(restored)
})

test('installation pauses queued browsers and resumes them with the installed runtime', async (t) => {
  const runtime = { isInstalling: true, launchConfig: () => ({ licenseKey: 'cb_test', cacheDir: '/cache' }) }
  const f = fixture(t, { runtime })
  const ready = f.manager.acquire('a', { interactive: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls.launched.length, 0)
  assert.equal(f.manager.state('a').status, 'queued')
  runtime.isInstalling = false
  void f.manager.drain()
  const live = await ready
  assert.equal(f.calls.launched[0].licenseKey, 'cb_test')
  assert.equal(f.calls.launched[0].cacheDir, '/cache')
  await f.manager.close(live.vmId)
})

test('ordinary close retains the profile while forget removes only its own slot profile', async (t) => {
  const f = fixture(t)
  for (const id of ['a', 'b']) {
    fs.mkdirSync(f.manager.profileDirectory(id), { recursive: true })
    fs.writeFileSync(path.join(f.manager.profileDirectory(id), '.cloakbrowser-seed'), `seed-${id}`)
  }
  const first = await f.manager.acquire('a', { interactive: true })
  await f.manager.close(first.vmId)
  assert.equal(fs.readFileSync(path.join(f.manager.profileDirectory('a'), '.cloakbrowser-seed'), 'utf8'), 'seed-a')
  await f.manager.close('a', { forget: true })
  assert.equal(fs.existsSync(f.manager.profileDirectory('a')), false)
  assert.equal(fs.readFileSync(path.join(f.manager.profileDirectory('b'), '.cloakbrowser-seed'), 'utf8'), 'seed-b')
  assert.throws(() => f.manager.forgetProfile('../outside'), { code: 'invalid_vm_id' })
})

test('a pending HTTP cookie update is acknowledged by a fresh native snapshot after launch', async (t) => {
  const f = fixture(t)
  f.records.set('a', { storage_state: { cookies: [{ name: 'new', value: 'http' }], cookies_pending: true } })
  await f.manager.acquire('a', { interactive: true })
  assert.equal(f.calls.launched[0].storageState.cookies_pending, true)
  assert.equal(f.records.get('a').storage_state.cookies_pending, undefined)
  assert.deepEqual(f.records.get('a').storage_state.cookies, [])
})

test('missing runtime configuration remains a typed browser state for the settings link', async (t) => {
  const f = fixture(t, {
    runtime: {
      launchConfig() {
        throw Object.assign(new Error('configure browser'), { code: 'browser_key_required' })
      },
    },
  })
  await assert.rejects(f.manager.acquire('a'), { code: 'browser_key_required' })
  assert.equal(f.manager.state('a').error, 'browser_key_required')
  assert.equal(f.calls.launched.length, 0)
})

test('navigation reuses the live OAuth return callback and tracks Platform input locks without replacing status', async (t) => {
  const f = fixture(t)
  const live = await f.manager.acquire('a', { interactive: true, purpose: 'oauth' })
  let returns = 0
  live.returnToAuthorization = async () => {
    returns++
  }
  live.canReturnToAuthorization = () => true
  assert.equal(live.stream.config.isInputLocked(), true, 'the initial ready page must await OAuth navigation')
  f.manager.setStatus(live, 'opening', '正在打开授权页')
  assert.deepEqual(f.calls.navigation.at(-1), { canReturnToAuthorization: false, inputLocked: true })
  assert.equal(live.stream.config.onInput({ type: 'click' }), true, 'navigation locks do not change page input policy')
  f.manager.setStatus(live, 'oauth_waiting', '等待授权')
  assert.deepEqual(f.calls.navigation.at(-1), { canReturnToAuthorization: true, inputLocked: false })
  await live.stream.config.onReturnToAuthorization()
  assert.equal(returns, 1)
  assert.equal(f.manager.state('a').status, 'oauth_waiting')
  live.authorizationInProgress = () => true
  live.stream.sendNavigation()
  assert.equal(f.calls.navigation.at(-1).inputLocked, true)
  assert.equal(live.stream.config.isAuthorizationCompleting(), true)
  live.authorizationInProgress = () => false

  live.inputLocked = true
  f.manager.setStatus(live, 'configuring', '正在配置')
  assert.deepEqual(f.calls.navigation.at(-1), { canReturnToAuthorization: false, inputLocked: true })
  assert.equal(live.stream.config.onInput({ type: 'navigate' }), false)
  assert.equal(live.stream.config.onInput({ type: 'return_to_authorization' }), false)
  assert.equal(live.stream.config.onInput({ type: 'continue' }), true)
  assert.equal(live.stream.config.onInput({ type: 'close' }), true)

  live.inputLocked = false
  live.canReturnToAuthorization = () => false
  f.manager.setStatus(live, 'oauth_complete', '授权已保存')
  assert.deepEqual(f.calls.navigation.at(-1), { canReturnToAuthorization: false, inputLocked: false })
  assert.throws(() => live.stream.config.onReturnToAuthorization(), { code: 'oauth_return_unavailable' })
  assert.equal(returns, 1)
  assert.equal(f.manager.state('a').status, 'oauth_complete')
  assert.equal(live.stream.config.isAuthorizationCompleting(), true)
  await f.manager.close('a')
  assert.equal(f.calls.navigation.at(-1).inputLocked, true)
})

test('Platform opening locks only its address tools until its existing interaction phase begins', async (t) => {
  const f = fixture(t)
  const live = await f.manager.acquire('a', { interactive: true, purpose: 'platform' })
  assert.equal(live.stream.config.isInputLocked(), false)
  f.manager.setStatus(live, 'opening', '正在打开 Platform')
  assert.equal(f.calls.navigation.at(-1).inputLocked, true)
  assert.equal(live.stream.config.onInput({ type: 'click' }), true)
  f.manager.setStatus(live, 'needs_login', '请登录')
  assert.equal(f.calls.navigation.at(-1).inputLocked, false)
})

test('return-to-authorization checks the current slot binding before calling a live callback', async (t) => {
  const f = fixture(t)
  const live = await f.manager.acquire('a', { interactive: true })
  let returned = false
  live.canReturnToAuthorization = () => true
  live.returnToAuthorization = () => {
    returned = true
  }
  f.vms.get('a').proxy.url = 'socks5h://127.0.0.1:9999'
  assert.throws(() => live.stream.config.onReturnToAuthorization(), { code: 'api_proxy_changed' })
  assert.equal(returned, false)
})

test('one browser runs at a time, queued interactive work precedes background work, and cancelled work never launches', async (t) => {
  const f = fixture(t)
  const active = await f.manager.acquire('a', { interactive: true })
  const background = f.manager.acquire('b')
  const next = f.manager.acquire('c', { interactive: true })
  assert.equal(f.manager.state('b').status, 'queued')
  assert.equal(f.manager.state('c').status, 'queued')
  assert.equal(f.calls.launched.length, 1)
  await f.manager.close('b')
  await assert.rejects(background, { code: 'browser_closed' })
  await f.manager.close(active.vmId)
  const second = await next
  assert.equal(second.vmId, 'c')
  assert.equal(f.calls.launched.length, 2)
})

test('background same-slot work waits for the retained interactive session to close', async (t) => {
  const f = fixture(t)
  await f.manager.acquire('a', { interactive: true, purpose: 'oauth' })
  const background = f.manager.acquire('a', { purpose: 'balance' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls.launched.length, 1)
  assert.equal(f.manager.state('a').purpose, 'oauth')
  await f.manager.close('a')
  const live = await background
  assert.equal(live.purpose, 'balance')
  assert.equal(f.calls.launched.length, 2)
  await f.manager.release(live)
})

test('cancelling background work waiting on an interactive browser does not reopen a deleted slot', async (t) => {
  const f = fixture(t)
  await f.manager.acquire('a', { interactive: true, purpose: 'oauth' })
  const controller = new AbortController()
  const background = f.manager.acquire('a', { purpose: 'balance', signal: controller.signal })
  controller.abort(new Error('deleted'))
  await assert.rejects(background, /deleted/)
  await f.manager.close('a', { forget: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls.launched.length, 1)
  assert.equal(f.manager.state('a').active, false)
})

test('cancelling a queued acquisition releases its own pending browser', async (t) => {
  const f = fixture(t)
  await f.manager.acquire('a', { interactive: true })
  const controller = new AbortController()
  const background = f.manager.acquire('b', { signal: controller.signal })
  controller.abort(new Error('cancelled'))
  await assert.rejects(background, /cancelled/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.manager.jobs.has('b'), false)
  await f.manager.close('a')
  assert.equal(f.calls.launched.length, 1)
})

test('closing while launch is pending aborts immediately and never leaves a browser or profile behind', async (t) => {
  let finishLaunch
  let closed = false
  const f = fixture(t, {
    createSession: async () => {
      await new Promise((resolve) => {
        finishLaunch = resolve
      })
      return {
        async close() {
          closed = true
        },
      }
    },
  })
  const ready = f.manager.acquire('a', { interactive: true })
  const live = f.manager.jobs.get('a')
  const closing = f.manager.close('a', { forget: true })
  assert.equal(live.closeSignal.aborted, true)
  finishLaunch()
  await closing
  await assert.rejects(ready, { code: 'browser_closed' })
  assert.equal(closed, true)
  assert.equal(f.manager.state('a').active, false)
  assert.equal(f.records.has('a'), false)
})

test('a changed proxy closes the old session without persisting stale account state', async (t) => {
  const f = fixture(t)
  const live = await f.manager.acquire('a', { interactive: true })
  f.vms.get('a').proxy.url = 'socks5h://127.0.0.1:9999'
  assert.throws(() => f.manager.assertCurrent(live), { code: 'api_proxy_changed' })
  await f.manager.close('a', { reason: 'identity_changed' })
  assert.equal(f.records.get('a').storage_state, undefined)
  const restored = await f.manager.acquire('a')
  assert.equal(restored.proxyUrl, 'socks5h://127.0.0.1:9999')
  assert.equal(f.calls.launched[1].profileDir, f.calls.launched[0].profileDir)
})

test('unknown or unbound slots cannot launch or obtain browser tickets', async (t) => {
  const f = fixture(t)
  f.vms.get('a').proxy = null
  assert.throws(() => f.manager.browserTicket('a'), { code: 'proxy_required' })
  await assert.rejects(f.manager.acquire('missing'), { code: 'vm_not_found' })
  assert.equal(f.calls.launched.length, 0)
})

test('a stale or cancelled OAuth callback cannot recreate a deleted profile through bindAccount', async (t) => {
  const f = fixture(t)
  const live = await f.manager.acquire('a', { interactive: true })
  f.vms.get('a').codex = { chatgpt_account_id: 'different-account' }
  assert.throws(() => f.manager.bindAccount(live, 'old-account'), { code: 'api_account_changed' })
  await f.manager.close('a', { forget: true })
  assert.throws(() => f.manager.bindAccount(live, 'different-account'), { code: 'browser_closed' })
  assert.equal(f.records.has('a'), false)
})

test('credential-derived account identity is authoritative when legacy VM metadata is absent', async (t) => {
  let account = 'token-account-a'
  const f = fixture(t, { getAccountIdentity: () => account })
  const live = await f.manager.acquire('a', { interactive: true })
  assert.equal(live.accountId, 'token-account-a')
  f.manager.bindAccount(live, account)
  account = 'token-account-b'
  assert.throws(() => f.manager.assertCurrent(live), { code: 'api_account_changed' })
  assert.throws(() => f.manager.bindAccount(live, account), { code: 'api_account_changed' })
  assert.equal(f.repo.get('a').account_id, 'token-account-a')
})

test('WebSocket tickets work while queued, accept legacy paths, are one use, and are revoked by close', async (t) => {
  const f = fixture(t)
  await f.manager.acquire('a', { interactive: true })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    if (!f.manager.handleUpgrade(req, socket, head)) socket.destroy()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = `ws://127.0.0.1:${server.address().port}`
  const unauthenticated = new WebSocket(`${address}/api/panel/vms/a/browser`)
  unauthenticated.on('error', () => {})
  const [, denied] = await once(unauthenticated, 'unexpected-response')
  assert.equal(denied.statusCode, 401)
  unauthenticated.terminate()
  const ticket = f.manager.browserTicket('b')
  const legacy = ticket.url.replace('/b/browser?', '/b/openai-api/browser?')
  const ws = new WebSocket(address + legacy)
  t.after(() => ws.terminate())
  const status = once(ws, 'message')
  await once(ws, 'open')
  assert.equal(JSON.parse(String((await status)[0])).status, 'queued')
  const repeated = new WebSocket(address + legacy)
  repeated.on('error', () => {})
  const [, response] = await once(repeated, 'unexpected-response')
  assert.equal(response.statusCode, 401)
  repeated.terminate()
  const pending = f.manager.browserTicket('b')
  let closingStatus
  const finalStatus = new Promise((resolve) =>
    ws.on('message', (raw) => {
      const status = JSON.parse(String(raw))
      if (status.status === 'closing') closingStatus = status
      if (status.status === 'closed') resolve(status)
    }),
  )
  await f.manager.close('b')
  assert.equal((await finalStatus).status, 'closed')
  assert.equal(closingStatus.status, 'closing')
  assert.equal(f.manager.tickets.has(pending.ticket), false)
  await f.manager.close('a')
})

test('malformed browser path is rejected without throwing from the HTTP upgrade handler', (t) => {
  const f = fixture(t)
  let response
  const socket = {
    end: (value) => {
      response = value
    },
  }
  assert.equal(f.manager.handleUpgrade({ url: '/api/panel/vms/%ZZ/browser?ticket=bad' }, socket, Buffer.alloc(0)), true)
  assert.match(response, /^HTTP\/1.1 400/)
  assert.equal(f.calls.launched.length, 0)
})

test('a failed close retains its live record and queue until an administrator retries successfully', async (t) => {
  let attempts = 0
  const f = fixture(t, {
    sessionOverrides: {
      async close() {
        if (++attempts === 1) throw new Error('exit not confirmed')
      },
    },
  })
  const live = await f.manager.acquire('a', { interactive: true })
  const next = f.manager.acquire('b')
  const ticket = f.manager.browserTicket('a')
  await assert.rejects(f.manager.close('a', { forget: true }), { code: 'browser_close_failed' })
  assert.equal(f.manager.state('a').status, 'close_failed')
  assert.equal(f.manager.state('a').active, true)
  assert.equal(f.manager.jobs.get('a'), live)
  assert.equal(f.manager.state('b').status, 'queued')
  assert.equal(f.calls.launched.length, 1)
  assert.equal(f.records.has('a'), true)
  assert.equal(f.manager.tickets.has(ticket.ticket), false)
  await assert.rejects(f.manager.acquire('a', { interactive: true }), { code: 'browser_close_failed' })
  assert.equal(f.manager.open('a').status, 'close_failed')
  await f.manager.close('a')
  assert.equal(attempts, 2)
  assert.equal(f.records.has('a'), false)
  assert.equal((await next).vmId, 'b')
})

test('session save failure remains a warning after resources close and the queue advances', async (t) => {
  let closes = 0
  const f = fixture(t, {
    sessionOverrides: {
      warning: '启动时有旧临时目录未回收。',
      async storageState() {
        throw new Error('database unavailable')
      },
      async close() {
        closes += 1
      },
    },
  })
  await f.manager.acquire('a', { interactive: true })
  const next = f.manager.acquire('b')
  const result = await f.manager.close('a')
  assert.equal(result.status, 'closed')
  assert.equal(result.active, false)
  assert.match(result.warning, /会话保存失败/)
  assert.match(result.warning, /旧临时目录/)
  assert.equal(closes, 1)
  assert.equal((await next).vmId, 'b')
})

test('concurrent close requests share one cleanup and persist the session once', async (t) => {
  let release
  let saves = 0
  let closes = 0
  const f = fixture(t, {
    sessionOverrides: {
      async storageState() {
        saves += 1
        return { cookies: [], origins: [] }
      },
      async close() {
        closes += 1
        await new Promise((resolve) => {
          release = resolve
        })
      },
    },
  })
  await f.manager.acquire('a', { interactive: true })
  const first = f.manager.close('a')
  const repeated = f.manager.close('a')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closes, 1)
  assert.equal(saves, 1)
  release()
  await Promise.all([first, repeated])
  assert.equal(f.manager.state('a').active, false)
})

test('closing stops input, screenshots and tickets before waiting for session persistence', async (t) => {
  let save
  let saves = 0
  let closes = 0
  const f = fixture(t, {
    sessionOverrides: {
      async storageState() {
        if (++saves === 1)
          await new Promise((resolve) => {
            save = resolve
          })
        return { cookies: [], origins: [] }
      },
      async close() {
        closes += 1
      },
    },
  })
  const live = await f.manager.acquire('a', { interactive: true })
  const next = f.manager.acquire('b')
  const ticket = f.manager.browserTicket('a')
  const closing = f.manager.close('a')
  assert.equal(f.manager.state('a').status, 'closing')
  assert.equal(live.inputLocked, true)
  assert.equal(live.stream.closed, true)
  assert.equal(live.stream.config.onInput({ type: 'continue' }), false)
  assert.equal(f.manager.tickets.has(ticket.ticket), false)
  assert.throws(() => f.manager.browserTicket('a'), { code: 'browser_closed' })
  assert.equal(live.closeSignal.aborted, false)
  assert.equal(f.calls.launched.length, 1)
  assert.equal(closes, 0)
  save()
  await closing
  assert.equal(closes, 1)
  assert.equal(f.manager.state('a').status, 'closed')
  assert.equal((await next).vmId, 'b')
})

test('an initialization cleanup failure retains its pending session for a later close retry', async (t) => {
  let attempts = 0
  let starts = 0
  const pendingSession = {
    close: async () => {
      attempts += 1
    },
  }
  const f = fixture(t, {
    async createSession() {
      starts += 1
      throw Object.assign(Error('initialization failed'), { pendingSession })
    },
  })
  await assert.rejects(f.manager.acquire('a'), { code: 'browser_close_failed' })
  assert.equal(f.manager.state('a').status, 'close_failed')
  assert.equal(starts, 1)
  assert.equal(f.manager.jobs.get('a').browser, pendingSession)
  assert.equal(attempts, 0)
  await f.manager.close('a')
  assert.equal(attempts, 1)
  assert.equal(f.manager.state('a').active, false)
})

test('shutdown continues closing queued sessions while reporting an active cleanup failure', async (t) => {
  let fail = true
  const f = fixture(t, {
    sessionOverrides: {
      close: async () => {
        if (fail) throw Error('exit failed')
      },
    },
  })
  await f.manager.acquire('a', { interactive: true })
  const queued = f.manager.acquire('b')
  const rejected = assert.rejects(queued, { code: 'browser_closed' })
  await assert.rejects(f.manager.stop(), { code: 'browser_close_failed' })
  await rejected
  assert.equal(f.manager.jobs.has('b'), false)
  assert.equal(f.manager.state('a').status, 'close_failed')
  fail = false
  await f.manager.close('a')
})
