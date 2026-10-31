import type { OpenaiApiView, Vm } from '@/types/panel-vm'
import { isCodexVm } from '@/lib/vm-kind'

const API_BALANCE_MAX_AGE = 10 * 60_000

/** The last successful sample decides selection; subscription tier and API switch do not. */
export function isOpenaiApiKeyCandidate(vm: Vm): boolean {
  const balance = vm.openai_api?.balance?.trim()
  return (
    isCodexVm(vm) &&
    !!vm.openai_api?.has_key &&
    !!balance &&
    /^\+?\d+(?:\.\d+)?$/.test(balance) &&
    /[1-9]/.test(balance)
  )
}

export function isOpenaiApiBalancePending(
  state?: OpenaiApiView | null,
  now = Date.now()
): boolean {
  if (state?.balance == null) return false
  const checkedAt = Date.parse(state.balance_checked_at || '')
  return (
    !!state.balance_error ||
    !Number.isFinite(checkedAt) ||
    now - checkedAt >= API_BALANCE_MAX_AGE
  )
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
