import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { refreshOpenaiSubscription } from '../../src/lib/oauth/openai-subscription.mjs'
import { queryOpenaiQuota } from '../../src/lib/oauth/openai-quota.mjs'
import { captureOpenaiAuth, recordOpenaiAuthResult } from '../../src/lib/oauth/openai-auth-state.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { readCodexAccounts, summarizeCodexSlot, writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'

const NOW = Date.parse('2026-10-31T00:00:00Z')
const CLAIM_UNTIL = '2027-01-01T00:00:00Z'
const API_UNTIL = '2027-06-01T12:00:00.000Z'
const ACCOUNT_ID = 'account-subscription'

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function fixture(t, { codex = {}, proxy = { url: 'socks5h://127.0.0.1:1080' } } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-subscription-'))
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  const vmId = 'vm-subscription'
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  fs.mkdirSync(path.join(projectRoot, 'vms', vmId), { recursive: true })
  atomicWriteJson(file, {
    id: vmId,
    platform: 'openai',
    family: 'codex',
    timezone: 'Asia/Singapore',
    status: 'stopped',
    proxy,
    codex,
  })
  writeCodexAccounts(projectRoot, vmId, [
    {
      access_token: jwt({ exp: NOW / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID } }),
      id_token: jwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: ACCOUNT_ID,
          chatgpt_subscription_active_until: CLAIM_UNTIL,
          chatgpt_plan_type: 'plus',
        },
      }),
      refresh_token: 'fixture-refresh-secret',
      chatgpt_account_id: ACCOUNT_ID,
    },
  ])
  return {
    projectRoot,
    vmId,
    file,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    options: { projectRoot, vmId, now: NOW },
  }
}

function response(status, payload) {
  return { status, json: async () => payload }
}

function accountCheck(until = API_UNTIL) {
  return {
    accounts: {
      'another-workspace': { account: { account_id: 'another-workspace' }, entitlement: { expires_at: '2039-01-01' } },
      [ACCOUNT_ID]: {
        account: { account_id: ACCOUNT_ID },
        entitlement: { expires_at: until, subscription_plan: 'chatgptpro' },
      },
    },
  }
}

test('subscription query selects the current account and keeps its API date ahead of the old ID token', async (t) => {
  const slot = fixture(t)
  const credentialsBefore = readCodexAccounts(slot.projectRoot, slot.vmId)
  const calls = []
  const result = await refreshOpenaiSubscription({
    ...slot.options,
    force: true,
    fetchImpl: async (rawUrl, init) => {
      const url = new URL(rawUrl)
      calls.push(url)
      assert.equal(init.method, 'GET')
      assert.equal(url.pathname, '/backend-api/accounts/check/v4-2023-04-27')
      assert.equal(url.searchParams.get('timezone_offset_min'), '-480')
      assert.match(init.headers.authorization, /^Bearer header\./)
      assert.match(init.headers['user-agent'], /Chrome\/147\./)
      assert.equal(init.headers.referer, 'https://chatgpt.com/')
      assert.equal(init.headers['x-openai-target-path'], url.pathname)
      assert.equal(init.headers['x-openai-target-route'], url.pathname)
      assert.equal(init.headers.originator, undefined)
      return response(200, accountCheck())
    },
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(result.subscription.active_until, API_UNTIL)
  assert.equal(result.subscription.source, 'accounts_check')
  assert.equal(result.subscription.plan_type, 'pro')
  assert.equal(result.subscription.account_id, undefined)
  const summary = summarizeCodexSlot(slot.projectRoot, slot.read())
  assert.equal(summary.chatgpt_subscription_active_until, API_UNTIL)
  assert.equal(summary.plan_type, 'pro')
  assert.deepEqual(
    readCodexAccounts(slot.projectRoot, slot.vmId),
    credentialsBefore,
    'query does not rotate or rewrite tokens',
  )
})

test('missing or past dates use subscriptions with the same account ID', async (t) => {
  for (const until of [null, '2026-01-01T00:00:00Z']) {
    const slot = fixture(t)
    const paths = []
    const result = await refreshOpenaiSubscription({
      ...slot.options,
      force: true,
      fetchImpl: async (rawUrl) => {
        const url = new URL(rawUrl)
        paths.push(url.pathname)
        if (paths.length === 1) return response(200, accountCheck(until))
        assert.equal(url.searchParams.get('account_id'), ACCOUNT_ID)
        return response(200, { active_until: API_UNTIL, plan_type: 'pro' })
      },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(paths, ['/backend-api/accounts/check/v4-2023-04-27', '/backend-api/subscriptions'])
    assert.equal(result.subscription.source, 'subscriptions')
    assert.equal(result.subscription.active_until, API_UNTIL)
  }
})

test('another workspace cannot supply the subscription date', async (t) => {
  const slot = fixture(t)
  let calls = 0
  const result = await refreshOpenaiSubscription({
    ...slot.options,
    force: true,
    fetchImpl: async () => {
      calls += 1
      return response(200, { accounts: { other: { entitlement: { expires_at: API_UNTIL } } } })
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'subscription_account_mismatch')
  assert.equal(calls, 1)
  assert.equal(result.subscription.active_until, CLAIM_UNTIL)

  writeCodexAccounts(slot.projectRoot, slot.vmId, [
    {
      access_token: jwt({ exp: NOW / 1000 + 3600, 'https://api.openai.com/auth': { user_id: 'user-oauth-only' } }),
    },
  ])
  const userOnly = await refreshOpenaiSubscription({
    ...slot.options,
    force: true,
    fetchImpl: async () => {
      throw new Error('OAuth user id must not reach the subscription endpoint')
    },
  })
  assert.equal(userOnly.error, 'subscription_account_required')
})

test('403 preserves the previous snapshot and delays automatic retry without exchanging credentials', async (t) => {
  const previousUntil = '2026-10-01T00:00:00.000Z'
  const slot = fixture(t, {
    codex: {
      subscription: { account_id: ACCOUNT_ID, active_until: previousUntil, source: 'accounts_check' },
    },
  })
  let calls = 0
  const fetchImpl = async (rawUrl) => {
    calls += 1
    assert.equal(new URL(rawUrl).pathname, '/backend-api/accounts/check/v4-2023-04-27')
    return response(403, {})
  }
  const result = await refreshOpenaiSubscription({ ...slot.options, force: true, fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.subscription.active_until, previousUntil)
  assert.equal(result.subscription.next_retry_at, new Date(NOW + 30 * 60_000).toISOString())
  assert.match(result.subscription.last_error, /403/)
  assert.equal(slot.read().codex.auth_block, undefined)
  await refreshOpenaiSubscription({ ...slot.options, now: NOW + 60_000, fetchImpl })
  assert.equal(calls, 1)
})

test('upstream 401 persists an authentication block without returning a panel-login 401', async (t) => {
  const slot = fixture(t)
  const result = await refreshOpenaiSubscription({
    ...slot.options,
    force: true,
    fetchImpl: async () => response(401, {}),
  })
  assert.equal(result.ok, false)
  assert.notEqual(result.status, 401)
  assert.match(result.message, /刷新凭据/)
  const block = slot.read().codex.auth_block
  assert.equal(block.account_id, ACCOUNT_ID)
  assert.equal(block.status, 401)
  assert.equal(block.source, 'subscription')
  assert.equal(block.reason, 'upstream_401')
})

test('a valid Free account clears the authentication block even without a subscription date', async (t) => {
  const slot = fixture(t)
  recordOpenaiAuthResult(captureOpenaiAuth(slot.projectRoot, slot.vmId), { status: 401, source: 'inference' })
  const checked = accountCheck(null)
  checked.accounts[ACCOUNT_ID].entitlement.subscription_plan = 'free'
  const result = await refreshOpenaiSubscription({
    ...slot.options,
    force: true,
    fetchImpl: async (rawUrl) => response(200, new URL(rawUrl).pathname.includes('/accounts/check/') ? checked : {}),
  })
  assert.equal(result.error, 'subscription_date_missing')
  assert.equal(result.subscription.active_until, CLAIM_UNTIL)
  assert.equal(slot.read().codex.auth_block, undefined)
})

test('expired access saves subscription retry metadata without blocking a refreshable account', async (t) => {
  const slot = fixture(t)
  const account = readCodexAccounts(slot.projectRoot, slot.vmId)[0]
  writeCodexAccounts(slot.projectRoot, slot.vmId, [
    {
      ...account,
      access_token: jwt({ exp: NOW / 1000 - 1, 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID } }),
    },
  ])
  const result = await refreshOpenaiSubscription({
    ...slot.options,
    force: true,
    fetchImpl: async () => assert.fail('expired access must not query or exchange tokens'),
  })
  assert.equal(result.error, 'subscription_access_expired')
  assert.equal(result.subscription.last_attempt_at, new Date(NOW).toISOString())
  assert.equal(result.subscription.next_retry_at, new Date(NOW + 30 * 60_000).toISOString())
  assert.match(result.subscription.last_error, /Access Token 已过期/)
  assert.equal(slot.read().codex.auth_block, undefined)
  assert.equal(readCodexAccounts(slot.projectRoot, slot.vmId)[0].refresh_token, account.refresh_token)
})

test('concurrent refreshes share a request and discard its result after the slot changes account', async (t) => {
  const slot = fixture(t)
  let release
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const pending = new Promise((resolve) => {
    release = resolve
  })
  let calls = 0
  const options = {
    ...slot.options,
    force: true,
    fetchImpl: async () => {
      calls += 1
      started()
      await pending
      return response(200, accountCheck())
    },
  }
  const first = refreshOpenaiSubscription(options)
  await ready
  const second = refreshOpenaiSubscription(options)
  writeCodexAccounts(slot.projectRoot, slot.vmId, [
    { access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'replacement-account' } }) },
  ])
  release()
  const results = await Promise.all([first, second])
  assert.equal(calls, 1)
  for (const result of results) assert.equal(result.error, 'subscription_account_changed')
  assert.equal(slot.read().codex.subscription, undefined)
})

test('replacing an imported account clears the old subscription snapshot', async (t) => {
  const slot = fixture(t, {
    proxy: null,
    codex: { subscription: { account_id: ACCOUNT_ID, active_until: API_UNTIL, source: 'accounts_check' } },
  })
  let status
  const handle = createPanelHandler({
    cfg: { paths: { project: slot.projectRoot } },
    routingConfig: { codex: { catalog_client_version: '0.160.0' } },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      return true
    },
    readBody: async () => ({
      vm_id: slot.vmId,
      mode: 'access_token',
      raw: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'new-imported-account' } }),
    }),
    json(_res, code) {
      status = code
      return true
    },
  })
  await handle({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/import'))
  assert.equal(status, 200)
  assert.equal(slot.read().codex.subscription, undefined)
})

test('a failed subscription supplement does not fail successful quota refresh', async (t) => {
  for (const status of [403, 401]) {
    const slot = fixture(t)
    writeCodexAccounts(slot.projectRoot, slot.vmId, [
      {
        access_token: jwt({
          exp: Date.now() / 1000 + 3600,
          'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID },
        }),
        chatgpt_account_id: ACCOUNT_ID,
      },
    ])
    recordOpenaiAuthResult(captureOpenaiAuth(slot.projectRoot, slot.vmId), { status: 401, source: 'inference' })
    const calls = []
    const result = await queryOpenaiQuota({
      projectRoot: slot.projectRoot,
      vmId: slot.vmId,
      fetchImpl: async (rawUrl) => {
        const pathname = new URL(rawUrl).pathname
        calls.push(pathname)
        if (pathname.endsWith('/usage'))
          return response(200, {
            plan_type: 'pro',
            rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
          })
        if (pathname.endsWith('/rate-limit-reset-credits')) return response(200, { available_count: 0, credits: [] })
        assert.equal(slot.read().codex.auth_block, undefined, 'quota success has recovered the previous block')
        return response(status, {})
      },
    })
    assert.equal(result.ok, true)
    assert.ok(calls.includes('/backend-api/accounts/check/v4-2023-04-27'))
    assert.match(slot.read().codex.subscription.last_error, new RegExp(String(status)))
    assert.equal(slot.read().codex.auth_block?.status, status === 401 ? 401 : undefined)
    if (status === 401) assert.equal(slot.read().codex.auth_block.source, 'subscription')
  }
})
