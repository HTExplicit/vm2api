import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { buildDashboard, buildVmList, buildVmDetail } from '../../src/lib/admin/panel-api.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

const ADMIN = { apiKeyKind: 'master' }
const VIEW = { has_key: true, enabled: true, balance: '37.00', claim_status: 'claimed', setup_status: 'ready' }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-openai-api-'))
  fs.mkdirSync(path.join(root, 'vms', 'vm-api'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-api.json'),
    JSON.stringify({ id: 'vm-api', platform: 'openai', family: 'codex', status: 'stopped', schedulable: false }),
  )
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function handler(root, { who = ADMIN, body = {}, manager = {}, credits = {}, ...extra } = {}) {
  const response = {}
  const call = createPanelHandler({
    cfg: { paths: { project: root } },
    routingConfig: {},
    ...extra,
    openaiApiManager: manager,
    openaiApiCredits: credits,
    requireAuth(req) {
      Object.assign(req, who)
      return true
    },
    json(_res, status, value) {
      Object.assign(response, { status, body: value })
      return true
    },
    readBody: async () => body,
  })
  return async (method, url) => {
    await call({ method, headers: {} }, {}, new URL(url, 'http://localhost'))
    return response
  }
}

test('account API routes use the administrator session and return direct public views', async (t) => {
  const root = fixture(t)
  const seen = []
  const manager = Object.fromEntries(
    ['view', 'setup', 'refresh', 'setEnabled', 'browserTicket'].map((name) => [
      name,
      (...args) => {
        seen.push([name, ...args])
        return name === 'browserTicket' ? { ticket: 'fixture-ticket', url: '/browser?ticket=fixture-ticket' } : VIEW
      },
    ]),
  )
  const credits = Object.fromEntries(
    ['preview', 'claim'].map((name) => [name, (...args) => (seen.push([name, ...args]), VIEW)]),
  )
  for (const [method, action, expected] of [
    ['GET', '', 'view'],
    ['POST', '/preview', 'preview'],
    ['POST', '/claim', 'claim'],
    ['POST', '/setup', 'setup'],
    ['POST', '/refresh', 'refresh'],
    ['PATCH', '/enabled', 'setEnabled'],
    ['POST', '/browser-ticket', 'browserTicket'],
  ]) {
    const out = await handler(root, { manager, credits, body: { enabled: false, destination_account_id: 'org-test' } })(
      method,
      `/api/panel/vms/vm-api/openai-api${action}`,
    )
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(seen.at(-1)[0], expected)
    assert.deepEqual(
      out.body.data,
      expected === 'browserTicket' ? { ticket: 'fixture-ticket', url: '/browser?ticket=fixture-ticket' } : VIEW,
    )
  }
  assert.deepEqual(
    seen.find(([name]) => name === 'claim'),
    ['claim', 'vm-api', { destination_account_id: 'org-test' }],
  )
  assert.deepEqual(
    seen.find(([name]) => name === 'setEnabled'),
    ['setEnabled', 'vm-api', false],
  )
})

test('account API operations deny tenants and read-only super users before running a task', async (t) => {
  const root = fixture(t)
  for (const role of ['user', 'super']) {
    for (const [method, action] of [
      ['GET', ''],
      ['POST', '/preview'],
      ['POST', '/claim'],
      ['POST', '/setup'],
      ['PATCH', '/enabled'],
      ['POST', '/browser-ticket'],
    ]) {
      const url = `/api/panel/vms/vm-api/openai-api${action}`
      assert.equal(authorizePanelRoute(method, url, role).ok, false)
      const out = await handler(root, {
        who: { panelUser: 'fixture', panelRole: role },
        manager: { view: () => assert.fail('unauthorized view') },
        credits: { preview: () => assert.fail('unauthorized preview') },
      })(method, url)
      assert.equal(out.status, 403)
    }
  }
})

test('account API routes retain typed failures and require a boolean independent switch', async (t) => {
  const root = fixture(t)
  const failed = await handler(root, {
    credits: {
      preview: () => {
        throw Object.assign(new Error('代理不可用'), { code: 'proxy_required', status: 409 })
      },
    },
  })('POST', '/api/panel/vms/vm-api/openai-api/preview')
  assert.equal(failed.status, 409)
  assert.deepEqual(failed.body.error, { code: 'proxy_required', message: '代理不可用' })
  const invalid = await handler(root, { body: { enabled: 'false' } })(
    'PATCH',
    '/api/panel/vms/vm-api/openai-api/enabled',
  )
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'invalid_enabled')
})

test('OpenAI(apikey) key creation enforces API category, ready accounts and administrator scope', async (t) => {
  const root = fixture(t)
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new ApiKeyStore({ db })
  const body = {
    name: 'account-api',
    category: 'oauth',
    group_type: 'openai_apikey',
    allowed_vms: ['vm-api'],
    vm_pool_id: 'pool_old',
  }
  const created = await handler(root, { body, apiKeyStore: store, manager: { view: () => VIEW } })(
    'POST',
    '/api/panel/api-keys',
  )
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.item.category, 'api')
  assert.equal(created.body.item.group_type, 'openai_apikey')
  assert.equal(created.body.item.vm_pool_id, null)
  assert.deepEqual(created.body.item.allowed_vms, ['vm-api'])
  const saved = store.getById(created.body.item.id)
  assert.equal(store.update(saved.id, { category: 'oauth' }).category, 'api')
  const notReady = await handler(root, { body, apiKeyStore: store, manager: { view: () => ({ has_key: false }) } })(
    'POST',
    '/api/panel/api-keys',
  )
  assert.equal(notReady.status, 400)
  assert.equal(notReady.body.error.code, 'key_api_account_not_ready')
  const denied = await handler(root, {
    who: { panelUser: 'tenant', panelRole: 'user' },
    body: { ...body, vm_pool_id: null },
    apiKeyStore: store,
  })('POST', '/api/panel/api-keys')
  assert.equal(denied.status, 403)
})

test('dashboard, list and detail carry API state even while the OAuth slot is stopped', async (t) => {
  const root = fixture(t)
  const args = {
    cfg: { paths: { project: root }, rewrite: {}, base_url: '' },
    routingConfig: {},
    accountQuota: { config: {}, snapshot: () => ({ accounts: [] }) },
    openaiApiManager: { view: () => VIEW },
  }
  const dashboard = await buildDashboard({ ...args, stickyRouter: { stats: () => ({}) }, stats: {} })
  const listed = await buildVmList(args)
  const detail = await buildVmDetail({ ...args, id: 'vm-api', slotProcessStatus: async () => ({}) })
  assert.deepEqual(dashboard.data.vms[0].openai_api, VIEW)
  assert.deepEqual(listed.data.items[0].openai_api, VIEW)
  assert.deepEqual(detail.data.vm.openai_api, VIEW)
  assert.equal(detail.data.vm.status, 'stopped')
  assert.equal(detail.data.vm.schedulable, false)
})

test('restore waits for account browsers to close and restarts the monitor after stores are rebound', async (t) => {
  const root = fixture(t)
  for (const failing of [false, true]) {
    const steps = []
    const manager = {
      async stop() {
        steps.push('closing')
        await Promise.resolve()
        steps.push('closed')
      },
      start() {
        steps.push('started')
      },
    }
    const backupService = {
      async restoreBackup(id) {
        assert.equal(id, 'backup-fixture')
        assert.deepEqual(steps, ['closing', 'closed'])
        steps.push('restoring')
        if (failing) throw Object.assign(new Error('fixture failed'), { code: 'backup_corrupt' })
        steps.push('rebound')
        return { ok: true }
      },
    }
    const out = await handler(root, { manager, backupService, body: { confirm: true } })(
      'POST',
      '/api/panel/backups/backup-fixture/restore',
    )
    assert.equal(out.status, failing ? 422 : 200)
    assert.deepEqual(
      steps,
      failing
        ? ['closing', 'closed', 'restoring', 'started']
        : ['closing', 'closed', 'restoring', 'rebound', 'started'],
    )
  }
})

test('both model-fetch routes use the account current proxy and ignore manual overrides', async (t) => {
  const root = fixture(t)
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new ApiEndpointStore({ db })
  const ep = store.create({ kind: 'openai' })
  const key = store.addKey(ep.id, {
    api_key: 'sk-account-fixture',
    source_vm_id: 'vm-api',
    source_account_id: 'account-api',
    proxy_url: 'socks5h://old-proxy:1080',
  })
  const seen = []
  let proxyUrl = 'socks5h://new-proxy:1080'
  const manager = {
    resolveAccountKey(input) {
      assert.equal(input.id, key.id)
      return proxyUrl ? { accountId: 'account-api', proxyUrl, enabled: false } : null
    },
  }
  const extra = {
    apiEndpointStore: store,
    apiScheduler: { reload() {} },
    manager,
    forwardApi: async (request) => {
      seen.push(request)
      return {
        statusCode: 200,
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ data: [{ id: 'gpt-5.4' }] }))
        },
      }
    },
  }
  for (const url of [`/api/panel/api-endpoints/${ep.id}/fetch-models`, '/api/panel/api-endpoints/fetch-models']) {
    const body = {
      key_id: key.id,
      api_key: 'sk-wrong-override',
      base_url: 'https://unrelated.example',
      kind: 'custom',
      protocol: 'anthropic',
      proxy_id: 'unrelated-proxy',
      proxy_url: 'socks5h://unrelated-proxy:1080',
      apply: false,
    }
    const out = await handler(root, { ...extra, body })('POST', url)
    assert.equal(out.status, 200, JSON.stringify(out.body))
    assert.equal(seen.at(-1).url, 'https://api.openai.com/v1/models')
    assert.equal(seen.at(-1).headers.authorization, 'Bearer sk-account-fixture')
    assert.equal(seen.at(-1).proxyUrl, proxyUrl)
    proxyUrl = ''
    const count = seen.length
    const missing = await handler(root, { ...extra, body })('POST', url)
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error.code, 'proxy_required')
    assert.equal(seen.length, count, 'missing binding must not forward a request')
    proxyUrl = 'socks5h://another-current-proxy:1080'
  }
})

test('generic endpoint edits cannot detach an account key from its identity or official upstream', async (t) => {
  const root = fixture(t)
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new ApiEndpointStore({ db })
  const ep = store.create({ kind: 'openai' })
  const key = store.addKey(ep.id, {
    api_key: 'sk-account-fixture',
    source_vm_id: 'vm-api',
    source_account_id: 'account-api',
  })
  const base = { apiEndpointStore: store, apiScheduler: { reload() {} } }
  for (const body of [
    { source_vm_id: '' },
    { source_account_id: 'other-account' },
    { proxy_url: '' },
    { proxy_id: 'px-other' },
    { api_key: 'sk-other' },
  ]) {
    const out = await handler(root, { ...base, body })('PATCH', `/api/panel/api-endpoints/${ep.id}/keys/${key.id}`)
    assert.equal(out.status, 400)
    assert.equal(out.body.error.code, 'account_api_key_managed')
  }
  for (const body of [{ kind: 'custom', base_url: 'https://unrelated.example' }, { kind: 'claude' }]) {
    const out = await handler(root, { ...base, body })('PATCH', `/api/panel/api-endpoints/${ep.id}`)
    assert.equal(out.status, 400)
    assert.equal(out.body.error.code, 'account_api_endpoint_managed')
  }
  const throughEndpoint = await handler(root, { ...base, body: { key_id: key.id, proxy_id: '' } })(
    'PATCH',
    `/api/panel/api-endpoints/${ep.id}`,
  )
  assert.equal(throughEndpoint.status, 400)
  assert.equal(throughEndpoint.body.error.code, 'account_api_key_managed')
  assert.equal(store.getKey(key.id).source_account_id, 'account-api')
  assert.equal(store.getKey(key.id).api_key, 'sk-account-fixture')
  assert.equal(store.getRaw(ep.id).kind, 'openai')
})


test('slot browser routes dispatch administrator login, immediate tickets and ordered close', async (t) => {
  const root = fixture(t)
  const steps = []
  const state = { vm_id: 'vm-api', status: 'queued', purpose: 'oauth' }
  const slotBrowserManager = {
    state(id) { steps.push(['state', id]); return state },
    browserTicket(id) {
      steps.push(['ticket', id])
      return { ticket: 'short-lived', url: '/api/panel/vms/vm-api/browser?ticket=short-lived' }
    },
    async close(id) { steps.push(['browser-close', id]) },
    acquire() { return new Promise(() => {}) },
  }
  const codexBrowserLogin = {
    start(id) { steps.push(['oauth-start', id]); return state },
    async cancel(id) { steps.push(['oauth-cancel', id]) },
  }
  const manager = {
    async cancel(...args) { steps.push(['api-cancel', ...args]) },
  }
  const ctx = { manager, slotBrowserManager, codexBrowserLogin }
  const viewed = await handler(root, ctx)('GET', '/api/panel/vms/vm-api/browser')
  assert.equal(viewed.status, 200)
  assert.deepEqual(viewed.body.data, state)
  steps.length = 0
  const opened = await handler(root, { ...ctx, body: { purpose: 'oauth' } })(
    'POST', '/api/panel/vms/vm-api/browser/open',
  )
  assert.equal(opened.status, 200)
  assert.deepEqual(opened.body.data, state)
  assert.deepEqual(steps, [
    ['api-cancel', 'vm-api', { closeBrowser: false }],
    ['oauth-start', 'vm-api'],
  ])
  steps.length = 0
  const ticket = await handler(root, ctx)('POST', '/api/panel/vms/vm-api/browser-ticket')
  assert.equal(ticket.status, 200)
  assert.equal(ticket.body.data.ticket, 'short-lived')
  assert.deepEqual(steps, [['ticket', 'vm-api']], 'ticket must not wait for browser acquisition')
  steps.length = 0
  const closed = await handler(root, ctx)('POST', '/api/panel/vms/vm-api/browser/close')
  assert.equal(closed.status, 200)
  assert.deepEqual(steps, [
    ['oauth-cancel', 'vm-api'], ['api-cancel', 'vm-api'],
    ['browser-close', 'vm-api'], ['state', 'vm-api'],
  ])
})

test('slot Platform browser cancels OAuth first and continues claimed account setup', async (t) => {
  const root = fixture(t)
  for (const claim_status of ['pending', 'claimed']) {
    const steps = []
    const state = { vm_id: 'vm-api', status: 'opening', purpose: 'platform' }
    const out = await handler(root, {
      body: { purpose: 'platform' },
      codexBrowserLogin: { async cancel(id) { steps.push(['oauth-cancel', id]) } },
      manager: {
        view(vm) { steps.push(['view', vm.id]); return { ...VIEW, claim_status } },
        setup(id) { steps.push(['setup', id]) },
      },
      slotBrowserManager: {
        state(id) { steps.push(['state', id]); return state },
        open() { assert.fail('claimed setup must not open a second browser flow') },
      },
    })('POST', '/api/panel/vms/vm-api/browser/open')
    assert.equal(out.status, 200)
    assert.deepEqual(out.body.data, state)
    assert.deepEqual(steps, [
      ['oauth-cancel', 'vm-api'], ['view', 'vm-api'], ['setup', 'vm-api'], ['state', 'vm-api'],
    ])
  }
})

test('unlinked slot opens Platform in the same retained browser without submitting a claim', async (t) => {
  const root = fixture(t)
  const steps = []
  const live = { page: { async goto(url, options) { steps.push(['goto', url, options.waitUntil]) } } }
  const out = await handler(root, {
    body: { purpose: 'platform' },
    codexBrowserLogin: { async cancel(id) { steps.push(['oauth-cancel', id]) } },
    manager: {
      view() { return { ...VIEW, claim_status: 'unknown' } },
      setup() { assert.fail('opening Platform must not claim or configure automatically') },
    },
    credits: { claim() { assert.fail('opening Platform must not claim') } },
    slotBrowserManager: {
      open(id, options) { steps.push(['open', id, options]) },
      async acquire(id, options) { steps.push(['acquire', id, options]); return live },
      state() { return { status: 'opening' } },
      setStatus(current, status) { assert.equal(current, live); steps.push(['status', status]) },
    },
  })('POST', '/api/panel/vms/vm-api/browser/open')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(out.status, 200)
  assert.deepEqual(steps, [
    ['oauth-cancel', 'vm-api'],
    ['open', 'vm-api', { purpose: 'platform', interactive: true }],
    ['acquire', 'vm-api', { purpose: 'platform', interactive: true, retain: true }],
    ['status', 'opening'], ['goto', 'https://platform.openai.com/', 'domcontentloaded'], ['status', 'ready'],
  ])
})

test('generic slot browser is admin-only and retains typed request failures', async (t) => {
  const root = fixture(t)
  for (const role of ['user', 'super']) {
    for (const [method, resource] of [
      ['GET', 'browser'], ['POST', 'browser-ticket'], ['POST', 'browser/open'], ['POST', 'browser/close'],
    ]) {
      const out = await handler(root, {
        who: { panelUser: 'fixture', panelRole: role },
        slotBrowserManager: new Proxy({}, { get() { assert.fail('unauthorized browser access') } }),
        codexBrowserLogin: new Proxy({}, { get() { assert.fail('unauthorized login access') } }),
      })(method, '/api/panel/vms/vm-api/' + resource)
      assert.equal(out.status, 403, role + ' ' + resource)
    }
  }
  const invalid = await handler(root, { body: { purpose: 'unrelated' } })(
    'POST', '/api/panel/vms/vm-api/browser/open',
  )
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'invalid_browser_purpose')
  const missing = await handler(root)('GET', '/api/panel/vms/missing/browser')
  assert.equal(missing.status, 404)
  const failed = await handler(root, {
    slotBrowserManager: {
      browserTicket() { throw Object.assign(new Error('浏览器已关闭'), { code: 'browser_closed', status: 409 }) },
    },
  })('POST', '/api/panel/vms/vm-api/browser-ticket')
  assert.equal(failed.status, 409)
  assert.deepEqual(failed.body.error, { code: 'browser_closed', message: '浏览器已关闭' })
})

test('new account API bindings require a positive exact balance while old depleted selections remain editable', async (t) => {
  const root = fixture(t)
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new ApiKeyStore({ db })
  const body = { name: 'funded', group_type: 'openai_apikey', allowed_vms: ['vm-api'] }
  for (const balance of ['0', '0.000', '-0.0001', null]) {
    const out = await handler(root, {
      body, apiKeyStore: store, manager: { view: () => ({ ...VIEW, balance }) },
    })('POST', '/api/panel/api-keys')
    assert.equal(out.status, 400)
    assert.equal(out.body.error.code, 'key_api_positive_balance_required')
  }
  const created = await handler(root, {
    body, apiKeyStore: store,
    manager: { view: () => ({ ...VIEW, enabled: false, balance: '0.00000000000000000000000000000000000000000001', balance_error: '需要登录' }) },
  })('POST', '/api/panel/api-keys')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const keyId = created.body.item.id
  const existing = await handler(root, {
    body: { ...body, quota_requests: 123 }, apiKeyStore: store,
    manager: { view: () => ({ ...VIEW, balance: '0' }) },
  })('PATCH', '/api/panel/api-keys/' + keyId)
  assert.equal(existing.status, 200, JSON.stringify(existing.body))
  assert.deepEqual(existing.body.item.allowed_vms, ['vm-api'])
  assert.equal(existing.body.item.quota_requests, 123)
  fs.writeFileSync(path.join(root, 'vms', 'vm-zero.json'), JSON.stringify({ id: 'vm-zero', platform: 'openai', family: 'codex' }))
  const added = await handler(root, {
    body: { group_type: 'openai_apikey', allowed_vms: ['vm-api', 'vm-zero'] }, apiKeyStore: store,
    manager: { view: () => ({ ...VIEW, balance: '0' }) },
  })('PATCH', '/api/panel/api-keys/' + keyId)
  assert.equal(added.status, 400)
  assert.equal(added.body.error.code, 'key_api_positive_balance_required')
  assert.deepEqual(JSON.parse(store.getById(keyId).allowed_vms), ['vm-api'])
})
