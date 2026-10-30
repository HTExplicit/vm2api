import path from 'node:path'
import { normalizeTimezone, zonedParts } from '../core/timezone.mjs'
import { makeProxyFetch } from '../protocol/codex-models.mjs'
import { decodeJwtPayload } from './openai-jwt.mjs'
import { captureOpenaiAuth, isOpenaiAuthCurrent, recordOpenaiAuthResult } from './openai-auth-state.mjs'
import {
  codexSubscriptionAccountId,
  codexSubscriptionView,
  enrichCodexAccountIdentity,
  normalizeCodexSubscriptionPlan,
  readCodexAccounts,
} from '../vm/codex-slot.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { getVm, isCodexVm } from '../vm/vm-registry.mjs'

const ACCOUNT_CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'
const SUBSCRIPTIONS_URL = 'https://chatgpt.com/backend-api/subscriptions'
const RETRY_MS = 30 * 60_000
const inflight = new Map()

function until(value) {
  if (value == null || value === '') return null
  const numeric = typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : null
  const ms = numeric == null ? Date.parse(String(value)) : numeric < 1e12 ? numeric * 1000 : numeric
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null
}

function failure(error, message, status = 502) {
  return { ok: false, error, message, status }
}

function accountFromCheck(payload, accountId) {
  const accounts = payload?.accounts
  if (accounts && !Array.isArray(accounts) && accounts[accountId]) return accounts[accountId]
  const records = Array.isArray(accounts) ? accounts : Object.values(accounts || {})
  return records.find((row) =>
    [row, row?.account].some((account) =>
      ['id', 'account_id', 'chatgpt_account_id', 'workspace_id'].some((key) => account?.[key] === accountId),
    ),
  )
}

async function request(fetch, url, accessToken, auth) {
  const response = await fetch(url.href, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      referer: 'https://chatgpt.com/',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'x-openai-target-path': url.pathname,
      'x-openai-target-route': url.pathname,
    },
  })
  if (response.status === 401) {
    recordOpenaiAuthResult(auth, {
      status: 401,
      source: 'subscription',
      message: '订阅查询认证失败（401），请先刷新凭据',
    })
  }
  if (response.status < 200 || response.status >= 300) {
    const status = Number(response.status) || 0
    throw failure(
      status === 401 ? 'subscription_upstream_auth' : 'subscription_upstream_error',
      status === 401
        ? '订阅查询认证失败（401），请先刷新凭据'
        : status === 403
          ? '订阅查询被上游拒绝（403），保留原日期'
          : `订阅查询上游返回 ${status}`,
    )
  }
  try {
    return await response.json()
  } catch {
    throw failure('subscription_invalid_response', '订阅查询未返回有效 JSON，保留原日期')
  }
}

async function refresh({ projectRoot, vmId, force, fetchImpl, now }) {
  const vm = getVm(projectRoot, vmId)
  if (!vm) return { ...failure('vm_not_found', 'VM not found', 404), vm_id: vmId, subscription: null }
  if (!isCodexVm(vm)) {
    return { ...failure('not_gpt_slot', '只有 GPT 槽支持查询订阅', 400), vm_id: vmId, subscription: null }
  }
  const account = enrichCodexAccountIdentity(readCodexAccounts(projectRoot, vmId)[0] || {})
  const current = codexSubscriptionView(account, vm)
  const accountId = codexSubscriptionAccountId(account)
  const auth = captureOpenaiAuth(projectRoot, vmId, account)
  const result = (data) => ({ ...data, vm_id: vmId, subscription: current })
  if (!account.access_token) return result(failure('no_access_token', 'GPT 槽没有 access_token', 400))
  if (!accountId) return result(failure('subscription_account_required', '凭证缺少 ChatGPT account_id', 400))
  if (!force && (Date.parse(current.active_until || '') > now || Date.parse(current.next_retry_at || '') > now)) {
    return result({ ok: true })
  }
  const stamp = new Date(now).toISOString()
  let snapshot
  let error = null
  try {
    const expiresAt = Number(decodeJwtPayload(account.access_token)?.exp) * 1000
    if (expiresAt > 0 && expiresAt <= now) {
      throw failure('subscription_access_expired', 'Access Token 已过期，请先刷新凭据', 400)
    }
    const proxyUrl = hostProxyUrlForVm(vm)
    if (!fetchImpl && !proxyUrl && !isLocalEgressProxy(vm.proxy)) {
      throw failure('proxy_required', 'GPT 槽未绑定出口代理', 400)
    }
    const fetch = fetchImpl || makeProxyFetch(proxyUrl, 15_000)
    const checkUrl = new URL(ACCOUNT_CHECK_URL)
    const wall = zonedParts(now, normalizeTimezone(vm.timezone))
    const local = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
    checkUrl.searchParams.set(
      'timezone_offset_min',
      String(Math.round((Math.floor(now / 60_000) * 60_000 - local) / 60_000)),
    )
    const checked = await request(fetch, checkUrl, account.access_token, auth)
    const record = accountFromCheck(checked, accountId)
    if (!record) throw failure('subscription_account_mismatch', '订阅查询未返回当前账号，保留原日期')
    recordOpenaiAuthResult(auth, { authenticated: true, source: 'subscription' })
    snapshot = {
      active_until: until(record.entitlement?.expires_at ?? record.account?.expires_at ?? record.expires_at),
      plan_type: normalizeCodexSubscriptionPlan(
        record.entitlement?.subscription_plan ?? record.account?.plan_type ?? record.plan_type,
      ),
      source: 'accounts_check',
    }
    if (!snapshot.active_until || Date.parse(snapshot.active_until) <= now) {
      const url = new URL(SUBSCRIPTIONS_URL)
      url.searchParams.set('account_id', accountId)
      const body = await request(fetch, url, account.access_token, auth)
      if (body && typeof body === 'object') {
        recordOpenaiAuthResult(auth, { authenticated: true, source: 'subscription' })
      }
      snapshot = {
        active_until: until(body.active_until ?? body.expires_at),
        plan_type: normalizeCodexSubscriptionPlan(body.subscription_plan ?? body.plan_type) || snapshot.plan_type,
        source: 'subscriptions',
      }
    }
    if (!snapshot.active_until) throw failure('subscription_date_missing', '订阅接口未返回有效日期，保留原日期')
  } catch (caught) {
    error = caught?.error
      ? caught
      : failure(
          caught?.name === 'AbortError' ? 'subscription_timeout' : 'subscription_fetch_failed',
          caught?.name === 'AbortError' ? '订阅查询超时，保留原日期' : '订阅查询失败，保留原日期',
        )
  }

  // Re-read after I/O: the same slot may have received a different account while querying.
  const latest = getVm(projectRoot, vmId)
  const latestAccount = enrichCodexAccountIdentity(readCodexAccounts(projectRoot, vmId)[0] || {})
  if (!latest || codexSubscriptionAccountId(latestAccount) !== accountId || !isOpenaiAuthCurrent(auth)) {
    return result(failure('subscription_account_changed', '账号或凭据已更新，未写入旧查询结果', 409))
  }
  const previous = latest.codex?.subscription?.account_id === accountId ? latest.codex.subscription : {}
  latest.codex = { ...(latest.codex || {}) }
  latest.codex.subscription = error
    ? {
        ...previous,
        account_id: accountId,
        active_until: previous.active_until || null,
        plan_type: previous.plan_type || null,
        source: previous.source || null,
        last_attempt_at: stamp,
        last_success_at: previous.last_success_at || null,
        next_retry_at: new Date(now + RETRY_MS).toISOString(),
        last_error: error.message,
      }
    : {
        account_id: accountId,
        ...snapshot,
        last_attempt_at: stamp,
        last_success_at: stamp,
        next_retry_at: Date.parse(snapshot.active_until) <= now ? new Date(now + RETRY_MS).toISOString() : null,
        last_error: null,
      }
  latest.updated_at = stamp
  atomicWriteJson(path.join(projectRoot, 'vms', `${vmId}.json`), latest, { mode: 0o600 })
  return {
    ...(error || { ok: true }),
    vm_id: vmId,
    subscription: codexSubscriptionView(latestAccount, latest),
  }
}

export function refreshOpenaiSubscription({ projectRoot, vmId, force = false, fetchImpl, now = Date.now() } = {}) {
  const key = path.join(projectRoot, 'vms', String(vmId))
  if (inflight.has(key)) return inflight.get(key)
  const pending = refresh({ projectRoot, vmId, force, fetchImpl, now }).finally(() => inflight.delete(key))
  inflight.set(key, pending)
  return pending
}
