import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createBrowserFixture } from './browser-fixture.mjs'
import { SlotBrowserManager } from '../src/lib/browser/slot-browser-manager.mjs'
import { CodexBrowserLoginService } from '../src/lib/oauth/codex-browser-login.mjs'

// Real production service and CDP callback interception, with local fake tokens.
// No account login, token endpoint, model request or callback HTTP listener.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm2api-oauth-smoke-'))
const vm = {
  id: 'oauth-smoke',
  proxy: { url: 'http://127.0.0.1:1' },
  codex: { email: 'oauth-fixture@example.invalid', chatgpt_account_id: 'fixture-account' },
}
const records = new Map()
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>Local authorization fixture</title><p>Local OAuth test only</p>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const manager = new SlotBrowserManager({
  cfg: { paths: { project: root } },
  getVm: (id) => (id === vm.id ? vm : null),
  resolveProxy: (current) => current.proxy.url,
  resolveTimezone: () => 'America/New_York',
  profileRepo: {
    get: (id) => records.get(id),
    upsert(id, patch) {
      records.set(id, { ...records.get(id), ...patch })
      return records.get(id)
    },
    remove: (id) => records.delete(id),
  },
  createSession: (options) => createBrowserFixture({ profileDir: options.profileDir }),
})
let issued = 0
let exchanged = 0
let committed = 0
let releaseExchange
const grants = new Map()
const tokens = (mismatch) => {
  const claims = {
    email: mismatch ? 'other@example.invalid' : vm.codex.email,
    'https://api.openai.com/auth': { chatgpt_account_id: mismatch ? 'other-account' : vm.codex.chatgpt_account_id },
  }
  const token = `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.not-a-signature`
  return { access_token: token, id_token: token, refresh_token: 'local-fixture-refresh', expires_at: '2030-01-01' }
}
const service = new CodexBrowserLoginService({
  browserManager: manager,
  getVm: (id) => (id === vm.id ? vm : null),
  generateAuthUrl() {
    const sessionId = `fixture-session-${++issued}`
    const state = `fixture-state-${issued}`
    grants.set(sessionId, state)
    const auth = new URL('/start', origin)
    auth.searchParams.set('authorize_url', `${origin}/authorize?state=${state}`)
    return { session_id: sessionId, auth_url: auth.href, expires_at: Date.now() + 60_000 }
  },
  async exchangeCode({ sessionId, code, proxyUrl }) {
    exchanged++
    const callback = new URL(code)
    assert.equal(callback.searchParams.get('state'), grants.get(sessionId))
    assert.equal(proxyUrl, vm.proxy.url)
    const fakeCode = callback.searchParams.get('code')
    if (fakeCode === 'valid')
      await new Promise((resolve) => {
        releaseExchange = resolve
      })
    return tokens(fakeCode === 'wrong-account')
  },
  async commitCredentials({ vmId }) {
    assert.equal(vmId, vm.id)
    committed++
    return { vm: { id: vmId }, platform: 'openai' }
  },
  cancelAuthSession: (sessionId) => grants.delete(sessionId),
})

async function until(predicate, label) {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`OAuth smoke timed out: ${label}`)
    await delay(10)
  }
}

async function begin() {
  service.start(vm.id)
  const job = service.jobs.get(vm.id)
  await until(() => manager.state(vm.id).status === 'oauth_waiting', 'authorization page')
  const live = manager.jobs.get(vm.id)
  assert.equal(await live.page.title(), 'Local authorization fixture')
  return { job, live, state: grants.get(job.sessionId) }
}

const callbackUrl = (state, code) => `http://localhost:1455/auth/callback?state=${state}&code=${code}`
try {
  let current = await begin()
  let response = await current.live.page.goto(callbackUrl('wrong-state', 'fake'), { waitUntil: 'load' })
  assert.equal(response.status(), 400)
  await current.job.promise
  assert.equal(manager.state(vm.id).error, 'state_mismatch')
  assert.equal(exchanged, 0)
  assert.equal(committed, 0)
  await manager.close(vm.id)

  current = await begin()
  response = await current.live.page.goto(callbackUrl(current.state, 'wrong-account'), { waitUntil: 'load' })
  assert.equal(response.status(), 400)
  await current.job.promise
  assert.equal(manager.state(vm.id).error, 'oauth_account_mismatch')
  assert.equal(committed, 0)
  await manager.close(vm.id)

  current = await begin()
  response = await current.live.page.goto(`${origin}/auth/callback?state=${current.state}&code=not-intercepted`)
  assert.equal(response.status(), 200)
  assert.equal(exchanged, 1, 'another origin cannot be accepted as the callback')
  const firstNavigation = current.live.page.goto(callbackUrl(current.state, 'valid')).catch((error) => error)
  await until(() => Boolean(releaseExchange), 'valid callback exchange')
  response = await current.live.page.goto(callbackUrl(current.state, 'duplicate'), { waitUntil: 'load' })
  assert.equal(response.status(), 409)
  releaseExchange()
  await current.job.promise
  await firstNavigation
  assert.equal(manager.state(vm.id).status, 'oauth_complete')
  assert.equal(exchanged, 2)
  assert.equal(committed, 1)
  assert.equal(records.get(vm.id).account_id, 'fixture-account')
  assert.ok(Array.isArray(records.get(vm.id).storage_state.cookies))
  await manager.close(vm.id)
  console.log(
    JSON.stringify({
      localOnly: true,
      productionOAuthService: true,
      badStateRejected: true,
      wrongAccountRejected: true,
      exactCallbackOrigin: true,
      duplicateExchangePrevented: true,
      commits: committed,
    }),
  )
} finally {
  releaseExchange?.()
  await service.stop()
  await manager.stop()
  await new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  })
  await fs.rm(root, { recursive: true, force: true })
}
