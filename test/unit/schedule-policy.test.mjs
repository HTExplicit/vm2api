import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  setManualScheduleWins,
  getManualScheduleWins,
  isManualScheduleLocked,
} from '../../src/lib/pool/schedule-policy.mjs'
import {
  ORGANIZATION_PAUSE_REASON,
  getVm,
  holdSchedulableSlots,
  resumeSchedulableSlots,
  setVmSchedulable,
  waitForSlotDrain,
} from '../../src/lib/vm/vm-registry.mjs'
import { restoreScheduleAfterLiveCredential } from '../../src/lib/oauth/oauth-credentials.mjs'

afterEach(() => {
  setManualScheduleWins(true)
})

test('manual_schedule_wins defaults to true', () => {
  setManualScheduleWins(undefined)
  assert.equal(getManualScheduleWins(), true)
  setManualScheduleWins(false)
  assert.equal(getManualScheduleWins(), false)
})

test('legacy operator disabled is locked while manual wins', () => {
  assert.equal(isManualScheduleLocked({ schedule_disabled_reason: 'disabled' }), true)
  assert.equal(isManualScheduleLocked({ schedule_manual: true, schedulable: true }), true)
  assert.equal(isManualScheduleLocked({ schedule_disabled_reason: 'quota_refresh_failed' }), false)
  setManualScheduleWins(false)
  assert.equal(isManualScheduleLocked({ schedule_manual: true }), false)
})

test('auto cannot override a manual lock; panel source can', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sched-'))
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'vm-01.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      id: 'vm-01',
      status: 'running',
      schedulable: true,
      claude: { has_access: true, has_refresh: true },
    }),
  )

  const locked = setVmSchedulable(project, 'vm-01', false, 'disabled', { source: 'manual', preserveStatus: true })
  assert.equal(locked.schedulable, false)
  assert.equal(locked.schedule_manual, true)
  assert.equal(locked.schedule_disabled_reason, 'disabled')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'running')

  const skipped = setVmSchedulable(project, 'vm-01', true)
  assert.equal(skipped.schedulable, false)
  assert.equal(skipped.schedule_manual, true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schedulable, false)

  const ejected = setVmSchedulable(project, 'vm-01', false, 'quota_refresh_failed', { preserveStatus: true })
  assert.equal(ejected.schedule_disabled_reason, 'disabled')

  setManualScheduleWins(false)
  const autoOn = setVmSchedulable(project, 'vm-01', true)
  assert.equal(autoOn.schedulable, true)
  fs.rmSync(project, { recursive: true, force: true })
})
test('kernel update hold restores the previous schedule without an auto unlock', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-hold-'))
  const file = path.join(project, 'vms', 'vm-01.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ id: 'vm-01', status: 'running', schedulable: true }))
  const held = setVmSchedulable(project, 'vm-01', false, 'kernel_update', {
    preserveStatus: true,
    source: 'force',
  })
  assert.equal(held.schedulable, false)
  assert.equal(held.schedule_disabled_reason, 'kernel_update')
  assert.equal(setVmSchedulable(project, 'vm-01', true).schedulable, false)
  const restored = setVmSchedulable(project, 'vm-01', true, null, { preserveStatus: true, source: 'force' })
  assert.equal(restored.schedulable, true)
  assert.equal(restored.schedule_disabled_reason, null)
  fs.rmSync(project, { recursive: true, force: true })
})
test('a failed kernel hold restores only the slots it paused', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-hold-fail-'))
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'vm-01.json'), JSON.stringify({ id: 'vm-01', status: 'running', schedulable: true }))
  fs.writeFileSync(
    path.join(dir, 'vm-02.json'),
    JSON.stringify({
      id: 'vm-02',
      status: 'running',
      schedulable: false,
      schedule_manual: true,
      schedule_disabled_reason: 'disabled',
    }),
  )
  const held = holdSchedulableSlots(project, 'kernel_update')
  const drain = await waitForSlotDrain({ vmInflight: new Map([['vm-01', 1]]) }, held, { timeoutMs: 1 })
  assert.equal(drain.ok, false)
  const restored = drain.ok ? [] : resumeSchedulableSlots(project, held, 'kernel_update')
  assert.deepEqual(restored, ['vm-01'])
  assert.equal(getVm(project, 'vm-01').schedulable, true)
  const manual = getVm(project, 'vm-02')
  assert.equal(manual.schedulable, false)
  assert.equal(manual.schedule_disabled_reason, 'disabled')
  fs.rmSync(project, { recursive: true, force: true })
})

test('restoreScheduleAfterLiveCredential keeps a manual lock', () => {
  const vm = {
    status: 'paused',
    schedulable: false,
    schedule_manual: true,
    schedule_disabled_reason: 'oauth_cleared',
    claude: { has_access: true, has_refresh: true },
  }
  restoreScheduleAfterLiveCredential(vm)
  assert.equal(vm.schedulable, false)
  assert.equal(vm.schedule_disabled_reason, 'oauth_cleared')

  setManualScheduleWins(false)
  restoreScheduleAfterLiveCredential(vm)
  assert.equal(vm.schedulable, true)
  assert.equal(vm.schedule_disabled_reason, null)
})

test('org pause records the upstream error and only an operator write resumes it', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-org-pause-'))
  const file = path.join(project, 'vms', 'vm-01.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      id: 'vm-01',
      status: 'running',
      schedulable: true,
      schedule_manual: true,
      claude: { has_access: true, has_refresh: true },
    }),
  )
  const detail = { status: 403, message: 'OAuth authentication is currently not allowed for this organization.' }
  const paused = setVmSchedulable(project, 'vm-01', false, ORGANIZATION_PAUSE_REASON, {
    preserveStatus: true,
    source: 'force',
    detail,
  })
  assert.equal(paused.schedulable, false)
  assert.equal(paused.schedule_disabled_reason, 'organization_disabled')
  assert.deepEqual(paused.schedule_disabled_detail, detail)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'running')

  // Auto writes (proxy re-enable, worker reload) neither resume nor rename it, manual lock or not.
  setManualScheduleWins(false)
  assert.equal(setVmSchedulable(project, 'vm-01', true).schedulable, false)
  const renamed = setVmSchedulable(project, 'vm-01', false, 'egress_down|proxy=p1')
  assert.equal(renamed.schedule_disabled_reason, 'organization_disabled')
  assert.deepEqual(renamed.schedule_disabled_detail, detail)

  const resumed = setVmSchedulable(project, 'vm-01', true, null, { preserveStatus: true, source: 'manual' })
  assert.equal(resumed.schedulable, true)
  assert.equal(resumed.schedule_disabled_reason, null)
  assert.equal(resumed.schedule_disabled_detail, null)
  assert.equal('schedule_disabled_detail' in JSON.parse(fs.readFileSync(file, 'utf8')), false)
  fs.rmSync(project, { recursive: true, force: true })
})
