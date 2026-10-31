import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { buildDashboard, buildVmList, buildVmDetail } from '../../src/lib/admin/panel-api.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
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
