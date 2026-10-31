import crypto from 'node:crypto'
import { makeProxyFetch } from '../protocol/codex-models.mjs'
import {
  codexSubscriptionAccountId,
  codexSubscriptionView,
  enrichCodexAccountIdentity,
  normalizeCodexSubscriptionPlan,
  readCodexAccounts,
} from '../vm/codex-slot.mjs'
import { getVm, isCodexVm } from '../vm/vm-registry.mjs'
import { hasBoundExit } from '../vm/egress.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { decodeJwtPayload } from './openai-jwt.mjs'

const MCP_URL = 'https://chatgpt.com/backend-api/product-account-links/mcp'
const PROTOCOL = '2025-03-26'
const OFFER_FRESHNESS_MS = 5 * 60_000
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

export function isProApiCreditPlan(value) {
  return ['prolite', 'pro', 'promax'].includes(String(normalizeCodexSubscriptionPlan(value) || '').toLowerCase())
}

export function isProApiCreditAccount(account = {}, vm = {}) {
  return isProApiCreditPlan(vm.codex?.plan_type || vm.plan_type || codexSubscriptionView(account, vm).plan_type)
}

function defaultView(proEligible = false) {
  return {
    pro_eligible: proEligible,
    claim_status: 'unknown',
    ineligibility_reason: null,
    offer: null,
    benefit: null,
    offer_checked_at: null,
    link_checked_at: null,
    offer_stale: false,
    destinations: [],
    organization_id: null,
    organization_name: null,
    enabled: false,
    has_key: false,
    key_suffix: null,
    setup_status: 'idle',
    balance: null,
    paid_balance: null,
    grants: [],
    next_expiring_amount: null,
    next_expiring_at: null,
    balance_checked_at: null,
    balance_error: null,
    last_error: null,
    browser_active: false,
  }
}

async function rpcPayload(response, id) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const messages = text
      .split(/\r?\n\r?\n/)
      .map((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n'),
      )
      .filter(Boolean)
      .map((data) => JSON.parse(data))
    return messages.find((value) => value.id === id) || null
  }
}

/** Promo tools use the slot's ChatGPT credential; Platform key management is separate. */
export class OpenaiApiCreditsService {
  constructor({ projectRoot, repo, fetchImpl, onLinked, now = Date.now } = {}) {
    this.projectRoot = projectRoot
    this.repo = repo
    this.fetchImpl = fetchImpl
    this.onLinked = onLinked
    this.now = now
    this.inflight = new Map()
  }

  accountForVm(vmId) {
    const vm = getVm(this.projectRoot, vmId)
    if (!vm) throw problem('vm_not_found', '账号槽位不存在', 404)
    if (!isCodexVm(vm)) throw problem('not_gpt_slot', '只有 GPT 账号支持 API 赠额')
    const account = enrichCodexAccountIdentity(readCodexAccounts(this.projectRoot, vmId)[0] || {})
    const accountId = codexSubscriptionAccountId(account) || vm.codex?.chatgpt_account_id || ''
    if (!accountId || accountId.startsWith('user-'))
      throw problem('api_account_required', '账号缺少 ChatGPT account_id')
    return { vm, account, accountId, record: this.repo.getAccount(accountId) }
  }

  view(vm) {
    if (!isCodexVm(vm)) return null
    let context
    try {
      context = this.accountForVm(vm.id)
    } catch {
      return defaultView(isProApiCreditPlan(vm.plan_type || vm.chatgpt_plan_type))
    }
    const { account, accountId, record } = context
    const value = defaultView(isProApiCreditAccount(account, context.vm))
    if (!record) return value
    const org = record.organization_id ? this.repo.getOrg(record.organization_id) : null
    const key = record.key_id ? this.repo.getKey(record.key_id) : null
    const keyOwned = !!key && key.source_account_id === accountId && key.source_vm_id === vm.id
    return {
      ...value,
      claim_status: record.claim_status,
      ineligibility_reason: record.ineligibility_reason,
      offer: record.offer,
      benefit: record.benefit,
      offer_checked_at: record.offer_checked_at || null,
      link_checked_at: record.link_checked_at || null,
      offer_stale: record.claim_status === 'eligible' && !this.freshOffer(record),
      destinations: record.destinations || [],
      organization_id: record.organization_id || null,
      organization_name: org?.display_name || null,
      enabled: record.enabled,
      has_key: keyOwned,
      key_suffix: keyOwned ? key.api_key.slice(-4) : null,
      setup_status: record.setup_status,
      balance: org?.balance ?? null,
      paid_balance: org?.paid_balance ?? null,
      grants: org?.grants || [],
      next_expiring_amount: org?.next_expiring_amount ?? null,
      next_expiring_at: org?.next_expiring_at || null,
      balance_checked_at: org?.balance_checked_at || null,
      balance_error: org?.balance_error || null,
      last_error: record.last_error,
    }
  }

  preview(vmId) {
    return this.exclusive(vmId, 'preview', () => this.previewAccount(vmId))
  }

  claim(vmId, { destination_account_id: destination } = {}) {
    return this.exclusive(vmId, 'claim', async () => {
      let context = this.promoContext(vmId)
      if (['pending', 'claimed'].includes(context.record?.claim_status)) {
        throw problem('api_promo_already_linked', '该账号已领取，后续按期自动发放', 409)
      }
      if (
        !context.record?.operation_id &&
        (!context.record || context.record.claim_status === 'unknown' || !this.freshOffer(context.record))
      ) {
        await this.previewAccount(vmId)
        context = this.promoContext(vmId)
      }
      if (['pending', 'claimed'].includes(context.record?.claim_status)) {
        throw problem('api_promo_already_linked', '该账号已领取，后续按期自动发放', 409)
      }
      if (context.record.claim_status !== 'eligible')
        throw problem('api_promo_ineligible', '当前账号没有可领取的 API 赠额', 409)
      const destinations = context.record.destinations || []
      const target = destination || (destinations.length === 1 ? destinations[0].destination_account_id : '')
      if (!target) throw problem('api_org_required', '请选择接收 API 赠额的组织')
      if (!destinations.some((row) => row.destination_account_id === target)) {
        throw problem('api_org_unknown', '所选组织不在可领取组织中')
      }
      // Keep one operation across transport failures and process restarts.
      const operationId = context.record.operation_id || crypto.randomUUID()
      if (context.record.operation_id && context.record.destination_account_id !== target) {
        throw problem('api_promo_operation_pending', '已有领取操作待确认，请先刷新状态', 409)
      }
      this.repo.upsertAccount(context.accountId, {
        vm_id: vmId,
        operation_id: operationId,
        destination_account_id: target,
        last_error: null,
      })
      return this.linkAccount(context, operationId, target)
    })
  }

  refreshClaim(vmId) {
    return this.exclusive(vmId, 'refreshClaim', async () => {
      const context = this.promoContext(vmId, { requirePro: false })
      if (context.record?.claim_status === 'claimed') return this.view(context.vm)
      if (!context.record?.operation_id || !context.record.destination_account_id) {
        if (!isProApiCreditAccount(context.account, context.vm)) return this.view(context.vm)
        return this.previewAccount(vmId)
      }
      return this.linkAccount(context, context.record.operation_id, context.record.destination_account_id)
    })
  }

  exclusive(vmId, kind, action) {
    const running = this.inflight.get(vmId)
    if (running) {
      if (running.kind === kind) return running.promise
      return Promise.reject(problem('api_promo_busy', '账号正在执行其他 API 赠额操作，请稍后重试', 409))
    }
    const pending = Promise.resolve()
      .then(action)
      .finally(() => this.inflight.delete(vmId))
    this.inflight.set(vmId, { kind, promise: pending })
    return pending
  }

  freshOffer(record) {
    const checkedAt = Date.parse(record?.offer_checked_at || '')
    const expiresAt = Date.parse(record?.offer?.expires_at || '')
    return (
      Number.isFinite(checkedAt) &&
      this.now() - checkedAt < OFFER_FRESHNESS_MS &&
      (!Number.isFinite(expiresAt) || expiresAt > this.now())
    )
  }

  promoContext(vmId, { requirePro = true } = {}) {
    const context = this.accountForVm(vmId)
    if (requirePro && !isProApiCreditAccount(context.account, context.vm)) {
      throw problem('api_promo_pro_required', '只有 Pro 账号可以查询并领取 API 赠额', 403)
    }
    if (!hasBoundExit(context.vm.proxy)) throw problem('proxy_required', '账号未绑定出口代理')
    if (!context.account.access_token) throw problem('no_access_token', '账号缺少 Access Token，请先刷新凭据')
    const exp = Number(decodeJwtPayload(context.account.access_token)?.exp) * 1000
    if (exp > 0 && exp <= Date.now()) throw problem('api_promo_access_expired', 'Access Token 已过期，请先刷新凭据')
    return context
  }

  async mcp(context) {
    context.proxyUrl = hostProxyUrlForVm(context.vm)
    const fetch = this.fetchImpl || makeProxyFetch(context.proxyUrl, 20_000)
    const headers = {
      authorization: `Bearer ${context.account.access_token}`,
      'ChatGPT-Account-Id': context.accountId,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      origin: 'https://chatgpt.com',
      referer: 'https://chatgpt.com/',
    }
    let nextId = 0
    const rpc = async (method, params, notification = false) => {
      this.ensureCurrent(context)
      const id = notification ? undefined : ++nextId
      const response = await fetch(MCP_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          ...(notification ? {} : { id }),
          method,
          ...(params === undefined ? {} : { params }),
        }),
      })
      const status = Number(response.status)
      if (status < 200 || status >= 300) throw problem('api_promo_upstream', `API 赠额服务返回 ${status}`, 502)
      if (notification) return null
      if (method === 'initialize') {
        const session = response.headers?.get?.('mcp-session-id')
        if (session) headers['Mcp-Session-Id'] = session
      }
      let value
      try {
        value = await rpcPayload(response, id)
      } catch {
        throw problem('api_promo_invalid_response', 'API 赠额服务未返回有效响应', 502)
      }
      if (value?.error || !value?.result)
        throw problem('api_promo_rpc_error', value?.error?.message || 'API 赠额服务调用失败', 502)
      if (value.result.isError) throw problem('api_promo_tool_error', 'API 赠额工具返回错误，请刷新后重试', 502)
      return value.result
    }
    const initialized = await rpc('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'vm2api', version: '1.0' },
    })
    headers['MCP-Protocol-Version'] = initialized.protocolVersion || PROTOCOL
    await rpc('notifications/initialized', undefined, true)
    return async (name, args = {}) => {
      const result = await rpc('tools/call', { name, arguments: args })
      if (result.structuredContent) return result.structuredContent
      try {
        return JSON.parse(result.content.find((item) => item.type === 'text').text)
      } catch {
        throw problem('api_promo_invalid_response', 'API 赠额工具缺少结果', 502)
      }
    }
  }

  ensureCurrent(context) {
    const current = this.accountForVm(context.vm.id)
    if (current.accountId !== context.accountId)
      throw problem('api_account_changed', '账号已更换，未写入旧账号结果', 409)
    if (!hasBoundExit(current.vm.proxy) || hostProxyUrlForVm(current.vm) !== context.proxyUrl)
      throw problem('api_proxy_changed', '账号代理已更换，请重新查询状态', 409)
  }

  async previewAccount(vmId) {
    const context = this.promoContext(vmId)
    try {
      const tool = await this.mcp(context)
      const preview = await tool('preview_api_credit_promo')
      const discovered = await tool('discover_api_orgs')
      this.ensureCurrent(context)
      const alreadyLinked = preview.ineligibility_reason === 'already_linked'
      const locked = ['pending', 'claimed'].includes(context.record?.claim_status)
      const claimStatus = locked
        ? context.record.claim_status
        : alreadyLinked
          ? 'claimed'
          : preview.eligible
            ? 'eligible'
            : 'ineligible'
      const record = this.repo.upsertAccount(context.accountId, {
        vm_id: vmId,
        claim_status: claimStatus,
        ineligibility_reason: preview.ineligibility_reason || null,
        offer: preview.offer || null,
        benefit: preview.benefit || context.record?.benefit || null,
        offer_checked_at: new Date(this.now()).toISOString(),
        ...(alreadyLinked ? { link_checked_at: new Date(this.now()).toISOString() } : {}),
        destinations: (discovered.destinations || []).filter((row) => row.destination_type === 'api_org'),
        last_error: null,
      })
      if (claimStatus === 'claimed') this.notifyLinked(vmId, record)
      return this.view(context.vm)
    } catch (error) {
      this.saveError(context, error)
      throw error
    }
  }

  async linkAccount(context, operationId, target) {
    try {
      const tool = await this.mcp(context)
      const linked = await tool('link_api_org', { destination_account_id: target, operation_id: operationId })
      this.ensureCurrent(context)
      if (linked.state !== 'active') throw problem('api_promo_link_inactive', 'API 组织关联尚未生效，请刷新状态', 502)
      const delivery = linked.delivery_result || { outcome: 'pending' }
      const organizationId = linked.destination_account_id || target
      const destination = (context.record?.destinations || []).find(
        (row) => row.destination_account_id === organizationId,
      )
      this.repo.upsertOrg(organizationId, {
        display_name: linked.destination_display_name || destination?.display_name || '',
      })
      const record = this.repo.upsertAccount(context.accountId, {
        vm_id: context.vm.id,
        organization_id: organizationId,
        claim_status: delivery.outcome === 'pending' ? 'pending' : 'claimed',
        ineligibility_reason: 'already_linked',
        delivery,
        link_checked_at: new Date(this.now()).toISOString(),
        benefit:
          context.record?.benefit ||
          (context.record?.offer
            ? {
                currency: context.record.offer.currency,
                cadence: context.record.offer.cadence,
                period_credit_amount_usd: context.record.offer.period_credit_amount_usd,
                expires_at: context.record.offer.expires_at,
              }
            : null),
        last_error: null,
      })
      if (record.claim_status === 'claimed') this.notifyLinked(context.vm.id, record)
      return this.view(context.vm)
    } catch (error) {
      this.saveError(context, error)
      throw error
    }
  }

  saveError(context, error) {
    this.repo.upsertAccount(context.accountId, {
      vm_id: context.vm.id,
      last_error: error.message || 'API 赠额查询失败',
    })
  }

  notifyLinked(vmId, record) {
    if (this.onLinked)
      Promise.resolve()
        .then(() => this.onLinked(vmId, record))
        .catch(() => {
          this.repo.upsertAccount(record.account_id, {
            setup_status: 'error',
            last_error: '自动配置 API 失败，请继续配置',
          })
        })
  }
}
