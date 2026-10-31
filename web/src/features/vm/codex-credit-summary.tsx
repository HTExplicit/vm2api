import type { Vm } from '@/types/panel-vm'
import { trimDecimalZeros } from '@/lib/decimal-display'
import { fmtExpiresAt } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { hasOpenaiApiFeature } from '@/features/vm/openai-api-state'

/** Balance credits are separate from the reset vouchers below the quota windows. */
export function CodexCreditSummary({
  vm,
  compact = false,
  className,
}: {
  vm: Vm
  compact?: boolean
  className?: string
}) {
  if (!isCodexVm(vm)) return null
  const showApi = hasOpenaiApiFeature(vm)
  if (!vm.has_token && !showApi) return null
  const credits = vm.codex_credits
  const status = credits?.status || 'unknown'
  const pending = status === 'pending'
  const known = status !== 'unknown' && credits != null
  const value = known
    ? credits.unlimited
      ? '不限额'
      : credits.balance != null
        ? `${trimDecimalZeros(credits.balance)} 点`
        : '未知'
    : '未知'
  const label = `${pending ? '历史余额' : '余额'} ${value}`
  const unavailable = status === 'unavailable'
  const state = pending ? '待确认' : unavailable ? '点数不可用' : ''
  const capped =
    vm.codex_usage?.windows?.some(
      (window) => window.used_percent != null && window.used_percent >= 100
    ) ||
    (vm.utilization_5h != null && vm.utilization_5h >= 1) ||
    (vm.utilization_7d != null && vm.utilization_7d >= 1)
  const spending =
    status === 'available' && capped ? '订阅额度已满，可使用点数' : ''
  const facts = [
    label,
    state,
    spending,
    credits?.fetched_at
      ? `最近余额采样：${fmtExpiresAt(credits.fetched_at)}`
      : '尚无余额样本',
    vm.codex_credits_checked_at
      ? `最近检查：${fmtExpiresAt(vm.codex_credits_checked_at)}`
      : '',
    pending ? '余额状态待确认，历史样本不代表当前可用点数。' : '',
    status === 'available'
      ? '点数可用；账号仍受认证、人工额度阈值和其他调度条件约束。'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  const apiState = vm.openai_api
  const apiLabel = `API ${apiState?.balance != null ? `$${trimDecimalZeros(apiState.balance)}` : '未知'}`
  const apiFacts = [
    apiLabel,
    apiState?.organization_name ? `组织：${apiState.organization_name}` : '',
    '组织总可用余额，包括赠额和购买余额。',
    apiState?.balance_checked_at
      ? `最近刷新：${fmtExpiresAt(apiState.balance_checked_at)}`
      : '尚无 API 余额样本',
    apiState?.balance_error ? `待刷新：${apiState.balance_error}` : '',
    apiState?.benefit
      ? `每${apiState.benefit.cadence === 'annual' ? '年' : '月'}权益：$${trimDecimalZeros(apiState.benefit.period_credit_amount_usd)}`
      : '',
    apiState?.benefit?.expires_at
      ? `本期赠额到期：${fmtExpiresAt(apiState.benefit.expires_at)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1',
        className
      )}
    >
      {vm.has_token ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              tabIndex={0}
              aria-label={facts}
              className={cn(
                'min-w-0 cursor-help text-[11px] text-muted-foreground'
              )}
            >
              <div className='flex min-w-0 items-baseline gap-1'>
                <span className='truncate tabular-nums'>{label}</span>
                {state ? (
                  <span className='shrink-0 text-[color:var(--status-warn)]'>
                    {state}
                  </span>
                ) : null}
              </div>
              {!compact && spending ? <div>{spending}</div> : null}
            </div>
          </TooltipTrigger>
          <TooltipContent className='max-w-xs whitespace-pre-line'>
            {facts}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {showApi ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              tabIndex={0}
              aria-label={apiFacts}
              className='flex min-w-0 cursor-help items-baseline gap-1 text-[11px] text-muted-foreground'
            >
              <span className='tabular-nums'>{apiLabel}</span>
              {apiState?.balance_error ? (
                <span className='text-[color:var(--status-warn)]'>待刷新</span>
              ) : null}
            </div>
          </TooltipTrigger>
          <TooltipContent className='max-w-xs whitespace-pre-line'>
            {apiFacts}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}
