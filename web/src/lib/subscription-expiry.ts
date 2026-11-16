import type { Vm } from '@/types/panel-vm'
import { fmtExpiresAt } from '@/lib/format'
import { isCodexVm } from '@/lib/vm-kind'

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
