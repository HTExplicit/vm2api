import type {
  OpenaiApiBatchResult,
  OpenaiApiCallStatus,
  OpenaiApiKeyEntry,
  OpenaiApiKeyTarget,
} from '@/types/panel-openai-apikey'
import { formatBalanceAmount } from '@/lib/decimal-display'

export const CALL_STATUS_LABELS: Record<OpenaiApiCallStatus, string> = {
  ready: '可调度',
  disabled: '已关闭',
  upstream_disabled: '上游停用',
  rate_limited: '临时限流',
  quota_blocked: '额度阻断',
  invalid_key: 'key 无效',
  proxy_missing: '代理不可用',
  binding_error: '归属异常',
}

export const BATCH_STATUS_LABELS = {
  done: '已完成',
  queued: '已排队',
  error: '失败',
} as const

export function targetId(item: OpenaiApiKeyTarget): string {
  return JSON.stringify([item.vm_id, item.account_id])
}

export function maskedKey(prefix?: string | null): string {
  return prefix?.length === 12 ? `${prefix}…` : '••••••••'
}

export function proxyAddress(proxy: OpenaiApiKeyEntry['proxy']): string {
  return proxy?.host && proxy.port ? `${proxy.host}:${proxy.port}` : ''
}

export function proxyName(proxy: OpenaiApiKeyEntry['proxy']): string {
  return proxy?.name || proxyAddress(proxy) || '未绑定'
}

export function proxyDescription(proxy: OpenaiApiKeyEntry['proxy']): string {
  return [
    ...new Set([proxyName(proxy), proxyAddress(proxy)].filter(Boolean)),
  ].join(' · ')
}

export function balanceText(balance: string | null): string {
  return balance == null ? '未知' : `$${formatBalanceAmount(balance)}`
}

export function filterApiKeys(
  items: OpenaiApiKeyEntry[],
  search: string,
  enabled: 'all' | 'on' | 'off',
  status: OpenaiApiCallStatus | 'all'
): OpenaiApiKeyEntry[] {
  const term = search.trim().toLocaleLowerCase()
  return items.filter((item) => {
    if (enabled !== 'all' && item.enabled !== (enabled === 'on')) return false
    if (status !== 'all' && item.call_status !== status) return false
    return (
      !term ||
      [
        item.vm_id,
        item.slot_name,
        item.email,
        item.organization_id,
        item.organization_name,
      ].some((value) =>
        String(value || '')
          .toLocaleLowerCase()
          .includes(term)
      )
    )
  })
}

export function batchSummary(results: OpenaiApiBatchResult[]): string {
  const count = { done: 0, queued: 0, error: 0 }
  for (const row of results) count[row.status]++
  return `已完成 ${count.done} · 已排队 ${count.queued} · 失败 ${count.error}`
}

export function apiKeyUrl(item: OpenaiApiKeyTarget): string {
  return `/api/panel/vms/${encodeURIComponent(item.vm_id)}/openai-api/key`
}
