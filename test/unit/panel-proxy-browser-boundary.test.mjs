import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'

function fixture(t, { failClose = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-browser-boundary-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const db = createDatabase({ dbPath: ':memory:' })
  const pool = new ProxyPool({ db })
  pool.stopScheduler()
  pool.updateConfig({ follow_proxy_timezone: false })
  pool.importLines('1.2.3.4:1080\n5.6.7.8:1080')
  const [first, second] = pool.state.proxies
  pool.bind(first.id, 'vm-a')
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-a.json'),
    JSON.stringify({ id: 'vm-a', status: 'stopped', proxy: pool.getProxyForVm('vm-a') }),
  )
  const events = []
  const busy = new Set()
  let active = true
  const browser = {
    async withProxyChange(ids, action) {
      for (const id of ids) busy.add(id)
      try {
        return await action()
      } finally {
        for (const id of ids) busy.delete(id)
      }
    },
    async close(id) {
      assert.equal(busy.has(id), true, 'new opens are excluded before closing begins')
      events.push(`close:${id}`)
      if (failClose) throw Object.assign(new Error('synthetic close failure'), { code: 'browser_close_failed' })
      await Promise.resolve()
      active = false
    },
  }
  const originalUpdate = pool.update.bind(pool)
  pool.update = (id, patch, options) => {
    if (!options?.dryRun && ['host', 'port', 'username', 'password'].some((key) => Object.hasOwn(patch, key))) {
      const candidate = originalUpdate(id, patch, { dryRun: true })
      if (candidate.ok && candidate.connection_changed) {
        assert.equal(active, false, 'connection cannot change before actual close')
        assert.equal(busy.has('vm-a'), true, 'the slot remains excluded while applying connection')
        events.push('apply')
      }
    }
    return originalUpdate(id, patch, options)
  }
  const previousMock = process.env.KIN_CRS_MOCK
  process.env.KIN_CRS_MOCK = '1'
  t.after(() => {
    if (previousMock === undefined) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = previousMock
    pool.stopScheduler()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const handler = createPanelHandler({
    cfg: { paths: { project: root } },
    routingConfig: {},
    proxyPool: pool,
    slotBrowserManager: browser,
    codexBrowserLogin: {
      async cancel(id) {
        events.push(`oauth:${id}`)
      },
    },
    openaiApiManager: {
      async cancel(id) {
        events.push(`platform:${id}`)
      },
    },
    readBody: async (req) => req.body,
    requireAuth(req) {
      req.apiKeyKind = 'master'
      return true
    },
    json(res, status, payload) {
      Object.assign(res.response, { status, body: payload })
      res.headersSent = true
      return true
    },
  })
  async function call(method, url, body = {}) {
    const response = {}
    const res = { headersSent: false, response, setHeader() {} }
    await handler({ method, headers: {}, body }, res, new URL(url, 'http://localhost'))
    return response
  }
  return { root, pool, first, second, call, events, busy, browser }
}

test('connection edit cancels both businesses and closes before applying pool and VM proxy', async (t) => {
  const f = fixture(t)
  const result = await f.call('PUT', `/api/panel/proxies/${f.first.id}`, { port: 1081 })
  assert.equal(result.status, 200)
  assert.deepEqual(f.events, ['oauth:vm-a', 'platform:vm-a', 'close:vm-a', 'apply'])
  assert.equal(f.first.port, 1081)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'vms/vm-a.json'))).proxy.port, 1081)
  assert.equal(f.busy.size, 0)
})

test('label, identical connection, and invalid edits leave the browser alone', async (t) => {
  const f = fixture(t)
  assert.equal((await f.call('PUT', `/api/panel/proxies/${f.first.id}`, { label: 'renamed' })).status, 200)
  assert.equal((await f.call('PUT', `/api/panel/proxies/${f.first.id}`, { port: 1080 })).status, 200)
  assert.equal((await f.call('PUT', `/api/panel/proxies/${f.first.id}`, { port: -1 })).status, 400)
  assert.equal((await f.call('PUT', '/api/panel/proxies/missing', { port: 1081 })).status, 404)
  assert.deepEqual(f.events, [])
})

for (const action of ['edit', 'bind', 'unbind', 'remove', 'disable', 'import']) {
  test(`${action} refuses mutation while the browser cannot exit`, async (t) => {
    const f = fixture(t, { failClose: true })
    const routes = {
      edit: ['PUT', `/api/panel/proxies/${f.first.id}`, { host: 'new.proxy.test' }],
      bind: ['POST', `/api/panel/proxies/${f.second.id}/bind`, { vm_id: 'vm-a' }],
      unbind: ['POST', `/api/panel/proxies/${f.first.id}/unbind`, { vm_id: 'vm-a' }],
      remove: ['DELETE', `/api/panel/proxies/${f.first.id}`, {}],
      disable: ['POST', `/api/panel/proxies/${f.first.id}/disable`, {}],
      import: ['POST', '/api/panel/proxies/import', { text: '9.8.7.6:1080', bind_vm_id: 'vm-a' }],
    }
    const result = await f.call(...routes[action])
    assert.equal(result.status, 409, JSON.stringify(result))
    assert.equal(result.body.error.code, 'browser_close_failed')
    assert.equal(f.pool.getProxyForVm('vm-a').id, f.first.id)
    assert.equal(f.first.host, '1.2.3.4')
    assert.equal(f.first.enabled, true)
    assert.equal(f.busy.size, 0)
    assert.deepEqual(f.events, ['oauth:vm-a', 'platform:vm-a', 'close:vm-a'])
  })
}

test('invalid bind and unbinding an unrelated slot do not cancel its browser', async (t) => {
  const f = fixture(t)
  f.pool.updateConfig({ bind_limit: 1 })
  f.pool.bind(f.second.id, 'vm-other')
  const result = await f.call('POST', `/api/panel/proxies/${f.second.id}/bind`, { vm_id: 'vm-a' })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'proxy_bind_limit')
  assert.equal(f.pool.getProxyForVm('vm-a').id, f.first.id)
  const unrelated = await f.call('POST', `/api/panel/proxies/${f.second.id}/unbind`, { vm_id: 'vm-a' })
  assert.equal(unrelated.status, 200)
  assert.deepEqual(f.events, [])
  assert.equal(f.pool.getProxyForVm('vm-a').id, f.first.id)
})

test('a concurrent bind cannot join a shared proxy while its connection is changing', async (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, 'vms', 'vm-b.json'), JSON.stringify({ id: 'vm-b', status: 'stopped' }))
  let continueClose, entered
  const ready = new Promise((resolve) => {
    entered = resolve
  })
  const pause = new Promise((resolve) => {
    continueClose = resolve
  })
  const close = f.browser.close
  f.browser.close = async (id) => {
    entered()
    await pause
    return close(id)
  }
  const update = f.call('PUT', `/api/panel/proxies/${f.first.id}`, { port: 1082 })
  await ready
  const bind = await f.call('POST', `/api/panel/proxies/${f.first.id}/bind`, { vm_id: 'vm-b' })
  assert.equal(bind.status, 409)
  assert.equal(bind.body.error.code, 'proxy_changing')
  assert.equal(f.pool.getProxyForVm('vm-b'), null)
  continueClose()
  assert.equal((await update).status, 200)
  assert.equal(f.first.port, 1082)
  assert.deepEqual(f.events, ['oauth:vm-a', 'platform:vm-a', 'close:vm-a', 'apply'])
})
