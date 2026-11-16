import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function handler(project, identity, extra = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project } },
    requireAuth(req) {
      if (!identity) {
        response.status = 401
        return false
      }
      Object.assign(req, identity)
      return true
    },
    json(_res, status, body) {
      Object.assign(response, { status, body })
      return true
    },
    ...extra,
  })
  return {
    async get(id = 'vm-01', query = '') {
      await handlePanel({ method: 'GET' }, {}, new URL(`http://localhost/api/panel/vms/${id}/health${query}`))
      return response
    },
  }
}

test('kernel health requires authentication and administrator access', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-health-acl-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  for (const query of ['', '?range=24h', '?range=7d'])
    assert.equal((await handler(project, null).get('vm-01', query)).status, 401)
  for (const identity of [
    { apiKeyKind: 'managed' },
    { panelUser: 'synthetic-user', panelRole: 'user' },
    { panelUser: 'synthetic-super', panelRole: 'super' },
  ]) {
    for (const query of ['', '?range=24h', '?range=7d']) {
      const result = await handler(project, identity).get('vm-01', query)
      assert.equal(result.status, 403)
      assert.equal(result.body.error.code, 'forbidden')
    }
  }
  for (const identity of [{ apiKeyKind: 'master' }, { panelUser: 'synthetic-admin', panelRole: 'admin' }]) {
    const result = await handler(project, identity).get('missing-slot')
    assert.equal(result.status, 404)
    assert.equal(result.body.error.code, 'vm_not_found')
  }
})

test('kernel-only route returns public Rust and Codex health without billing or detail queries', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-panel-health-'))
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\vm2api-panel-health-${process.pid}-${Date.now()}`
      : path.join(project, 'health.sock')
  const tokenPath = path.join(project, 'synthetic.token')
  fs.writeFileSync(tokenPath, 'synthetic-health-token')
  fs.mkdirSync(path.join(project, 'vms'))
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    assert.equal(req.url, '/internal/health')
    assert.equal(req.headers['x-kin-internal-token'], 'synthetic-health-token')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, healthy: true, ready_slots: 2, worker_version: 'local-fixture' }))
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(project, { recursive: true, force: true })
  })
  const billingStats = t.mock.fn(() => ({ accounts: [] }))
  const billingStatsAsync = t.mock.fn(async () => ({ accounts: [] }))
  const healthBucketsAsync = t.mock.fn(() => assert.fail('kernel health must not read request buckets'))
  const topErrorsAsync = t.mock.fn(() => assert.fail('kernel health must not read request errors'))
  const accountSnapshot = t.mock.fn(() => ({ accounts: [] }))
  const poolSnapshot = t.mock.fn(() => ({}))
  const api = handler(
    project,
    { apiKeyKind: 'master' },
    {
      requestLog: { billingStats, billingStatsAsync, healthBucketsAsync, topErrorsAsync },
      accountQuota: { snapshot: accountSnapshot },
      poolScheduler: { snapshot: poolSnapshot },
    },
  )
  for (const [id, platform, key] of [
    ['vm-rust', 'anthropic', 'rust_health'],
    ['vm-codex', 'openai', 'codex_health'],
  ]) {
    fs.writeFileSync(
      path.join(project, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        platform,
        status: 'running',
        runtime: { kernel_socket: socketPath, codex_kernel_socket: socketPath, worker_token_file: tokenPath },
      }),
    )
    const result = await api.get(id)
    assert.equal(result.status, 200)
    assert.deepEqual(Object.keys(result.body.data).sort(), ['id', 'kernel'])
    const kernel = result.body.data.kernel
    assert.deepEqual(Object.keys(kernel).sort(), ['codex_health', 'go_health', 'rust_health'])
    assert.equal(kernel[key].process_up, true)
    assert.equal(kernel[key].reachable, true)
    assert.equal(kernel[key].worker_version, 'local-fixture')
    assert.equal(kernel.go_health, null)
    assert.equal(kernel[key === 'rust_health' ? 'codex_health' : 'rust_health'], null)
  }
  assert.equal(requests, 2, 'one health probe per slot; no additional live-credential probes')
  assert.equal(billingStats.mock.callCount(), 0)
  assert.equal(billingStatsAsync.mock.callCount(), 0)
  assert.equal(healthBucketsAsync.mock.callCount(), 0)
  assert.equal(topErrorsAsync.mock.callCount(), 0)
  assert.equal(accountSnapshot.mock.callCount(), 0)
  assert.equal(poolSnapshot.mock.callCount(), 0)
})

test('request health ranges use asynchronous statistics without probing a kernel', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-request-health-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  fs.mkdirSync(path.join(project, 'vms'))
  fs.writeFileSync(path.join(project, 'vms', 'vm-a.json'), JSON.stringify({ id: 'vm-a', status: 'stopped' }))
  const healthBucketsAsync = t.mock.fn(
    async ({ slots }) => new Map([['vm-a', Array.from({ length: slots }, () => [1, 2])]]),
  )
  const topErrorsAsync = t.mock.fn(async () => [{ code: 'stream_incomplete', status: 200, count: 2 }])
  const requestLog = {
    healthBucketsAsync,
    topErrorsAsync,
    healthBuckets: () => assert.fail('must not use synchronous health reads'),
    topErrors: () => assert.fail('must not use synchronous error reads'),
    billingStatsAsync: () => assert.fail('request health does not need billing'),
  }
  for (const identity of [{ apiKeyKind: 'master' }, { panelUser: 'admin', panelRole: 'admin' }]) {
    const api = handler(project, identity, { requestLog })
    for (const [range, slots, slotMin] of [
      ['24h', 48, 30],
      ['7d', 84, 120],
    ]) {
      const result = await api.get('vm-a', `?range=${range}`)
      assert.equal(result.status, 200)
      assert.deepEqual(Object.keys(result.body).sort(), ['buckets', 'range', 'slot_min', 'start', 'top_errors'])
      assert.equal(result.body.range, range)
      assert.equal(result.body.slot_min, slotMin)
      assert.equal(result.body.buckets.length, slots)
      assert.deepEqual(result.body.buckets[0], [1, 2])
      assert.equal(result.body.top_errors[0].code, 'stream_incomplete')
      const options = healthBucketsAsync.mock.calls.at(-1).arguments[0]
      assert.deepEqual(options, { now: options.now, vmId: 'vm-a', slots, slotMin })
      assert.equal(result.body.start, new Date(options.now - slots * slotMin * 60_000).toISOString())
      assert.deepEqual(topErrorsAsync.mock.calls.at(-1).arguments[0], { vmId: 'vm-a', since: result.body.start })
    }
  }
  const api = handler(project, { apiKeyKind: 'master' }, { requestLog })
  for (const query of ['?range=', '?range=1h', '?range=24H']) {
    const result = await api.get('vm-a', query)
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'invalid_range')
  }
  assert.equal(healthBucketsAsync.mock.callCount(), 4, 'invalid ranges must not execute statistics')
  assert.equal(topErrorsAsync.mock.callCount(), 4)
  assert.equal((await api.get('missing', '?range=24h')).status, 404)
  const unavailable = handler(project, { apiKeyKind: 'master' })
  assert.equal((await unavailable.get('vm-a', '?range=24h')).status, 503)
})

test('request health returns no inferred buckets for an idle slot', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-idle-health-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  fs.mkdirSync(path.join(project, 'vms'))
  fs.writeFileSync(path.join(project, 'vms', 'vm-a.json'), JSON.stringify({ id: 'vm-a', status: 'stopped' }))
  const api = handler(
    project,
    { apiKeyKind: 'master' },
    {
      requestLog: { healthBucketsAsync: async () => new Map(), topErrorsAsync: async () => [] },
    },
  )
  const result = await api.get('vm-a', '?range=24h')
  assert.equal(result.status, 200)
  assert.equal(result.body.buckets, null)
  assert.deepEqual(result.body.top_errors, [])
})
