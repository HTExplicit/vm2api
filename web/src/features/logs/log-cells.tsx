import type { UsageLogRow } from '@/types/panel-usage-logs'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import {
  copyText,
  statusBadgeClass,
  statusBadgeTooltip,
  thinkingEffortBadgeClass,
} from './log-display'

export function StatusBadge({
  statusCode,
  finalState = null,
  errorCode = null,
  className,
}: {
  statusCode: number | null
  finalState?: string | null
  errorCode?: string | null
  className?: string
}) {
  const badge = (
    <Badge
      variant='outline'
      className={cn(statusBadgeClass(statusCode, finalState), className)}
    >
      {statusCode ?? '未知'}
    </Badge>
  )
  const title = statusBadgeTooltip(statusCode, finalState, errorCode)
  if (!title) return badge
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <span className='inline-flex'>{badge}</span>
      </TooltipTrigger>
      <TooltipContent className='max-w-xs text-xs'>{title}</TooltipContent>
    </Tooltip>
  )
}

export function ThinkingEffortBadge({ effort }: { effort: string }) {
  return (
    <Badge
      variant='outline'
      className={cn(
        'w-fit px-1 text-[10px] leading-tight whitespace-nowrap',
        thinkingEffortBadgeClass(effort)
      )}
    >
      {effort}
    </Badge>
  )
}

/**
 * 思考强度。出站 envelope 上的等级：调用方写了就用调用方的，
 * 否则是模型缺省（面板 default_effort，没有则目录缺省）。off 不显示。
 */
export function ThinkingEffortDisplay({ effort }: { effort: string | null }) {
  if (!effort) return <span className='text-muted-foreground'>-</span>
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <span
          className='relative z-20 inline-flex items-center gap-1 whitespace-nowrap'
          data-slot='thinking-effort'
        >
          <ThinkingEffortBadge effort={effort} />
        </span>
      </TooltipTrigger>
      <TooltipContent className='max-w-xs space-y-1'>
        <p className='text-xs'>
          实际发往槽位的思考强度。调用方带了 effort
          用调用方的；没带则显示模型缺省。不补（off）为空。
        </p>
      </TooltipContent>
    </Tooltip>
  )
}

export function RequestResponseModelDisplay({ row }: { row: UsageLogRow }) {
  const requestedModel = row.originalModel ?? row.model
  return (
    <div className='flex min-w-0 flex-col leading-4'>
      <div className='flex min-w-0 items-center gap-1.5'>
        {requestedModel ? <ModelVendorIcon modelId={requestedModel} /> : null}
        <span
          className={cn(
            'truncate',
            requestedModel && 'cursor-pointer hover:underline'
          )}
          onClick={(event) => {
            event.stopPropagation()
            if (requestedModel) void copyText(requestedModel)
          }}
        >
          请求：{requestedModel ?? '未知'}
        </span>
      </div>
      <span
        className={cn(
          'truncate text-muted-foreground',
          row.actualResponseModel && 'cursor-pointer hover:underline'
        )}
        onClick={(event) => {
          event.stopPropagation()
          if (row.actualResponseModel) void copyText(row.actualResponseModel)
        }}
      >
        上游返回：{row.actualResponseModel ?? '未知'}
      </span>
    </div>
  )
}
