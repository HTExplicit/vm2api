import type { OpenaiApiView, Vm } from '@/types/panel-vm'
import { isCodexVm } from '@/lib/vm-kind'

/** Key ownership decides selection; balance and API switch remain independent. */
export function isOpenaiApiKeyCandidate(vm: Vm): boolean {
  return isCodexVm(vm) && !!vm.openai_api?.has_key
}

export function isOpenaiApiBalancePending(
  state?: OpenaiApiView | null,
  now = Date.now()
): boolean {
  if (state?.balance == null) return false
  if (state.balance_error) return true
  const interval = state.balance_refresh_interval_minutes ?? 10
  if (interval === 0) return false
  const checkedAt = Date.parse(state.balance_checked_at || '')
  return !Number.isFinite(checkedAt) || now - checkedAt >= interval * 60_000
}

export function openaiApiBalanceStatusText(
  state?: OpenaiApiView | null,
  now = Date.now()
): string {
  if (!state) return ''
  const labels = {
    queued: '排队中',
    refreshing: '刷新中',
    needs_login: '需要登录',
    error: '刷新失败',
  }
  const status = state.balance_refresh_status
  if (status && status !== 'idle') return labels[status]
  if (state.balance_error) return '刷新失败'
  if (state.balance_refresh_interval_minutes === 0) return ''
  return isOpenaiApiBalancePending(state, now) ? '等待刷新' : ''
}

export function openaiApiBalanceStatusMessage(
  state?: OpenaiApiView | null
): string {
  return state?.balance_refresh_message || state?.balance_error || ''
}

const PRO_PLANS = new Set([
  'prolite',
  'pro',
  'promax',
  'chatgptprolite',
  'chatgptpro',
  'chatgptpromax',
])

export function isProApiAccount(vm: Vm): boolean {
  if (!isCodexVm(vm)) return false
  return (
    vm.openai_api?.pro_eligible ??
    PRO_PLANS.has(
      String(vm.plan_type || vm.chatgpt_plan_type || '').toLowerCase()
    )
  )
}

export function openaiApiClaimLocked(state?: OpenaiApiView | null): boolean {
  return state?.claim_status === 'pending' || state?.claim_status === 'claimed'
}

export function hasOpenaiApiFeature(vm: Vm): boolean {
  return (
    isCodexVm(vm) &&
    (isProApiAccount(vm) ||
      !!vm.openai_api?.has_key ||
      openaiApiClaimLocked(vm.openai_api) ||
      vm.openai_api?.balance != null)
  )
}

export function openaiApiClaimLabel(state?: OpenaiApiView | null): string {
  if (state?.claim_status === 'pending') return '发放中'
  if (state?.claim_status === 'claimed') return '已领取，后续按期自动发放'
  if (state?.claim_status === 'eligible')
    return state.offer_stale ? '资格已过期，请重新查询' : '可以领取'
  if (state?.claim_status === 'ineligible') {
    return (
      {
        not_qualified: '当前订阅不符合领取条件',
        program_unavailable: '赠额权益暂不可用',
        no_remaining_benefit: '当前账期没有剩余赠额',
      }[state.ineligibility_reason || ''] || '当前不可领取'
    )
  }
  return '尚未查询领取资格'
}
