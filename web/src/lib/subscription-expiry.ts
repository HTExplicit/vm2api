import type { Vm } from '@/types/panel-vm'
import { expiresAtToMs } from '@/lib/fable-status'
import { fmtExpiresAt } from '@/lib/format'
import { isCodexVm } from '@/lib/vm-kind'

export type SubscriptionTone = 'muted' | 'warn' | 'bad'

const NEAR_DAYS = 7

export function subscriptionInfoTitle(vm: Vm): string {
  if (!isCodexVm(vm)) return 'Claude 没有上游订阅到期字段'
  const info = vm.subscription
  const source =
    info?.source === 'accounts_check' || info?.source === 'subscriptions'
      ? '来源：查询结果'
      : vm.chatgpt_subscription_active_until
        ? '来源：凭证'
        : '订阅日期尚未获取'
  return [
    source,
    info?.last_success_at &&
      `最近成功查询：${fmtExpiresAt(info.last_success_at)}`,
    info?.last_error && `最近查询失败：${info.last_error}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** List/rack label uses the subscription date resolved by the panel. */
export function subscriptionListLabel(
  vm: Vm,
  now: number
): { text: string; title: string; tone: SubscriptionTone } {
  const unknown = {
    text: '订阅 未知',
    title: subscriptionInfoTitle(vm),
    tone: 'muted' as const,
  }
  if (!isCodexVm(vm)) return unknown
  const raw = vm.chatgpt_subscription_active_until
  const ms = expiresAtToMs(raw)
  if (!raw || !ms) return unknown
  const date = new Date(ms)
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  if (ms <= now) {
    return {
      text: `订阅 ${stamp} 已过期`,
      title: subscriptionInfoTitle(vm),
      tone: 'bad',
    }
  }
  const days = Math.ceil((ms - now) / 86_400_000)
  return {
    text: `订阅 ${stamp} · ${days}d`,
    title: subscriptionInfoTitle(vm),
    tone: days <= NEAR_DAYS ? 'warn' : 'muted',
  }
}
