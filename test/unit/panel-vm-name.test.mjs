import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { parseVmDisplayName, VM_DISPLAY_NAME_MAX } from '../../src/lib/vm/vm-registry.mjs'
import { tryAcquireOpenAISlot } from '../../src/lib/pool/openai-account-runtime.mjs'

function seed(root, id, extra = {}) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const vm = {
    id,
    name: '01',
    status: 'stopped',
    schedulable: false,
    policy: { maxConcurrency: 2 },
    ...extra,
  }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(vm))
  return vm
}

function handler(project, body, ctx = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project }, vm: { id: null } },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => body,
    proxyPool: { unbindVm() {} },
    vmRenameOps: {
      preflightContainer: () => ({ ok: true, exists: false }),
      discardContainer: () => ({ ok: true, removed: false }),
    },
    ...ctx,
  })
  return { handlePanel, response }
}

test('parseVmDisplayName trims and keeps a distinct label', () => {
  assert.deepEqual(parseVmDisplayName('  测试槽  '), { ok: true, value: '测试槽' })
  assert.equal(parseVmDisplayName('').ok, false)
  assert.equal(parseVmDisplayName('   ').ok, false)
  assert.equal(parseVmDisplayName(12).ok, false)
  assert.equal(parseVmDisplayName('a\nb').ok, false)
  assert.equal(parseVmDisplayName('x'.repeat(VM_DISPLAY_NAME_MAX + 1)).ok, false)
  assert.equal(parseVmDisplayName('测'.repeat(VM_DISPLAY_NAME_MAX)).ok, true)
})

test('PATCH name updates the display label and keeps the creation id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-name-'))
  try {
    seed(root, 'vm-01', { kernel: 'ubuntu-24.04' })
    const { handlePanel, response } = handler(root, { name: '  测试槽  ' })
    await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 500))
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
    assert.equal(saved.id, 'vm-01')
    assert.equal(saved.name, '测试槽')
    assert.equal(saved.status, 'stopped')
    assert.equal(saved.kernel, 'ubuntu-24.04')
    assert.equal(response.body?.data?.vm?.id, 'vm-01')
    assert.equal(response.body?.data?.vm?.name, '测试槽')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-测试槽.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH name rejects an empty label without writing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-name-'))
  try {
    const before = seed(root, 'vm-01')
    const file = path.join(root, 'vms', 'vm-01.json')
    const { handlePanel, response } = handler(root, { name: '   ' })
    await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'invalid_name')
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH name that looks like another slot does not change the id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-name-'))
  try {
    seed(root, 'vm-01')
    const { handlePanel, response } = handler(root, { name: 'vm-09' })
    await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 500))
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
    assert.equal(saved.id, 'vm-01')
    assert.equal(saved.name, 'vm-09')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH id renames a stopped slot and keeps the display name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-name-'))
  try {
    seed(root, 'slot-src', { kernel: 'ubuntu-24.04' })
    fs.mkdirSync(path.join(root, 'vms', 'slot-src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms', 'slot-src', 'marker.txt'), 'kept')
    const { handlePanel, response } = handler(root, { id: 'slot-dst' })
    await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/slot-src'))
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 800))
    assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-src.json')), false)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'slot-dst.json'), 'utf8'))
    assert.equal(saved.id, 'slot-dst')
    assert.equal(saved.name, '01')
    assert.equal(fs.readFileSync(path.join(root, 'vms', 'slot-dst', 'marker.txt'), 'utf8'), 'kept')
    assert.equal(response.body?.data?.vm?.id, 'slot-dst')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH id preflights rejected changes before cancelling any browser work', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-admission-'))
  t.after(() => fs.rmSync(root, { recursive: true }))
  const cases = [
    { patch: { id: '' }, vm: {}, code: 'invalid_id', status: 400 },
    { patch: { id: 'occupied' }, vm: {}, target: true, code: 'vm_id_taken', status: 409 },
    { patch: { id: 'next' }, vm: { status: 'running' }, code: 'vm_running', status: 409 },
    { patch: { id: 'next' }, vm: { node_id: 'node-a' }, code: 'remote_vm', status: 409 },
  ]
  for (const [index, entry] of cases.entries()) {
    const id = `source-${index}`
    const before = seed(root, id, entry.vm)
    if (entry.target) seed(root, 'occupied')
    const unexpected = () => assert.fail('rejected preflight must have no lifecycle side effects')
    const { handlePanel, response } = handler(root, entry.patch, {
      codexBrowserLogin: { cancel: unexpected },
      openaiApiManager: { cancel: unexpected },
      slotBrowserManager: { close: unexpected, withProxyChange: unexpected },
      vmRenameOps: { preflightContainer: unexpected, discardContainer: unexpected },
    })
    await handlePanel({ method: 'PATCH' }, {}, new URL(`http://localhost/api/panel/vms/${id}`))
    assert.equal(response.status, entry.status)
    assert.equal(response.body.error.code, entry.code)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`))), before)
  }
})

test('PATCH id rejects live scheduler requests before any lifecycle side effect', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-live-'))
  t.after(() => fs.rmSync(root, { recursive: true }))
  const before = seed(root, 'source')
  assert.equal(Object.hasOwn(before, 'inflight'), false)
  const unexpected = () => assert.fail('a live request must prevent cancellation, Docker inspect and movement')
  const { handlePanel, response } = handler(
    root,
    { id: 'next' },
    {
      poolScheduler: { vmInflight: new Map([['source', 1]]) },
      codexBrowserLogin: { cancel: unexpected },
      openaiApiManager: { cancel: unexpected },
      slotBrowserManager: { close: unexpected, withProxyChange: unexpected },
      vmRenameOps: { preflightContainer: unexpected, discardContainer: unexpected },
    },
  )
  await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/source'))
  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, 'vm_busy')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'vms/source.json'))), before)
  assert.equal(fs.existsSync(path.join(root, 'vms/next.json')), false)
})

test('PATCH id checks the live Codex lease and allows rename after its release', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-codex-live-'))
  t.after(() => fs.rmSync(root, { recursive: true }))
  const before = seed(root, 'codex-source', { platform: 'openai', family: 'codex' })
  assert.equal(Object.hasOwn(before, 'inflight'), false)
  const lease = tryAcquireOpenAISlot('codex-source', { concurrency: 1 })
  assert.ok(lease)
  t.after(() => lease.release())
  const events = []
  const { handlePanel, response } = handler(
    root,
    { id: 'codex-next' },
    {
      poolScheduler: { vmInflight: new Map() },
      codexBrowserLogin: {
        async cancel() {
          events.push('oauth')
        },
      },
      openaiApiManager: {
        async cancel() {
          events.push('platform')
        },
        view: () => null,
      },
      slotBrowserManager: {
        async close() {
          events.push('browser')
        },
      },
      vmRenameOps: {
        preflightContainer: () => {
          events.push('inspect')
          return { ok: true, exists: false }
        },
        discardContainer: () => {
          events.push('discard')
          return { ok: true, removed: false }
        },
      },
    },
  )
  const endpoint = new URL('http://localhost/api/panel/vms/codex-source')
  await handlePanel({ method: 'PATCH' }, {}, endpoint)
  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, 'vm_busy')
  assert.deepEqual(events, [])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'vms/codex-source.json'))), before)
  assert.equal(fs.existsSync(path.join(root, 'vms/codex-next.json')), false)

  lease.release()
  await handlePanel({ method: 'PATCH' }, {}, endpoint)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.deepEqual(events, ['inspect', 'oauth', 'platform', 'browser', 'discard'])
  assert.equal(fs.existsSync(path.join(root, 'vms/codex-source.json')), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms/codex-next.json'))).id, 'codex-next')
})

test('PATCH id rejects Docker inspection errors before closing the browser', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-inspect-'))
  t.after(() => fs.rmSync(root, { recursive: true }))
  const before = seed(root, 'source')
  const unexpected = () => assert.fail('inspect error must not close, discard or move the slot')
  const { handlePanel, response } = handler(
    root,
    { id: 'next' },
    {
      codexBrowserLogin: { cancel: unexpected },
      openaiApiManager: { cancel: unexpected },
      slotBrowserManager: { close: unexpected },
      vmRenameOps: {
        preflightContainer: () => ({ ok: false, code: 'container_inspect_failed', error: 'daemon unavailable' }),
        discardContainer: unexpected,
      },
    },
  )
  await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/source'))
  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, 'container_inspect_failed')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'vms/source.json'))), before)
  assert.equal(fs.existsSync(path.join(root, 'vms/next.json')), false)
})

test('PATCH id excludes new browser opens until cancellation, close and rename finish', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-browser-'))
  t.after(() => fs.rmSync(root, { recursive: true }))
  const before = seed(root, 'source', { proxy: { scheme: 'http', host: 'proxy.local', port: 8080, password: 'kept' } })
  const events = []
  let excluded = false
  let browserClosed = false
  const { handlePanel, response } = handler(
    root,
    { id: 'next' },
    {
      codexBrowserLogin: {
        async cancel(id) {
          assert.equal(excluded, true)
          events.push(`oauth:${id}`)
        },
      },
      openaiApiManager: {
        async cancel(id) {
          assert.equal(excluded, true)
          events.push(`platform:${id}`)
        },
      },
      slotBrowserManager: {
        async withProxyChange(ids, action) {
          assert.deepEqual(ids, ['source'])
          excluded = true
          try {
            return await action()
          } finally {
            excluded = false
          }
        },
        async close(id) {
          events.push(`close:${id}`)
          await Promise.resolve()
          browserClosed = true
        },
      },
      vmRenameOps: {
        preflightContainer: () => {
          events.push('inspect')
          return { ok: true, exists: true }
        },
        discardContainer: (id) => {
          assert.equal(excluded, true)
          assert.equal(browserClosed, true)
          events.push(`discard:${id}`)
          return { ok: true, removed: true }
        },
      },
    },
  )
  await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/source'))
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.deepEqual(events, ['inspect', 'oauth:source', 'platform:source', 'close:source', 'discard:source'])
  assert.equal(excluded, false)
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms/next.json')))
  assert.deepEqual(saved.proxy, before.proxy)
  assert.equal(saved.schedulable, false)
})

test('PATCH id keeps the old slot when browser close fails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-close-'))
  t.after(() => fs.rmSync(root, { recursive: true }))
  const before = seed(root, 'source')
  const events = []
  const { handlePanel, response } = handler(
    root,
    { id: 'next' },
    {
      codexBrowserLogin: {
        async cancel() {
          events.push('oauth')
        },
      },
      openaiApiManager: {
        async cancel() {
          events.push('platform')
        },
      },
      slotBrowserManager: {
        async close() {
          throw Object.assign(new Error('still closing'), { code: 'browser_close_failed' })
        },
      },
      vmRenameOps: {
        preflightContainer: () => ({ ok: true, exists: true }),
        discardContainer: () => assert.fail('browser close failure must not remove the container'),
      },
    },
  )
  await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/source'))
  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, 'browser_close_failed')
  assert.deepEqual(events, ['oauth', 'platform'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'vms/source.json'))), before)
  assert.equal(fs.existsSync(path.join(root, 'vms/next.json')), false)
})
