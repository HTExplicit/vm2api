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
    async get(id = 'vm-01') {
      await handlePanel({ method: 'GET' }, {}, new URL(`http://localhost/api/panel/vms/${id}/health`))
      return response
    },
  }
}

test('kernel health requires authentication and administrator access', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-health-acl-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  assert.equal((await handler(project, null).get()).status, 401)
  for (const identity of [
    { apiKeyKind: 'managed' },
    { panelUser: 'synthetic-user', panelRole: 'user' },
    { panelUser: 'synthetic-super', panelRole: 'super' },
  ]) {
    const result = await handler(project, identity).get()
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, 'forbidden')
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
  const accountSnapshot = t.mock.fn(() => ({ accounts: [] }))
  const poolSnapshot = t.mock.fn(() => ({}))
  const api = handler(
    project,
    { apiKeyKind: 'master' },
    {
      requestLog: { billingStats },
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
  assert.equal(accountSnapshot.mock.callCount(), 0)
  assert.equal(poolSnapshot.mock.callCount(), 0)
})
