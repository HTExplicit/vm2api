import type { UsageLogRow } from '@/types/panel-usage-logs'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { GptRouteBadge } from '@/components/gpt-route-badge'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import {
  copyText,
  livePhaseBadgeClass,
  livePhaseLabel,
  statusBadgeClass,
  statusBadgeLabel,
  statusBadgeTooltip,
  thinkingEffortBadgeClass,
} from './log-display'

export function StatusBadge({
  statusCode,
  finalState = null,
  errorCode = null,
  errorClass = null,
  errorLabel = null,
  inFlight = false,
  livePhase = null,
  attemptCount = null,
  className,
}: {
  statusCode: number | null
  finalState?: string | null
  errorCode?: string | null
  errorClass?: string | null
  errorLabel?: string | null
  inFlight?: boolean
  livePhase?: string | null
  attemptCount?: number | null
  className?: string
}) {
  if (inFlight) {
    const phaseText = livePhaseLabel(livePhase)
    const liveBadge = (
      <Badge
        variant='outline'
        data-in-flight='true'
        data-live-phase={livePhase ?? undefined}
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap',
          livePhaseBadgeClass(livePhase),
          className
        )}
      >
        <Loader2 className='h-3 w-3 shrink-0 animate-spin' />
        <span>{phaseText}</span>
      </Badge>
    )
    const liveTip =
      attemptCount != null && attemptCount > 1
        ? `请求进行中 · ${phaseText}（第 ${attemptCount} 次尝试）`
        : `请求进行中 · ${phaseText}`
    return (
      <Tooltip delayDuration={250}>
        <TooltipTrigger asChild>
          <span className='inline-flex'>{liveBadge}</span>
        </TooltipTrigger>
        <TooltipContent className='max-w-xs text-xs'>{liveTip}</TooltipContent>
      </Tooltip>
    )
  }

  const label = statusBadgeLabel(statusCode, finalState, errorLabel)
  const showHttp = statusCode != null && label !== String(statusCode)
  const badge = (
    <span className='inline-flex flex-col items-start gap-0.5'>
      <Badge
        variant='outline'
        className={cn(
          'whitespace-nowrap',
          statusBadgeClass(statusCode, finalState, errorClass),
          className
        )}
      >
        {label}
      </Badge>
      {showHttp ? (
        <span className='text-[10px] text-muted-foreground'>
          HTTP {statusCode}
        </span>
      ) : null}
    </span>
  )
  const title = statusBadgeTooltip(
    statusCode,
    finalState,
    errorCode,
    errorLabel
  )
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
  const hasAttempt = Boolean(row.vmId && (row.attemptCount ?? 0) > 0)
  const via =
    row.via === 'siwc-prewarm' || (row.via === 'codex-siwc' && row.vmId)
      ? row.via
      : hasAttempt &&
          ['codex-kernel', 'codex-search', 'codex-images'].includes(
            row.via ?? ''
          )
        ? 'codex-kernel'
        : null
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
        {via ? <GptRouteBadge via={via} /> : null}
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
