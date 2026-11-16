import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { persistCodexQuotaSnapshot, upsertCodexAccount, writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { captureOpenaiAuth, recordOpenaiAuthResult } from '../../src/lib/oauth/openai-auth-state.mjs'
import { queryOpenaiQuota, CHATGPT_USAGE_URL, CHATGPT_RESET_CREDITS_URL } from '../../src/lib/oauth/openai-quota.mjs'
import { CODEX_OAUTH_TOKEN_URL } from '../../src/lib/protocol/codex-models.mjs'

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cred-state-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vmId = 'vm-cred-1'
  fs.mkdirSync(path.join(root, 'vms', vmId), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({ id: vmId, name: 'cred-state', platform: 'codex', status: 'normal', schedulable: true }),
  )
  writeCodexAccounts(root, vmId, [
    { id: 'user@example.com', access_token: 'at-1', refresh_token: 'rt-1', chatgpt_account_id: 'org-1' },
  ])
  return { root, vmId, auth: () => captureOpenaiAuth(root, vmId), read: () => readVm(root, vmId) }
}

function readVm(root, vmId) {
  return JSON.parse(fs.readFileSync(path.join(root, 'vms', `${vmId}.json`), 'utf8'))
}

function jsonResponse(status, payload) {
  return { status, json: async () => payload }
}

function markRefresh(slot, error = 'refresh_rejected') {
  return recordOpenaiAuthResult(slot.auth(), { error, source: 'oauth_refresh', status: 403 })
}

test('structural refresh failures share the revision-aware auth verdict and panel projection', (t) => {
  for (const error of ['refresh_rejected', 'refresh_empty', 'missing_refresh_token', 'invalid_grant']) {
    const slot = makeProject(t)
    assert.equal(markRefresh(slot, error), true)
    const vm = slot.read()
    assert.equal(vm.refresh_error, error)
    assert.equal(vm.codex.refresh_error, error)
    assert.equal(vm.codex.auth_block.reason, error)
    assert.ok(vm.codex.refresh_error_at)
    assert.equal(vm.schedulable, true, 'the authentication verdict does not change operator intent')
  }
})

test('a quota snapshot alone cannot erase the auth owner; an authenticated current result can', (t) => {
  const slot = makeProject(t)
  markRefresh(slot)
  persistCodexQuotaSnapshot(slot.root, slot.vmId, { extra: { codex_5h_used_percent: 10 } })
  assert.equal(slot.read().refresh_error, 'refresh_rejected')
  recordOpenaiAuthResult(slot.auth(), { authenticated: true, source: 'quota' })
  const vm = slot.read()
  assert.equal(vm.refresh_error, undefined)
  assert.equal(vm.codex.refresh_error, undefined)
  assert.equal(vm.codex.refresh_error_at, undefined)
  assert.equal(vm.codex.auth_block, undefined)
})

test('replacing credentials invalidates old structural failures and clears the prior projection', (t) => {
  const slot = makeProject(t)
  const old = slot.auth()
  markRefresh(slot)
  upsertCodexAccount(
    slot.root,
    slot.vmId,
    { access_token: 'at-2', refresh_token: 'rt-2', chatgpt_account_id: 'org-1' },
    { replaceCredentials: true },
  )
  assert.equal(recordOpenaiAuthResult(old, { error: 'refresh_empty', source: 'oauth_refresh' }), false)
  assert.equal(slot.read().refresh_error, undefined)
  assert.equal(slot.read().codex.auth_block, undefined)
})

test('quota rotation persists structured failures while retaining the provider error identity', async (t) => {
  for (const [status, payload, error] of [
    [403, {}, 'refresh_rejected'],
    [200, {}, 'refresh_empty'],
    [400, { error: 'invalid_grant' }, 'invalid_grant'],
  ]) {
    const slot = makeProject(t)
    const res = await queryOpenaiQuota({
      projectRoot: slot.root,
      vmId: slot.vmId,
      fetchImpl: async (url) => {
        if (url === CHATGPT_USAGE_URL) return jsonResponse(401, {})
        if (url === CODEX_OAUTH_TOKEN_URL) return jsonResponse(status, payload)
        throw new Error(`unexpected url ${url}`)
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.error, error)
    const vm = slot.read()
    assert.equal(vm.refresh_error, error)
    assert.equal(vm.codex.refresh_error, error)
    assert.equal(vm.codex.auth_block.reason, error)
  }
})

test('quota rotation leaves refresh health unmarked on transient and ambiguous failures', async (t) => {
  for (const response of [null, jsonResponse(500, {})]) {
    const slot = makeProject(t)
    const res = await queryOpenaiQuota({
      projectRoot: slot.root,
      vmId: slot.vmId,
      fetchImpl: async (url) => {
        if (url === CHATGPT_USAGE_URL) return jsonResponse(401, {})
        if (url === CODEX_OAUTH_TOKEN_URL) {
          if (!response) throw new Error('ECONNRESET')
          return response
        }
        throw new Error(`unexpected url ${url}`)
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.error, response ? 'refresh_failed' : 'fetch_failed')
    assert.equal(slot.read().refresh_error, undefined)
    assert.equal(slot.read().codex.refresh_error, undefined)
    assert.equal(slot.read().codex.auth_block.reason, 'upstream_401')
  }
})

test('a successful current quota query clears the structural failure', async (t) => {
  const slot = makeProject(t)
  markRefresh(slot)
  const res = await queryOpenaiQuota({
    projectRoot: slot.root,
    vmId: slot.vmId,
    fetchImpl: async (url) => {
      if (url === CHATGPT_USAGE_URL) return jsonResponse(200, { rate_limit: { primary_window: { used_percent: 10 } } })
      if (url === CHATGPT_RESET_CREDITS_URL) return jsonResponse(200, {})
      return jsonResponse(403, {})
    },
  })
  assert.equal(res.ok, true)
  assert.equal(slot.read().refresh_error, undefined)
  assert.equal(slot.read().codex.refresh_error, undefined)
  assert.equal(slot.read().codex.auth_block, undefined)
})

test('a delayed quota success cannot clear a newer structured failure or store its sample', async (t) => {
  const slot = makeProject(t)
  const res = await queryOpenaiQuota({
    projectRoot: slot.root,
    vmId: slot.vmId,
    fetchImpl: async (url) => {
      if (url === CHATGPT_USAGE_URL) {
        markRefresh(slot, 'refresh_empty')
        return jsonResponse(200, { rate_limit: { primary_window: { used_percent: 10 } } })
      }
      if (url === CHATGPT_RESET_CREDITS_URL) return jsonResponse(200, {})
      throw new Error(`unexpected url ${url}`)
    },
  })
  assert.equal(res.error, 'credential_changed')
  assert.equal(slot.read().refresh_error, 'refresh_empty')
  assert.equal(slot.read().codex.extra, undefined)
})

test('a delayed refresh failure cannot mark replacement credentials', async (t) => {
  const slot = makeProject(t)
  const res = await queryOpenaiQuota({
    projectRoot: slot.root,
    vmId: slot.vmId,
    fetchImpl: async (url) => {
      if (url === CHATGPT_USAGE_URL) return jsonResponse(401, {})
      if (url === CODEX_OAUTH_TOKEN_URL) {
        upsertCodexAccount(
          slot.root,
          slot.vmId,
          { access_token: 'replacement', refresh_token: 'replacement-refresh', chatgpt_account_id: 'org-new' },
          { replaceCredentials: true },
        )
        return jsonResponse(403, {})
      }
      throw new Error(`unexpected url ${url}`)
    },
  })
  assert.equal(res.error, 'refresh_rejected')
  assert.equal(slot.read().refresh_error, undefined)
  assert.equal(slot.read().codex.auth_block, undefined)
})
