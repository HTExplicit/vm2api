import { hasBoundExit, isLocalEgressProxy, localEgressNodeId } from '../vm/egress.mjs'
import { publicAllocatedProxy } from './panel-api.mjs'

export function isAccountApiKey(key) {
  return !!(key?.source_account_id || key?.source_vm_id)
}

export function hasAccountApiKeys(endpoint) {
  return (endpoint?.api_key_entries || []).some(isAccountApiKey)
}

/** Management projections must not remove the runtime's account keys. */
export function ordinaryEndpointView(endpoint) {
  if (!endpoint) return null
  const keys = endpoint.api_key_entries || []
  const ordinary = keys.filter((key) => !isAccountApiKey(key))
  if (keys.length && !ordinary.length) return null
  return { ...endpoint, api_key_entries: ordinary }
}

export function accountApiManagedError(code = 'account_api_key_managed') {
  return Object.assign(new Error('账号托管 API key 请在 OpenAi_api 页面管理'), { code, status: 400 })
}

export function requireAccountIdentity(value) {
  const accountId = String(value || '').trim()
  if (!accountId)
    throw Object.assign(new Error('请提供当前账号身份'), { code: 'account_identity_required', status: 400 })
  return accountId
}

function accountProxyView(vm, { proxyPool, nodes = [] }) {
  const bound = vm.proxy
  const nodeId = vm.node_id || localEgressNodeId(bound?.id)
  const view = publicAllocatedProxy(proxyPool, bound, { nodeId, role: 'admin', nodes })
  const available = hasBoundExit(bound) || hasBoundExit(view)
  const registered = proxyPool?.state?.proxies?.some((row) => row.id === bound?.id)
  const label = String(view?.label || (!registered && (bound?.label || bound?.name)) || '').trim() || null
  let host = view?.host || null
  let port = view?.port ?? null
  if (!host && bound?.url) {
    try {
      const address = new URL(bound.url)
      host = address.hostname
      port = address.port ? Number(address.port) : null
    } catch {}
  }
  const local = isLocalEgressProxy(view) || isLocalEgressProxy(bound)
  const address = host
    ? `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${port == null ? '' : `:${port}`}`
    : null
  const nodeName = view?.node_name
  const name = local
    ? nodeName
      ? `${nodeName}local代理`
      : '当前VPS local代理'
    : label || address || (available ? '地址未知' : '未绑定')
  return {
    id: view?.id || null,
    name,
    label,
    host,
    port,
    scheme: local ? 'local' : view?.scheme || 'socks5',
    kind: local ? 'local' : view?.kind || 'socks5',
    ...(local ? { node_name: view?.node_name || null } : {}),
    available,
  }
}

export function buildOpenaiApiKeyList(vms, manager, usageRepo, timezone, proxyOptions = {}) {
  const items = []
  const bind_candidates = []
  for (const vm of vms) {
    const state = manager?.view(vm)
    if (!state?.account_id) continue
    const identity = {
      vm_id: vm.id,
      account_id: state.account_id,
      email: state.email || '',
      slot_name: vm.name || vm.display_name || vm.id,
    }
    if (!state.has_key) {
      if (state.claim_status === 'pending' || state.claim_status === 'claimed')
        bind_candidates.push({ ...identity, claim_status: state.claim_status })
      continue
    }
    items.push({
      ...state,
      ...identity,
      proxy: accountProxyView(vm, proxyOptions),
    })
  }
  const stats =
    usageRepo?.accountApiUsage?.(
      items.map((item) => item.account_id),
      Date.now(),
      timezone,
    ) || new Map()
  return {
    items: items.map((item) => ({
      ...item,
      ...(stats.get(item.account_id) || {
        today_requests: 0,
        today_cost: 0,
        last_used_at: null,
        unpriced_requests: 0,
      }),
    })),
    bind_candidates,
  }
}

const BATCH_ACTIONS = new Set(['enable', 'disable', 'refresh_balance', 'delete', 'resume'])

export async function runOpenaiApiKeyBatch(manager, { action, items } = {}) {
  if (!BATCH_ACTIONS.has(action) || !Array.isArray(items) || !items.length)
    throw Object.assign(new Error('请选择操作和账号'), { code: 'invalid_batch_operation', status: 400 })
  const results = []
  const refreshedOrgs = new Map()
  for (const item of items) {
    const vmId = String(item?.vm_id || '').trim()
    const identity = { vm_id: vmId, account_id: String(item?.account_id || '').trim() }
    try {
      const account_id = requireAccountIdentity(identity.account_id)
      const context = manager.assertAccountIdentity(vmId, account_id)
      let result
      let status = 'done'
      if (action === 'enable' || action === 'disable')
        result = await manager.setEnabled(vmId, action === 'enable', { account_id })
      else if (action === 'delete') result = await manager.removeKey(vmId, { account_id })
      else if (action === 'resume') result = await manager.resume(vmId, { account_id })
      else {
        const org = context.record?.organization_id
        if (org && refreshedOrgs.has(org)) {
          status = refreshedOrgs.get(org)
          result = manager.view(context.vm)
        } else {
          result = await manager.refresh(vmId)
          status = manager.jobs.has(vmId) ? 'queued' : 'done'
          if (org) refreshedOrgs.set(org, status)
        }
      }
      results.push({ ...identity, status, item: result })
    } catch (error) {
      results.push({
        ...identity,
        status: 'error',
        error: { code: error.code || 'openai_api_failed', message: error.message },
      })
    }
  }
  return { results }
}
