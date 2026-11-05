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
import { buildOpenaiApiKeyList } from '../../src/lib/admin/openai-apikey.mjs'

const ADMIN = { apiKeyKind: 'master' }
const VIEW = { has_key: true, enabled: true, balance: '37.00', claim_status: 'claimed', setup_status: 'ready' }

test('a manually bound unnamed proxy displays only its safe address fields', () => {
  const data = buildOpenaiApiKeyList(
    [
      {
        id: 'slot',
        proxy: { host: 'private.proxy', port: 1080, username: 'private-user', password: 'private-password' },
      },
    ],
    { view: () => ({ ...VIEW, account_id: 'account', email: 'account@example.test' }) },
  )
  assert.deepEqual(data.items[0].proxy, {
    id: null,
    name: 'private.proxy:1080',
    label: null,
    host: 'private.proxy',
    port: 1080,
    scheme: 'socks5',
    kind: 'socks5',
    available: true,
  })
  assert.equal(JSON.stringify(data).includes('private-user'), false)
  assert.equal(JSON.stringify(data).includes('private-password'), false)
})

test('proxy summaries use the current pool label and safe address after rename or label removal', () => {
  const raw = {
    id: 'px-a',
    label: '新出口',
    host: '2001:db8::1',
    port: 1080,
    username: 'private-user',
    password: 'private-password',
  }
  const proxyPool = {
    state: { proxies: [raw] },
    publicProxy: (proxy) => ({ ...proxy, url: 'socks5://private-user:private-password@private.proxy:1080' }),
  }
  const vms = [{ id: 'slot', proxy: { id: 'px-a', name: '旧出口', host: 'old.proxy', port: 1080 } }]
  const manager = { view: () => ({ ...VIEW, account_id: 'account' }) }
  const read = () => buildOpenaiApiKeyList(vms, manager, null, null, { proxyPool }).items[0].proxy
  assert.equal(read().name, '新出口')
  raw.label = '已改名'
  assert.equal(read().name, '已改名')
  raw.label = ''
  assert.deepEqual(read(), {
    id: 'px-a',
    name: '[2001:db8::1]:1080',
    label: null,
    host: '2001:db8::1',
    port: 1080,
    scheme: 'socks5',
    kind: 'socks5',
    available: true,
  })
  vms[0].proxy = { id: 'px-a' }
  assert.equal(read().name, '[2001:db8::1]:1080')
  assert.equal(read().available, true, 'an ID-only binding uses current pool address fields')
  assert.doesNotMatch(JSON.stringify(read()), /private-user|private-password|socks5:\/\//)
})

test('URL-only proxies expose host and port while local and missing bindings use established names', () => {
  const manager = { view: () => ({ ...VIEW, account_id: 'account' }) }
  const read = (vm, options) => buildOpenaiApiKeyList([vm], manager, null, null, options).items[0].proxy
  const urlProxy = read({ id: 'slot', proxy: { url: 'socks5h://private-user:private-password@proxy.example:1081' } })
  assert.equal(urlProxy.name, 'proxy.example:1081')
  assert.equal(urlProxy.host, 'proxy.example')
  assert.equal(urlProxy.port, 1081)
  assert.doesNotMatch(JSON.stringify(urlProxy), /private-user|private-password|socks5h:\/\//)
  assert.equal(read({ id: 'slot', proxy: { id: 'px-local', kind: 'local' } }).name, '当前VPS local代理')
  assert.equal(
    read(
      { id: 'slot', proxy: { id: 'px-local-node-a', kind: 'local' } },
      { nodes: [{ id: 'node-a', label: '美西节点' }] },
    ).name,
    '美西节点local代理',
  )
  const unnamedNode = read({ id: 'slot', proxy: { id: 'px-local-internal-node-id', kind: 'local' } })
  assert.equal(unnamedNode.name, '当前VPS local代理')
  assert.equal(unnamedNode.name.includes('internal-node-id'), false)
  const missing = read({ id: 'slot', proxy: { id: 'px-deleted' } })
  assert.equal(missing.name, '未绑定')
  assert.equal(missing.available, false)
  assert.equal(read({ id: 'slot' }).name, '未绑定')
})

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
    const headers = {}
    await call(
      { method, url, headers: {} },
      {
        setHeader(name, value) {
          headers[name.toLowerCase()] = value
        },
      },
      new URL(url, 'http://localhost'),
    )
    response.headers = headers
    return response
  }
}

test('OpenAi_api aggregates only current bound keys, eligible bind choices and safe proxy summaries', async (t) => {
  const root = fixture(t)
  for (const [id, name] of [
    ['vm-bind', '待绑定'],
    ['vm-free', '未领取'],
  ]) {
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({ id, name, platform: 'openai', family: 'codex' }),
    )
  }
  const vmPath = path.join(root, 'vms', 'vm-api.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-api',
      name: '主账号',
      platform: 'openai',
      family: 'codex',
      proxy: { id: 'px-a', name: '账号出口', host: 'private.proxy', port: 1080, password: 'private-password' },
    }),
  )
  const out = await handler(root, {
    proxyPool: {
      state: { proxies: [{ id: 'px-a', label: '代理池最新名', host: 'current.proxy', port: 1081 }] },
      publicProxy: (proxy) => ({ ...proxy }),
    },
    manager: {
      view(vm) {
        return {
          ...VIEW,
          account_id: `account-${vm.id}`,
          email: `${vm.id}@example.test`,
          has_key: vm.id === 'vm-api',
          claim_status: vm.id === 'vm-free' ? 'unknown' : 'claimed',
          call_status: 'ready',
          key_suffix: 'abcd',
        }
      },
    },
    requestLog: {
      repo: {
        accountApiUsage(ids, now, timezone) {
          assert.deepEqual(ids, ['account-vm-api'])
          assert.equal(timezone, 'Asia/Singapore')
          assert.equal(typeof now, 'number')
          return new Map([
            [
              'account-vm-api',
              { today_requests: 2, today_cost: 0.01, last_used_at: '2026-11-03T12:00:00Z', unpriced_requests: 0 },
            ],
          ])
        },
      },
    },
  })('GET', '/api/panel/openai-apikey?timezone=Asia%2FSingapore')
  assert.equal(out.status, 200)
  assert.equal(out.body.data.items.length, 1)
  assert.equal(out.body.data.items[0].slot_name, '主账号')
  assert.equal(out.body.data.items[0].today_requests, 2)
  assert.deepEqual(out.body.data.items[0].proxy, {
    id: 'px-a',
    name: '代理池最新名',
    label: '代理池最新名',
    host: 'current.proxy',
    port: 1081,
    scheme: 'socks5',
    kind: 'socks5',
    available: true,
  })
  assert.deepEqual(
    out.body.data.bind_candidates.map((item) => item.vm_id),
    ['vm-bind'],
  )
  assert.equal(JSON.stringify(out.body).includes('private.proxy'), false)
  assert.equal(JSON.stringify(out.body).includes('private-password'), false)
  assert.equal(JSON.stringify(out.body).includes('api_key'), false)
})

test('dedicated key endpoints require account identity and reveal only on demand with no-store', async (t) => {
  const root = fixture(t)
  const seen = []
  const manager = {
    revealKey(id, input) {
      seen.push(['reveal', id, input])
      return { api_key: 'sk-secret-fixture' }
    },
    bindKey(id, input) {
      seen.push(['bind', id, input])
      return VIEW
    },
    removeKey(id, input) {
      seen.push(['remove', id, input])
      return { ...VIEW, has_key: false }
    },
  }
  const reveal = await handler(root, { manager })('GET', '/api/panel/vms/vm-api/openai-api/key?account_id=account-a')
  assert.equal(reveal.status, 200)
  assert.equal(reveal.headers['cache-control'], 'no-store')
  assert.deepEqual(reveal.body.data, { api_key: 'sk-secret-fixture' })
  const missing = await handler(root, { manager })('GET', '/api/panel/vms/vm-api/openai-api/key')
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'account_identity_required')
  for (const [method, name] of [
    ['PUT', 'bind'],
    ['DELETE', 'remove'],
  ]) {
    const out = await handler(root, { manager, body: { account_id: 'account-a', api_key: 'sk-new' } })(
      method,
      '/api/panel/vms/vm-api/openai-api/key',
    )
    assert.equal(out.status, 200)
    assert.deepEqual(seen.at(-1), [name, 'vm-api', { account_id: 'account-a', api_key: 'sk-new' }])
  }
})

test('dedicated console and key APIs deny non-administrators before reading records', async (t) => {
  const root = fixture(t)
  for (const role of ['user', 'super']) {
    for (const [method, url] of [
      ['GET', '/api/panel/openai-apikey'],
      ['POST', '/api/panel/openai-apikey/batch'],
      ['GET', '/api/panel/vms/vm-api/openai-api/key?account_id=account-a'],
      ['PUT', '/api/panel/vms/vm-api/openai-api/key'],
      ['DELETE', '/api/panel/vms/vm-api/openai-api/key'],
    ]) {
      const out = await handler(root, {
        who: { panelUser: 'fixture', panelRole: role },
        manager: {
          view() {
            assert.fail('unauthorized read')
          },
        },
      })(method, url)
      assert.equal(out.status, 403, `${role} ${method} ${url}`)
    }
  }
})

test('batch operations preserve partial results, verify identity and deduplicate organization refreshes', async (t) => {
  const root = fixture(t)
  const seen = []
  const manager = {
    jobs: new Map(),
    assertAccountIdentity(vmId, accountId) {
      seen.push(['identity', vmId, accountId])
      if (accountId === 'old-account')
        throw Object.assign(new Error('槽位账号已改变'), { code: 'api_account_changed', status: 409 })
      return { vm: { id: vmId }, record: { organization_id: 'org-shared' } }
    },
    refresh(vmId) {
      seen.push(['refresh', vmId])
      this.jobs.set(vmId, {})
      return VIEW
    },
    view() {
      return VIEW
    },
    setEnabled(vmId, enabled, options) {
      seen.push(['enabled', vmId, enabled, options])
      return VIEW
    },
    resume(vmId, options) {
      seen.push(['resume', vmId, options])
      return VIEW
    },
    removeKey(vmId, options) {
      seen.push(['remove', vmId, options])
      return { ...VIEW, has_key: false }
    },
  }
  const selected = [
    { vm_id: 'vm-api', account_id: 'account-a' },
    { vm_id: 'vm-other', account_id: 'account-b' },
    { vm_id: 'vm-old', account_id: 'old-account' },
  ]
  const refreshed = await handler(root, { manager, body: { action: 'refresh_balance', items: selected } })(
    'POST',
    '/api/panel/openai-apikey/batch',
  )
  assert.equal(refreshed.status, 200)
  assert.deepEqual(
    refreshed.body.data.results.map((item) => item.status),
    ['queued', 'queued', 'error'],
  )
  assert.equal(refreshed.body.data.results[2].error.code, 'api_account_changed')
  assert.equal(seen.filter(([name]) => name === 'refresh').length, 1)
  for (const [action, expected] of [
    ['enable', 'enabled'],
    ['disable', 'enabled'],
    ['resume', 'resume'],
    ['delete', 'remove'],
  ]) {
    const out = await handler(root, { manager, body: { action, items: selected.slice(0, 1) } })(
      'POST',
      '/api/panel/openai-apikey/batch',
    )
    assert.equal(out.body.data.results[0].status, 'done')
    assert.equal(seen.at(-1)[0], expected)
  }
})

test('identity-bearing switches and refreshes reject stale account selections', async (t) => {
  const root = fixture(t)
  const mismatch = () => {
    throw Object.assign(new Error('槽位账号已改变'), { code: 'api_account_changed', status: 409 })
  }
  for (const [method, action, manager] of [
    ['PATCH', 'enabled', { setEnabled: mismatch }],
    ['POST', 'resume', { resume: mismatch }],
    [
      'POST',
      'refresh',
      {
        assertAccountIdentity: mismatch,
        refresh() {
          assert.fail('stale refresh')
        },
      },
    ],
  ]) {
    const out = await handler(root, { manager, body: { enabled: false, account_id: 'old-account' } })(
      method,
      `/api/panel/vms/vm-api/openai-api/${action}`,
    )
    assert.equal(out.status, 409)
    assert.equal(out.body.error.code, 'api_account_changed')
  }
})

test('account API routes use the administrator session and return direct public views', async (t) => {
  const root = fixture(t)
  const seen = []
  const manager = Object.fromEntries(
    ['view', 'setup', 'refresh', 'resume', 'setEnabled', 'browserTicket'].map((name) => [
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
    ['POST', '/resume', 'resume'],
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
      ['POST', '/resume'],
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

test('generic model-fetch routes cannot use managed account keys or bypass their shared catalog', async (t) => {
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
  const manager = {
    resolveAccountKey() {
      assert.fail('managed model fetch must not resolve an account key')
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
    assert.equal(out.status, 400, JSON.stringify(out.body))
    assert.equal(out.body.error.code, 'account_api_key_managed')
    assert.equal(seen.length, 0, 'managed keys must not use the old model-fetch paths')
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

test('generic endpoint management hides managed keys and cannot delete or mutate their resources', async (t) => {
  const root = fixture(t)
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new ApiEndpointStore({ db })
  const pure = store.create({ kind: 'openai', name: 'managed-only' })
  const pureKey = store.addKey(pure.id, {
    api_key: 'sk-managed-only',
    source_vm_id: 'vm-api',
    source_account_id: 'account-a',
  })
  const mixed = store.create({ kind: 'openai', name: 'mixed' })
  const mixedKey = store.addKey(mixed.id, {
    api_key: 'sk-managed-mixed',
    source_vm_id: 'vm-other',
    source_account_id: 'account-b',
  })
  const ordinary = store.addKey(mixed.id, { api_key: 'sk-ordinary' })
  const extra = { apiEndpointStore: store, apiScheduler: { reload() {} } }
  const listed = await handler(root, extra)('GET', '/api/panel/api-endpoints')
  assert.deepEqual(
    listed.body.items.map((ep) => ep.id),
    [mixed.id],
  )
  assert.deepEqual(
    listed.body.items[0].api_key_entries.map((key) => key.id),
    [ordinary.id],
  )
  assert.equal(store.listRaw().length, 2, 'runtime still sees managed endpoints')
  for (const [method, url, body] of [
    ['DELETE', `/api/panel/api-endpoints/${pure.id}`, {}],
    ['DELETE', `/api/panel/api-endpoints/${mixed.id}`, {}],
    ['DELETE', `/api/panel/api-endpoints/${pure.id}/keys/${pureKey.id}`, {}],
    ['PATCH', `/api/panel/api-endpoints/${pure.id}/keys/${pureKey.id}`, { disabled: true }],
    ['POST', `/api/panel/api-endpoints/${pure.id}/keys`, { api_key: 'sk-extra' }],
    ['PATCH', `/api/panel/api-endpoints/${mixed.id}`, { disabled: true }],
  ]) {
    const out = await handler(root, { ...extra, body })(method, url)
    assert.equal(out.status, 400, `${method} ${url}`)
    assert.match(out.body.error.code, /^account_api_(?:key|endpoint)_managed$/)
  }
  const changed = await handler(root, { ...extra, body: { api_key: 'sk-ordinary-replaced' } })(
    'PATCH',
    `/api/panel/api-endpoints/${mixed.id}/keys/${ordinary.id}`,
  )
  assert.equal(changed.status, 200)
  assert.equal(store.getKey(ordinary.id).api_key, 'sk-ordinary-replaced')
  const added = await handler(root, { ...extra, body: { api_key: 'sk-new-ordinary' } })(
    'POST',
    `/api/panel/api-endpoints/${mixed.id}/keys`,
  )
  assert.equal(added.status, 201)
  assert.equal(JSON.stringify(added.body).includes('managed-mixed'), false)
  const deleted = await handler(root, extra)('DELETE', `/api/panel/api-endpoints/${mixed.id}/keys/${ordinary.id}`)
  assert.equal(deleted.status, 200)
  assert.ok(store.getKey(mixedKey.id))
  assert.ok(store.getKey(pureKey.id))
})

test('slot browser routes dispatch administrator login, immediate tickets and ordered close', async (t) => {
  const root = fixture(t)
  const steps = []
  const state = { vm_id: 'vm-api', status: 'queued', purpose: 'oauth' }
  const slotBrowserManager = {
    state(id) {
      steps.push(['state', id])
      return state
    },
    browserTicket(id) {
      steps.push(['ticket', id])
      return { ticket: 'short-lived', url: '/api/panel/vms/vm-api/browser?ticket=short-lived' }
    },
    async close(id) {
      steps.push(['browser-close', id])
    },
    acquire() {
      return new Promise(() => {})
    },
  }
  const codexBrowserLogin = {
    start(id) {
      steps.push(['oauth-start', id])
      return state
    },
    async cancel(id) {
      steps.push(['oauth-cancel', id])
    },
  }
  const manager = {
    async cancel(...args) {
      steps.push(['api-cancel', ...args])
    },
  }
  const ctx = { manager, slotBrowserManager, codexBrowserLogin }
  const viewed = await handler(root, ctx)('GET', '/api/panel/vms/vm-api/browser')
  assert.equal(viewed.status, 200)
  assert.deepEqual(viewed.body.data, state)
  steps.length = 0
  const opened = await handler(root, { ...ctx, body: { purpose: 'oauth' } })(
    'POST',
    '/api/panel/vms/vm-api/browser/open',
  )
  assert.equal(opened.status, 200)
  assert.deepEqual(opened.body.data, state)
  assert.deepEqual(steps, [
    ['state', 'vm-api'],
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
    ['oauth-cancel', 'vm-api'],
    ['api-cancel', 'vm-api'],
    ['browser-close', 'vm-api'],
    ['state', 'vm-api'],
  ])
})

test('slot Platform browser cancels OAuth first and continues claimed account setup', async (t) => {
  const root = fixture(t)
  for (const claim_status of ['pending', 'claimed']) {
    const steps = []
    const state = { vm_id: 'vm-api', status: 'opening', purpose: 'platform' }
    const out = await handler(root, {
      body: { purpose: 'platform' },
      codexBrowserLogin: {
        async cancel(id) {
          steps.push(['oauth-cancel', id])
        },
      },
      manager: {
        view(vm) {
          steps.push(['view', vm.id])
          return { ...VIEW, claim_status }
        },
        setup(id) {
          steps.push(['setup', id])
        },
      },
      slotBrowserManager: {
        state(id) {
          steps.push(['state', id])
          return state
        },
        open() {
          assert.fail('claimed setup must not open a second browser flow')
        },
      },
    })('POST', '/api/panel/vms/vm-api/browser/open')
    assert.equal(out.status, 200)
    assert.deepEqual(out.body.data, state)
    assert.deepEqual(steps, [
      ['state', 'vm-api'],
      ['oauth-cancel', 'vm-api'],
      ['view', 'vm-api'],
      ['setup', 'vm-api'],
      ['state', 'vm-api'],
    ])
  }
})

test('browser open preserves failed close ownership and close returns failures or saved warnings', async (t) => {
  const root = fixture(t)
  for (const status of ['closing', 'close_failed']) {
    const state = { vm_id: 'vm-api', active: true, status, message: '浏览器清理尚未完成' }
    for (const purpose of ['oauth', 'platform']) {
      const out = await handler(root, {
        body: { purpose },
        slotBrowserManager: { state: () => state },
        manager: {
          cancel() {
            assert.fail('cannot cancel or start a second browser flow')
          },
        },
        codexBrowserLogin: {
          start() {
            assert.fail('cannot start OAuth before cleanup')
          },
        },
      })('POST', '/api/panel/vms/vm-api/browser/open')
      assert.equal(out.status, 200)
      assert.deepEqual(out.body.data, state)
    }
  }
  const failed = await handler(root, {
    codexBrowserLogin: { async cancel() {} },
    manager: { async cancel() {} },
    slotBrowserManager: {
      async close() {
        throw Object.assign(new Error('浏览器临时文件清理失败'), { code: 'browser_temp_cleanup_failed', status: 502 })
      },
      state() {
        assert.fail('close failure must not return a successful closed view')
      },
    },
  })('POST', '/api/panel/vms/vm-api/browser/close')
  assert.equal(failed.status, 502)
  assert.equal(failed.body.error.code, 'browser_temp_cleanup_failed')
  const closed = { vm_id: 'vm-api', active: false, status: 'closed', warning: '已关闭，但会话保存失败' }
  const warned = await handler(root, {
    codexBrowserLogin: { async cancel() {} },
    manager: { async cancel() {} },
    slotBrowserManager: { async close() {}, state: () => closed },
  })('POST', '/api/panel/vms/vm-api/browser/close')
  assert.equal(warned.status, 200)
  assert.deepEqual(warned.body.data, closed)
})

test('deleting a slot stops before identity and key cleanup when browser close fails', async (t) => {
  const root = fixture(t)
  const steps = []
  const out = await handler(root, {
    codexBrowserLogin: {
      async cancel() {
        steps.push('cancel-oauth')
      },
    },
    manager: {
      async cancel() {
        steps.push('cancel-api')
      },
    },
    slotBrowserManager: {
      async close() {
        throw Object.assign(new Error('浏览器尚未退出'), { code: 'browser_close_failed' })
      },
    },
    openaiApiRepo: {
      cleanupForVm() {
        assert.fail('account key must remain bound')
      },
    },
    slotBrowserRepo: {
      remove() {
        assert.fail('fingerprint and session must remain')
      },
    },
  })('DELETE', '/api/panel/vms/vm-api')
  assert.equal(out.status, 500)
  assert.equal(out.body.error.code, 'browser_close_failed')
  assert.deepEqual(steps, ['cancel-oauth', 'cancel-api'])
  assert.ok(fs.existsSync(path.join(root, 'vms', 'vm-api.json')))
  assert.ok(fs.existsSync(path.join(root, 'vms', 'vm-api')))
})

test('unlinked slot opens Platform in the same retained browser without submitting a claim', async (t) => {
  const root = fixture(t)
  const steps = []
  const live = {
    page: {
      async goto(url, options) {
        steps.push(['goto', url, options.waitUntil])
      },
    },
  }
  const out = await handler(root, {
    body: { purpose: 'platform' },
    codexBrowserLogin: {
      async cancel(id) {
        steps.push(['oauth-cancel', id])
      },
    },
    manager: {
      view() {
        return { ...VIEW, claim_status: 'unknown' }
      },
      setup() {
        assert.fail('opening Platform must not claim or configure automatically')
      },
    },
    credits: {
      claim() {
        assert.fail('opening Platform must not claim')
      },
    },
    slotBrowserManager: {
      open(id, options) {
        steps.push(['open', id, options])
      },
      async acquire(id, options) {
        steps.push(['acquire', id, options])
        return live
      },
      state() {
        return { status: 'opening' }
      },
      setStatus(current, status) {
        assert.equal(current, live)
        steps.push(['status', status])
      },
    },
  })('POST', '/api/panel/vms/vm-api/browser/open')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(out.status, 200)
  assert.deepEqual(steps, [
    ['oauth-cancel', 'vm-api'],
    ['open', 'vm-api', { purpose: 'platform', interactive: true }],
    ['acquire', 'vm-api', { purpose: 'platform', interactive: true, retain: true }],
    ['status', 'opening'],
    ['goto', 'https://platform.openai.com/', 'domcontentloaded'],
    ['status', 'ready'],
  ])
})

test('generic slot browser is admin-only and retains typed request failures', async (t) => {
  const root = fixture(t)
  for (const role of ['user', 'super']) {
    for (const [method, resource] of [
      ['GET', 'browser'],
      ['POST', 'browser-ticket'],
      ['POST', 'browser/open'],
      ['POST', 'browser/close'],
    ]) {
      const out = await handler(root, {
        who: { panelUser: 'fixture', panelRole: role },
        slotBrowserManager: new Proxy(
          {},
          {
            get() {
              assert.fail('unauthorized browser access')
            },
          },
        ),
        codexBrowserLogin: new Proxy(
          {},
          {
            get() {
              assert.fail('unauthorized login access')
            },
          },
        ),
      })(method, '/api/panel/vms/vm-api/' + resource)
      assert.equal(out.status, 403, role + ' ' + resource)
    }
  }
  const invalid = await handler(root, { body: { purpose: 'unrelated' } })('POST', '/api/panel/vms/vm-api/browser/open')
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'invalid_browser_purpose')
  const missing = await handler(root)('GET', '/api/panel/vms/missing/browser')
  assert.equal(missing.status, 404)
  const failed = await handler(root, {
    slotBrowserManager: {
      browserTicket() {
        throw Object.assign(new Error('浏览器已关闭'), { code: 'browser_closed', status: 409 })
      },
    },
  })('POST', '/api/panel/vms/vm-api/browser-ticket')
  assert.equal(failed.status, 409)
  assert.deepEqual(failed.body.error, { code: 'browser_closed', message: '浏览器已关闭' })
})

test('new and existing account API bindings accept zero, negative and unknown balances when a key exists', async (t) => {
  const root = fixture(t)
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new ApiKeyStore({ db })
  const body = { name: 'funded', group_type: 'openai_apikey', allowed_vms: ['vm-api'] }
  for (const balance of ['0', '0.000', '-0.0001', null]) {
    const out = await handler(root, {
      body,
      apiKeyStore: store,
      manager: { view: () => ({ ...VIEW, balance }) },
    })('POST', '/api/panel/api-keys')
    assert.equal(out.status, 201, JSON.stringify(out.body))
  }
  const created = await handler(root, {
    body,
    apiKeyStore: store,
    manager: {
      view: () => ({
        ...VIEW,
        enabled: false,
        balance: '0.00000000000000000000000000000000000000000001',
        balance_error: '需要登录',
      }),
    },
  })('POST', '/api/panel/api-keys')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const keyId = created.body.item.id
  const existing = await handler(root, {
    body: { ...body, quota_requests: 123 },
    apiKeyStore: store,
    manager: { view: () => ({ ...VIEW, balance: '0' }) },
  })('PATCH', '/api/panel/api-keys/' + keyId)
  assert.equal(existing.status, 200, JSON.stringify(existing.body))
  assert.deepEqual(existing.body.item.allowed_vms, ['vm-api'])
  assert.equal(existing.body.item.quota_requests, 123)
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-zero.json'),
    JSON.stringify({ id: 'vm-zero', platform: 'openai', family: 'codex' }),
  )
  const added = await handler(root, {
    body: { group_type: 'openai_apikey', allowed_vms: ['vm-api', 'vm-zero'] },
    apiKeyStore: store,
    manager: { view: () => ({ ...VIEW, balance: '0' }) },
  })('PATCH', '/api/panel/api-keys/' + keyId)
  assert.equal(added.status, 200, JSON.stringify(added.body))
  assert.deepEqual(JSON.parse(store.getById(keyId).allowed_vms), ['vm-api', 'vm-zero'])
})

test('Billing refresh does not cancel an administrator OAuth browser and resume dispatches only its own operation', async (t) => {
  const root = fixture(t)
  const seen = []
  const manager = {
    refresh(id) {
      seen.push(['refresh', id])
      return VIEW
    },
    resume(id) {
      seen.push(['resume', id])
      return { ...VIEW, enabled: false, quota_blocked: false }
    },
  }
  const extra = {
    codexBrowserLogin: {
      cancel() {
        assert.fail('Billing must not cancel an administrator login')
      },
    },
  }
  assert.equal(
    (await handler(root, { manager, ...extra })('POST', '/api/panel/vms/vm-api/openai-api/refresh')).status,
    200,
  )
  const resumed = await handler(root, { manager, ...extra })('POST', '/api/panel/vms/vm-api/openai-api/resume')
  assert.equal(resumed.status, 200)
  assert.equal(resumed.body.data.enabled, false)
  assert.deepEqual(seen, [
    ['refresh', 'vm-api'],
    ['resume', 'vm-api'],
  ])
})

test('routing returns the default Billing interval and rejects invalid interval before persistence', async (t) => {
  const root = fixture(t)
  const cfg = { paths: { project: root }, limits: { max_body_bytes: 1024 * 1024 } }
  const initial = await handler(root, { cfg, stickyRouter: { stats: () => ({}) } })('GET', '/api/panel/routing')
  assert.equal(initial.status, 200)
  assert.equal(initial.body.data.openai_api.balance_refresh_interval_minutes, 10)
  for (const value of [-1, 1.5, 1441, '10']) {
    const out = await handler(root, {
      cfg,
      body: { openai_api: { balance_refresh_interval_minutes: value } },
      persistRoutingPatch() {
        assert.fail('invalid interval cannot be persisted')
      },
    })('PUT', '/api/panel/routing')
    assert.equal(out.status, 400)
    assert.equal(out.body.error.code, 'invalid_openai_api_config')
  }
})
