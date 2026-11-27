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

// buildProbeOne 的 codex 分支必须把探测结果写回账号行 unified.last_probe
// （面板 last_probe/「未探测」判定读的就是这个字段）。成功/失败都记。
test('buildProbeOne records unified.last_probe for codex slots on success and failure', async (t) => {
  const { root, vmId } = makeProject(t)
  const { buildProbeOne } = await import('../../src/lib/admin/panel-api.mjs')
  const calls = []
  for (const ok of [true, false]) {
    await buildProbeOne({
      cfg: { paths: { project: root } },
      accountQuota: { recordLastProbe: (accountId, probe) => calls.push({ accountId, probe }) },
      id: vmId,
      codexQuotaQuery: async () => ok ? { ok } : { ok, status: 502, error: 'usage_failed', message: 'Sample failed' },
    })
  }
  assert.deepEqual(calls.map(({ accountId, probe }) => ({
    accountId, ok: probe.ok, source: probe.source, error: probe.error,
  })), [
    { accountId: vmId, ok: true, source: 'vm-oauth-usage', error: undefined },
    { accountId: vmId, ok: false, source: 'vm-oauth-usage', error: 'Sample failed' },
  ])
  assert.ok(calls.every(({ probe }) => Number.isFinite(Date.parse(probe.at))))
})

// 流量随路轮换成功后，凭证文件的 expires_at 真值必须镜像回 vm.json 的
// codex.expires_at——否则面板与 needsScheduledRefresh 读导入时的陈旧快照，
// 显示「过期 14 天」的假死票（生产 vm-08/09 实测形态）。
test('a traffic-side rotation mirrors the fresh expires_at back onto vm.json', async (t) => {
  const { root, vmId } = makeProject(t)
  const stale = 1_700_000_000_000
  // 槽 json 先落一个陈旧快照（模拟导入后从未更新）
  const vmFile = path.join(root, 'vms', `${vmId}.json`)
  const vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
  vm.codex = { ...(vm.codex || {}), expires_at: stale }
  fs.writeFileSync(vmFile, JSON.stringify(vm))
  const fresh = Date.now() + 240 * 3600_000
  // usage 401 → rotate → token 端点 200 回新 AT（带 240h TTL）
  const fetchImpl = async (url) => {
    if (url === CHATGPT_USAGE_URL) {
      // 第一次 401 触发轮换；轮换后 run(current.access) 重打由外层模拟——
      // 这里直接给 401 后走 token 端点再给成功 usage
      return jsonResponse(401, {})
    }
    if (url === CODEX_OAUTH_TOKEN_URL) {
      return jsonResponse(200, { access_token: 'at-new', expires_in: Math.floor((fresh - Date.now()) / 1000) })
    }
    throw new Error(`unexpected url ${url}`)
  }
  await queryOpenaiQuota({ projectRoot: root, vmId, fetchImpl })
  // 轮换本身可能成功或后续 usage 再失败——都无关；断言镜像发生在轮换成功时
  const accounts = JSON.parse(fs.readFileSync(path.join(root, 'vms', vmId, 'codex-credentials.json'), 'utf8'))
  const onDisk = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
  assert.equal(accounts.accounts?.[0]?.access_token, 'at-new')
  assert.ok(onDisk.codex.expires_at > stale, 'mirror must replace the stale snapshot')
})
