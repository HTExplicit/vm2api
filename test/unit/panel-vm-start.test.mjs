import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function fixture(t, { body, identity = { apiKeyKind: 'master' }, bootFailure } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-panel-start-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  fs.mkdirSync(path.join(project, 'vms'))
  const vm = {
    id: 'vm-start',
    owner_user_id: 'u-owner',
    platform: 'openai',
    family: 'codex',
    status: 'running',
    codex: { has_access: true, email: 'synthetic@example.test' },
    runtime: {
      type: 'docker',
      worker: 'codex',
      pid: 424242,
      kernel_socket: '/private/start-fixture/kernel.sock',
      worker_token_file: '/private/start-fixture/internal.token',
    },
  }
  fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const routing = Object.freeze({ inference: Object.freeze({ eager_start: false }) })
  const proxyPool = {}
  const calls = []
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project } },
    routingConfig: routing,
    proxyPool,
    requireAuth(req) {
      if (!identity) {
        response.status = 401
        return false
      }
      Object.assign(req, identity)
      return true
    },
    readBody: async () => body,
    powerOnSlot: async (args) => {
      calls.push(args)
      return (
        bootFailure || {
          ok: true,
          vm,
          bound: {
            id: 'px-fixture',
            host: '127.0.0.1',
            port: 1080,
            username: 'private-user',
            password: 'private-pass',
          },
          boot: {
            ok: true,
            engine: 'codex',
            action: 'already-running',
            docker: { runtime: vm.runtime },
            kernel: { ok: true, reused: true, configPath: '/private/start-fixture/config.json' },
          },
        }
      )
    },
    json(_res, status, result) {
      Object.assign(response, { status, body: result })
      return true
    },
  })
  return {
    project,
    routing,
    proxyPool,
    calls,
    async start() {
      await handlePanel({ method: 'POST' }, {}, new URL(`http://localhost/api/panel/vms/${vm.id}/start`))
      return response
    },
  }
}

for (const [name, body, expected] of [
  ['empty request', undefined, false],
  ['omitted option', {}, false],
  ['explicit false', { ensure_kernel: false }, false],
  ['explicit true', { ensure_kernel: true }, true],
]) {
  test(`start forwards ensureKernel without changing routing (${name})`, async (t) => {
    const f = fixture(t, { body })
    const result = await f.start()
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(f.calls.length, 1)
    const args = f.calls[0]
    assert.equal(args.id, 'vm-start')
    assert.equal(args.projectRoot, f.project)
    assert.equal(args.proxyPool, f.proxyPool)
    assert.equal(args.routing, f.routing)
    assert.equal(args.ensureKernel, expected)
    assert.equal(args.by, 'start')
    assert.equal(typeof args.fillTimezone, 'function')
    assert.equal(f.routing.inference.eager_start, false)
    assert.equal(result.body.data.vm.status, 'running')
    assert.equal(result.body.data.boot.action, 'already-running')
  })
}

test('start rejects non-boolean ensure_kernel before touching the runtime', async (t) => {
  for (const ensure_kernel of [null, 'true', 'false', 0, 1, [], {}]) {
    const f = fixture(t, { body: { ensure_kernel } })
    const result = await f.start()
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'invalid_ensure_kernel')
    assert.equal(f.calls.length, 0)
  }
})

test('start preserves boot failure status and public error', async (t) => {
  const f = fixture(t, {
    body: { ensure_kernel: true },
    bootFailure: { ok: false, status: 500, code: 'health_timeout', error: 'Codex kernel did not become ready' },
  })
  const result = await f.start()
  assert.equal(result.status, 500)
  assert.deepEqual(result.body, {
    ok: false,
    error: { code: 'health_timeout', message: 'Codex kernel did not become ready' },
  })
  assert.equal(f.calls.length, 1)
})

test('start response keeps private runtime and proxy details out of the payload', async (t) => {
  const f = fixture(t, { body: { ensure_kernel: true } })
  const result = await f.start()
  assert.equal(result.status, 200)
  const serialized = JSON.stringify(result.body)
  for (const privateValue of [
    '/private/start-fixture',
    'private-user',
    'private-pass',
    '424242',
    'synthetic@example.test',
  ]) {
    assert.equal(serialized.includes(privateValue), false, privateValue)
  }
  assert.deepEqual(result.body.data.runtime, { type: 'docker', worker: 'codex', egress: null })
  assert.equal(result.body.data.allocated_proxy.has_auth, true)
})

test('start option preserves authentication, role and tenant ownership checks', async (t) => {
  const denied = [
    [null, 401],
    [{ panelUser: 'observer', panelRole: 'super', panelUserId: 'u-observer' }, 403],
    [{ panelUser: 'foreign', panelRole: 'user', panelUserId: 'u-foreign' }, 404],
  ]
  for (const [identity, status] of denied) {
    const f = fixture(t, { identity, body: { ensure_kernel: true } })
    assert.equal((await f.start()).status, status)
    assert.equal(f.calls.length, 0)
  }
  for (const identity of [
    { apiKeyKind: 'master' },
    { panelUser: 'administrator', panelRole: 'admin', panelUserId: 'u-admin' },
    { panelUser: 'owner', panelRole: 'user', panelUserId: 'u-owner' },
  ]) {
    const f = fixture(t, { identity, body: { ensure_kernel: true } })
    assert.equal((await f.start()).status, 200)
    assert.equal(f.calls.length, 1)
  }
})
