import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { recoverProxyScheduleHold } from '../../src/lib/vm/proxy-schedule-recovery.mjs'
import { getVm, setScheduleHold, setScheduleOff } from '../../src/lib/vm/vm-registry.mjs'

function fixture(t, { verifyRuntime = async () => true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-proxy-recovery-'))
  fs.mkdirSync(path.join(root, 'vms'))
  const wakes = []
  const pool = new ProxyPool({
    dataDir: root,
    onDisableVm: (id, message, tag) => setScheduleHold(root, id, 'proxy_cooldown', { tag, message }),
    onEnableVm: (id, _reason, _proxyId, proof) =>
      recoverProxyScheduleHold(root, id, { ...proof, verifyRuntime, wake: (vmId) => wakes.push(vmId) }),
  })
  t.after(() => {
    pool.stopScheduler()
    fs.rmSync(root, { recursive: true, force: true })
  })
  pool.importLines('192.0.2.1:1080\n192.0.2.2:1080')
  const [current, previous] = pool.snapshot().proxies
  const proxy = pool.getProxyByIdWithAuth(current.id)
  const probe = { ok: true, scope: 'socks', latency_ms: 10 }
  pool.probeOne = async () => probe
  function slot(id, tag, extra = {}) {
    pool.bind(current.id, id)
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        family: 'codex',
        status: 'running',
        proxy,
        schedulable: false,
        schedule_hold: { reason: 'proxy_cooldown', detail: { tag, message: 'proxy_probe_failed' } },
        ...extra,
      }),
    )
  }
  return { root, pool, current, previous, proxy, slot, wakes, probe }
}

test('a successful probe of an already healthy shared proxy reconciles stale and untagged holds', async (t) => {
  const { root, current, previous, pool, slot, wakes } = fixture(t)
  await pool.probeById(current.id)
  slot('vm-01', previous.id)
  slot('vm-02', previous.id, { schedule_off: true })
  slot('vm-03', current.id, { unschedulable: { reason: 'oauth_revoked' } })
  slot('vm-04', null)
  slot('vm-05', previous.id, { status: 'stopped' })
  await pool.probeById(previous.id)
  assert.equal(getVm(root, 'vm-01').schedule_hold.detail.tag, previous.id)
  await pool.probeAll()
  for (const id of ['vm-01', 'vm-02', 'vm-03', 'vm-04']) assert.equal(getVm(root, id).schedule_hold, undefined)
  assert.equal(getVm(root, 'vm-01').schedulable, true)
  assert.equal(getVm(root, 'vm-02').schedulable, false)
  assert.equal(getVm(root, 'vm-02').schedule_off, true)
  assert.equal(getVm(root, 'vm-03').unschedulable.reason, 'oauth_revoked')
  assert.equal(getVm(root, 'vm-03').schedulable, false)
  assert.equal(getVm(root, 'vm-05').status, 'stopped')
  assert.equal(getVm(root, 'vm-05').schedule_hold.detail.tag, previous.id)
  assert.deepEqual(wakes, ['vm-01', 'vm-04'])
})

test('failed egress and an unverified rebind both leave the hold for a later probe', async (t) => {
  let ready = false
  const { root, current, previous, pool, slot, probe } = fixture(t, { verifyRuntime: async () => ready })
  slot('vm-01', previous.id)
  pool.probeOne = async () => ({ ...probe, ok: false, scope: 'egress' })
  await pool.probeById(current.id)
  assert.equal(getVm(root, 'vm-01').schedule_hold.detail.tag, current.id)
  setScheduleHold(root, 'vm-01', 'proxy_cooldown', { tag: previous.id })
  pool.probeOne = async () => probe
  await pool.probeById(current.id)
  assert.equal(getVm(root, 'vm-01').schedulable, false)
  ready = true
  await pool.probeById(current.id)
  assert.equal(getVm(root, 'vm-01').schedulable, true)
})

test('manual proxy disable survives an overlapping successful probe and an explicit diagnostic probe', async (t) => {
  const { root, current, pool, slot, probe } = fixture(t)
  slot('vm-01', current.id)
  const pending = Promise.withResolvers()
  pool.probeOne = () => pending.promise
  const inflight = pool.probeById(current.id)
  pool.setEnabled(current.id, false)
  pending.resolve(probe)
  assert.equal((await inflight).probe.scope, 'stale')
  assert.equal((await pool.probeById(current.id)).proxy.enabled, false)
  assert.equal(getVm(root, 'vm-01').schedule_hold.detail.message, 'proxy_manually_disabled')
  pool.setEnabled(current.id, true)
  assert.equal(getVm(root, 'vm-01').schedulable, false)
  await pool.probeById(current.id)
  assert.equal(getVm(root, 'vm-01').schedulable, true)
})

test('obsolete probes cannot clear a newer hold, overwrite a rebind, or lose manual schedule intent', async (t) => {
  const check = Promise.withResolvers()
  let checking
  const entered = new Promise((resolve) => {
    checking = resolve
  })
  const { root, current, previous, pool, slot } = fixture(t, {
    verifyRuntime: async () => {
      checking()
      return check.promise
    },
  })
  slot('vm-01', previous.id)
  const inflight = pool.probeById(current.id)
  await entered
  setScheduleOff(root, 'vm-01', true)
  setScheduleHold(root, 'vm-01', 'proxy_cooldown', { tag: current.id, message: 'new_failure' })
  pool.bind(previous.id, 'vm-01')
  check.resolve(true)
  await inflight
  assert.equal(getVm(root, 'vm-01').schedule_hold.detail.message, 'new_failure')
  assert.equal(getVm(root, 'vm-01').schedule_off, true)
})
