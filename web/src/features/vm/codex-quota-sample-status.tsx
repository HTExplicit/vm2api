import type { Vm } from '@/types/panel-vm'
import { fmtExpiresAt } from '@/lib/format'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/** A pending refresh keeps the last measured percentages visible. */
export function CodexQuotaSampleStatus({
  vm,
  compact = false,
}: {
  vm: Vm
  compact?: boolean
}) {
  const usage = vm.codex_usage
  if (!usage?.pending_refresh) return null
  const measured = usage.last_success_at
    ? `最近测量：${fmtExpiresAt(usage.last_success_at)}`
    : '尚无成功测量'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={`额度待刷新，${measured}`}
          className='inline-flex min-w-0 cursor-help items-baseline gap-1 text-[11px] text-muted-foreground'
        >
          <span className='shrink-0 text-[color:var(--status-warn)]'>
            待刷新
          </span>
          {compact ? null : <span className='truncate'>{measured}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent className='max-w-xs whitespace-pre-line'>
        {`${usage.last_success_at ? '额度待刷新，保留最近成功测量的读数。' : '尚未取得完整额度读数。'}\n${measured}`}
      </TooltipContent>
    </Tooltip>
  )
}
