import { hasBoundExit } from '../vm/egress.mjs'

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
  return Object.assign(new Error('账号托管 API key 请在 OpenAiAPIKEY 页面管理'), { code, status: 400 })
}

export function requireAccountIdentity(value) {
  const accountId = String(value || '').trim()
  if (!accountId)
    throw Object.assign(new Error('请提供当前账号身份'), { code: 'account_identity_required', status: 400 })
  return accountId
}

export function buildOpenaiApiKeyList(vms, manager, usageRepo, timezone) {
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
      proxy: {
        id: vm.proxy?.id || null,
        name: vm.proxy?.name || vm.proxy?.label || vm.proxy?.id || '未绑定',
        available: hasBoundExit(vm.proxy),
      },
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
