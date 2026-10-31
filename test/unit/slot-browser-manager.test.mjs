import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import { WebSocket } from 'ws'
import { SlotBrowserManager } from '../../src/lib/browser/slot-browser-manager.mjs'

function fixture(t, options = {}) {
  const records = new Map()
  const vms = new Map(
    ['a', 'b', 'c'].map((id) => [id, { id, proxy: { url: `socks5h://127.0.0.1:${id === 'a' ? 1080 : 1081}` } }]),
  )
  const calls = { launched: [], closed: [], saved: [], routes: [] }
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
    close() {
      for (const ws of this.clients) ws.close()
    }
  }
  const manager = new SlotBrowserManager({
    cfg: { paths: { project: '/test' } },
    profileRepo: repo,
    getVm: (id) => vms.get(id),
    resolveProxy: (vm) => vm.proxy?.url,
    Stream,
    async createSession(options) {
      calls.launched.push(options)
      if (options.signal?.aborted) throw Error('closed')
      await options.onFingerprint(options.fingerprint || { unique: calls.launched.length })
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
      }
    },
    ...options,
  })
  t.after(() => manager.stop())
  return { manager, vms, records, repo, calls }
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
  assert.deepEqual(f.calls.launched[1].fingerprint, { unique: 1 })
  assert.deepEqual(f.calls.launched[1].storageState, f.records.get('a').storage_state)
  await f.manager.release(restored)
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
  assert.deepEqual(f.calls.launched[1].fingerprint, { unique: 1 })
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
  const finalStatus = once(ws, 'message')
  await f.manager.close('b')
  assert.equal(JSON.parse(String((await finalStatus)[0])).status, 'closed')
  assert.equal(f.manager.tickets.has(pending.ticket), false)
  await f.manager.close('a')
})
