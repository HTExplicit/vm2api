import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pickCodexCandidates } from '../../src/lib/protocol/handle-codex.mjs'
import { getVm, syncCodexQuotaSchedule } from '../../src/lib/vm/vm-registry.mjs'
import { invalidateReadCache, setVmWriteHook } from '../../src/lib/vm/vm-file.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

beforeEach(() => resetOpenAIAccountRuntime())

function fleet(t, records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-admission-records-'))
  t.after(() => {
    setVmWriteHook(null)
    invalidateReadCache()
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const [id, patch] of Object.entries(records)) {
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({ id, platform: 'openai', family: 'codex', status: 'running', schedulable: true, ...patch }),
    )
    fs.writeFileSync(
      path.join(root, 'vms', id, 'codex-credentials.json'),
      JSON.stringify({ accounts: [{ access_token: 'test-at', refresh_token: 'test-rt' }] }),
    )
  }
  return root
}

function limited(reset) {
  return { codex: { extra: { codex_5h_used_percent: 100, ...(reset ? { codex_5h_reset_at: reset } : {}) } } }
}

test('stable candidate selection reads each slot once without rewriting records', (t) => {
  const root = fleet(t, { 'vm-a': {}, 'vm-b': {} })
  const dir = path.join(root, 'vms')
  const recordPaths = ['vm-a', 'vm-b'].map((id) => path.join(dir, `${id}.json`))
  const before = recordPaths.map((file) => fs.readFileSync(file, 'utf8'))
  let writes = 0
  setVmWriteHook(() => writes++)
  const read = fs.readFileSync
  const list = fs.readdirSync
  const reads = t.mock.method(fs, 'readFileSync', (...args) => read(...args))
  const lists = t.mock.method(fs, 'readdirSync', (...args) => list(...args))
  for (let round = 0; round < 2; round++) {
    invalidateReadCache()
    reads.mock.resetCalls()
    lists.mock.resetCalls()
    const picked = pickCodexCandidates(root, { headers: {}, apiKeyKind: 'master' })
    assert.deepEqual(new Set(picked.ids), new Set(['vm-a', 'vm-b']))
    assert.equal(lists.mock.calls.filter(({ arguments: args }) => args[0] === dir).length, 1)
    for (const file of recordPaths) {
      assert.equal(reads.mock.calls.filter(({ arguments: args }) => args[0] === file).length, 1)
    }
  }
  assert.equal(writes, 0)
  t.mock.restoreAll()
  assert.deepEqual(
    recordPaths.map((file) => fs.readFileSync(file, 'utf8')),
    before,
  )
})

test('an unchanged quota restriction skips file and DB mirror writes, but a new reset is immediate', (t) => {
  const reset = new Date(Date.now() + 3_600_000).toISOString()
  const root = fleet(t, { 'vm-a': limited(reset) })
  let writes = 0
  setVmWriteHook(() => writes++)
  assert.equal(syncCodexQuotaSchedule(root, getVm(root, 'vm-a')).changed, true)
  assert.equal(writes, 1)
  const file = path.join(root, 'vms', 'vm-a.json')
  const before = fs.readFileSync(file, 'utf8')
  assert.equal(syncCodexQuotaSchedule(root, getVm(root, 'vm-a')).changed, false)
  assert.equal(writes, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), before)

  const updated = getVm(root, 'vm-a')
  const nextReset = new Date(Date.now() + 7_200_000).toISOString()
  updated.codex.extra.codex_5h_reset_at = nextReset
  fs.writeFileSync(file, JSON.stringify(updated))
  assert.equal(syncCodexQuotaSchedule(root, getVm(root, 'vm-a')).changed, true)
  assert.equal(getVm(root, 'vm-a').temp_unschedulable_until, Date.parse(nextReset))
  assert.equal(writes, 2)
})

test('a missing restriction copy is repaired rather than mistaken for an unchanged state', (t) => {
  const reset = new Date(Date.now() + 3_600_000).toISOString()
  const root = fleet(t, {
    'vm-a': {
      ...limited(reset),
      temp_unschedulable_reason: 'quota_5h_header',
      temp_unschedulable_until: Date.parse(reset),
    },
  })
  assert.equal(syncCodexQuotaSchedule(root, getVm(root, 'vm-a')).changed, true)
  const stored = getVm(root, 'vm-a')
  assert.equal(stored.claude.temp_unschedulable_reason, stored.temp_unschedulable_reason)
  assert.equal(stored.claude.temp_unschedulable_until, stored.temp_unschedulable_until)
})

test('local quota without a reset removes the previous expiry and then stays unchanged', (t) => {
  const oldUntil = Date.now() + 3_600_000
  const root = fleet(t, {
    'vm-a': {
      codex: { extra: { codex_5h_used_percent: 80 } },
      temp_unschedulable_reason: 'quota_5h_local',
      temp_unschedulable_until: oldUntil,
      claude: { temp_unschedulable_reason: 'quota_5h_local', temp_unschedulable_until: oldUntil },
    },
  })
  const policy = { limit_5h: 0.7 }
  assert.equal(syncCodexQuotaSchedule(root, getVm(root, 'vm-a'), { policy }).changed, true)
  const stored = getVm(root, 'vm-a')
  assert.equal(stored.temp_unschedulable_until, undefined)
  assert.equal(stored.claude.temp_unschedulable_until, undefined)
  assert.equal(syncCodexQuotaSchedule(root, stored, { policy }).changed, false)
})

test('missing hard-quota reset retains the existing rolling five-minute hold', (t) => {
  const root = fleet(t, { 'vm-a': limited() })
  const firstNow = Date.now()
  const first = syncCodexQuotaSchedule(root, getVm(root, 'vm-a'), { now: firstNow })
  assert.equal(first.until, firstNow + 300_000)
  const second = syncCodexQuotaSchedule(root, getVm(root, 'vm-a'), { now: firstNow + 1000 })
  assert.equal(second.changed, true)
  assert.equal(second.until, firstNow + 301_000)
  assert.equal(getVm(root, 'vm-a').temp_unschedulable_until, second.until)
})

test('quota reset and policy changes affect the next admission without a refresh interval', (t) => {
  const reset = Date.now() + 3_600_000
  const root = fleet(t, { 'vm-a': limited(new Date(reset).toISOString()), 'vm-b': {} })
  const req = { headers: {}, apiKeyKind: 'master' }
  assert.deepEqual(pickCodexCandidates(root, req).ids, ['vm-b'])
  t.mock.method(Date, 'now', () => reset + 1)
  assert.deepEqual(new Set(pickCodexCandidates(root, req).ids), new Set(['vm-a', 'vm-b']))
  assert.equal(getVm(root, 'vm-a').temp_unschedulable_reason, undefined)
  t.mock.restoreAll()

  const file = path.join(root, 'vms', 'vm-a.json')
  const vm = getVm(root, 'vm-a')
  vm.codex.extra = { codex_5h_used_percent: 80, codex_5h_reset_at: new Date(reset).toISOString() }
  fs.writeFileSync(file, JSON.stringify(vm))
  assert.deepEqual(pickCodexCandidates(root, req, { routing: { codex: { quota: { limit_5h: 0.7 } } } }).ids, ['vm-b'])
  assert.deepEqual(
    new Set(pickCodexCandidates(root, req, { routing: { codex: { quota: { limit_5h: 0.9 } } } }).ids),
    new Set(['vm-a', 'vm-b']),
  )
})

test('legacy quota-off migration is visible in the same candidate load and manual off stays off', (t) => {
  const reset = new Date(Date.now() + 3_600_000).toISOString()
  const restriction = { temp_unschedulable_reason: 'quota_5h_header', temp_unschedulable_until: Date.parse(reset) }
  const root = fleet(t, {
    'vm-legacy': { schedulable: false, schedule_disabled_reason: 'quota_5h_header', schedule_manual: false },
    'vm-legacy-limited': {
      ...limited(reset),
      ...restriction,
      claude: restriction,
      schedulable: false,
      schedule_disabled_reason: 'quota_5h_header',
      schedule_manual: false,
    },
    'vm-manual': {
      ...limited(reset),
      schedulable: false,
      schedule_disabled_reason: 'disabled',
      schedule_manual: true,
      schedule_off: true,
    },
  })
  const picked = pickCodexCandidates(root, { headers: {}, apiKeyKind: 'master' })
  assert.deepEqual(picked.ids, ['vm-legacy'])
  const restored = getVm(root, 'vm-legacy')
  assert.equal(restored.schedulable, true)
  assert.equal(restored.schedule_disabled_reason, null)
  assert.equal(getVm(root, 'vm-legacy-limited').schedulable, true)
  assert.equal(getVm(root, 'vm-legacy-limited').schedule_disabled_reason, null)
  assert.equal(getVm(root, 'vm-manual').schedule_off, true)
  assert.equal(getVm(root, 'vm-manual').schedulable, false)
  assert.equal(getVm(root, 'vm-manual').schedule_manual, true)
})

test('quota persistence errors still propagate rather than silently excluding the slot', (t) => {
  const root = fleet(t, { 'vm-a': limited(new Date(Date.now() + 3_600_000).toISOString()) })
  const write = fs.writeFileSync
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).includes('.vm-a.json.')) throw new Error('test quota write failed')
    return write(file, ...args)
  })
  assert.throws(() => pickCodexCandidates(root, { headers: {}, apiKeyKind: 'master' }), /test quota write failed/)
})

test('a non-Codex visible inventory keeps its existing empty-Codex error', (t) => {
  const root = fleet(t, { 'vm-claude': { platform: 'anthropic', family: 'claude' } })
  assert.equal(pickCodexCandidates(root, { headers: {}, apiKeyKind: 'master' }).error, 'no_codex_vm')
})
