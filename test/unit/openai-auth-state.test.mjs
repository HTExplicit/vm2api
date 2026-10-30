import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  captureOpenaiAuth,
  isOpenaiAuthCurrent,
  isOpenaiCredentialCurrent,
  readOpenaiAuthBlock,
  recordOpenaiAuthResult,
} from '../../src/lib/oauth/openai-auth-state.mjs'
import { upsertCodexAccount, writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'
import { getVm, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'
import {
  codexAccountStatus,
  isCodexSlotReady,
  orderCodexSessionSlots,
  pickCodexSlots,
} from '../../src/lib/pool/codex-slot-pool.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

function fixture(t, { scheduleOff = false } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-auth-'))
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  const vmId = 'vm-auth'
  fs.mkdirSync(path.join(projectRoot, 'vms', vmId), { recursive: true })
  atomicWriteJson(path.join(projectRoot, 'vms', `${vmId}.json`), {
    id: vmId,
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: !scheduleOff,
    schedule_off: scheduleOff,
    schedule_manual: scheduleOff,
    codex: {},
  })
  writeCodexAccounts(projectRoot, vmId, [
    { access_token: 'access-one', refresh_token: 'refresh-one', chatgpt_account_id: 'account-one' },
  ])
  return {
    projectRoot,
    vmId,
    capture: () => captureOpenaiAuth(projectRoot, vmId),
    block: () => readOpenaiAuthBlock(projectRoot, vmId),
    raw: () => getVm(projectRoot, vmId),
    summary: () => summarizeVm(getVm(projectRoot, vmId), projectRoot),
  }
}

test('401 persists across runtime reset and excludes ordinary, sticky and pinned admissions', (t) => {
  const slot = fixture(t)
  recordOpenaiAuthResult(slot.capture(), { status: 401, source: 'subscription', message: 'Unauthorized' })
  assert.equal(slot.block().source, 'subscription')
  assert.ok(slot.raw().codex.auth_block)
  resetOpenAIAccountRuntime()
  assert.ok(slot.block(), 'authentication blocks are not process-local cooldowns')
  const vm = slot.summary()
  assert.equal(isCodexSlotReady(vm), false)
  assert.equal(codexAccountStatus(vm), 'error')
  assert.deepEqual(pickCodexSlots([vm]).ids, [])
  assert.deepEqual(orderCodexSessionSlots([vm], { boundVmId: vm.id }).ids, [])
  assert.equal(pickCodexSlots([vm], { pin: vm.id }).error, 'credential_blocked')
  assert.deepEqual(orderCodexSessionSlots([vm], { pin: vm.id }).ids, [])
  assert.equal(slot.block().account_id, undefined)
  assert.equal(slot.block().access_token, undefined)
  assert.equal(slot.raw().schedulable, true, 'operator scheduling intent is untouched')
})

test('successful authentication recovers without enabling an operator-disabled slot', (t) => {
  const slot = fixture(t, { scheduleOff: true })
  recordOpenaiAuthResult(slot.capture(), { status: 401, source: 'quota' })
  recordOpenaiAuthResult(slot.capture(), { status: 200, source: 'quota', authenticated: true })
  assert.equal(slot.block(), null)
  assert.equal(slot.raw().schedule_off, true)
  assert.equal(slot.raw().schedulable, false)
  assert.deepEqual(pickCodexSlots([slot.summary()]).ids, [])
})

test('replacement credentials invalidate an old failure even for the same account', (t) => {
  const slot = fixture(t)
  const old = slot.capture()
  upsertCodexAccount(
    slot.projectRoot,
    slot.vmId,
    { access_token: 'access-two', refresh_token: 'refresh-two', chatgpt_account_id: 'account-one' },
    { replaceCredentials: true },
  )
  assert.equal(isOpenaiAuthCurrent(old), false)
  recordOpenaiAuthResult(old, { status: 401, source: 'inference' })
  assert.equal(slot.block(), null)
  recordOpenaiAuthResult(slot.capture(), { status: 401, source: 'inference' })
  assert.ok(slot.block())
  upsertCodexAccount(
    slot.projectRoot,
    slot.vmId,
    { access_token: 'access-three', refresh_token: 'refresh-three', chatgpt_account_id: 'account-other' },
    { replaceCredentials: true },
  )
  assert.equal(slot.block(), null, 'a replacement account does not inherit the block')
})

test('a delayed earlier success cannot erase a newer authentication failure', (t) => {
  const slot = fixture(t)
  const earlierQuery = slot.capture()
  recordOpenaiAuthResult(slot.capture(), { status: 401, source: 'inference' })
  recordOpenaiAuthResult(earlierQuery, { status: 200, source: 'catalog', authenticated: true })
  assert.equal(slot.block().source, 'inference')
})

test('a concurrent 401 does not invalidate a successfully rotated refresh token', (t) => {
  const slot = fixture(t)
  const rotating = slot.capture()
  recordOpenaiAuthResult(rotating, { status: 401, source: 'quota' })
  recordOpenaiAuthResult(slot.capture(), { status: 401, source: 'inference' })
  assert.equal(isOpenaiAuthCurrent(rotating), false)
  assert.equal(isOpenaiCredentialCurrent(rotating), true)
  upsertCodexAccount(slot.projectRoot, slot.vmId, { access_token: 'rotated-access', refresh_token: 'rotated-refresh' })
  assert.equal(slot.block(), null)
  assert.equal(isOpenaiCredentialCurrent(rotating), false)
})

test('403 and transport errors do not create a block; explicit invalid_grant does', (t) => {
  const slot = fixture(t)
  const auth = slot.capture()
  recordOpenaiAuthResult(auth, { status: 403, source: 'subscription' })
  recordOpenaiAuthResult(auth, { status: 502, source: 'quota', error: 'fetch_failed' })
  assert.equal(slot.block(), null)
  recordOpenaiAuthResult(auth, { status: 400, source: 'oauth_refresh', error: 'invalid_grant' })
  assert.ok(slot.block())
})

test('one existing recovery flow can block, recover and observe a later 401 in response order', (t) => {
  const slot = fixture(t)
  const auth = slot.capture()
  recordOpenaiAuthResult(auth, { status: 401, source: 'quota' })
  assert.ok(slot.block())
  recordOpenaiAuthResult(auth, { status: 200, source: 'quota', authenticated: true })
  assert.equal(slot.block(), null)
  recordOpenaiAuthResult(auth, { status: 401, source: 'subscription' })
  assert.equal(slot.block().source, 'subscription')
})

test('expired access without a 401 remains eligible only while a refresh token exists', () => {
  const now = Date.now()
  const vm = {
    id: 'vm-expired',
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    has_token: true,
    has_refresh: true,
    expires_at: now - 60_000,
  }
  assert.equal(isCodexSlotReady(vm, now), true)
  assert.equal(isCodexSlotReady({ ...vm, has_refresh: false }, now), false)
})
