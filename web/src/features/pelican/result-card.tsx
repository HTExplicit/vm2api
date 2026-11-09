import { useMemo } from 'react'
import { Code2, Expand, Loader2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { extractPelicanHtml } from './output'
import { PelicanPreview } from './preview'
import type { PelicanBatch, PelicanItem } from './types'

const STATUS = {
  queued: { label: '未发送', color: 'text-muted-foreground' },
  running: { label: '生成中', color: 'text-primary' },
  success: { label: '已完成', color: 'text-[color:var(--status-ok)]' },
  error: { label: '失败', color: 'text-[color:var(--status-bad)]' },
  cancelled: { label: '未发送', color: 'text-muted-foreground' },
  interrupted: { label: '结果未知', color: 'text-[color:var(--status-warn)]' },
} as const

export type PelicanView = {
  batch: PelicanBatch
  item: PelicanItem
  tab: 'preview' | 'source'
}

export function PelicanResultCard({
  batch,
  item,
  retryDisabled,
  onRetry,
  onView,
}: {
  batch: PelicanBatch
  item: PelicanItem
  retryDisabled: boolean
  onRetry: () => void
  onView: (view: PelicanView) => void
}) {
  const html = useMemo(
    () => extractPelicanHtml(item.result?.text || ''),
    [item.result?.text]
  )
  const state = STATUS[item.status]
  const canRetry = ['error', 'cancelled', 'interrupted'].includes(item.status)
  const tokens = item.result?.usage?.output_tokens
  const message =
    item.result?.error?.message ||
    (item.status === 'queued'
      ? '旧记录尚未发送'
      : item.status === 'running'
        ? '正在生成完整动画…'
        : item.status === 'cancelled'
          ? '本项尚未发送，可单独重试'
          : item.status === 'interrupted'
            ? '刷新或离开页面时尚未取得结果，请确认后重试'
            : item.status === 'error'
              ? '生成失败，可单独重试'
              : '回复中没有可预览的 HTML 或 SVG，请查看源码')

  return (
    <article className='min-w-0 overflow-hidden rounded-xl border bg-card'>
      <header className='space-y-1 px-3 py-2.5'>
        <div className='flex items-center justify-between gap-2'>
          <h3
            className='min-w-0 truncate text-sm font-medium'
            title={item.email || item.vmName}
          >
            {item.email || item.vmName}
          </h3>
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 text-xs',
              state.color
            )}
          >
            {item.status === 'running' ? (
              <Loader2
                className='size-3 motion-safe:animate-spin'
                aria-hidden
              />
            ) : null}
            {state.label}
          </span>
        </div>
        <p
          className='truncate text-xs text-muted-foreground'
          title={`${item.vmName} · ${batch.model} · ${batch.reasoningEffort}`}
        >
          {item.vmName} · {batch.model} · {batch.reasoningEffort}
        </p>
      </header>
      {html ? (
        <PelicanPreview
          html={html}
          title={`${item.email || item.vmName} 的鹈鹕动画`}
        />
      ) : (
        <div className='flex aspect-[8/5] items-center justify-center bg-muted/40 px-5 text-center'>
          <p
            className={cn(
              'line-clamp-5 text-sm leading-relaxed',
              item.status === 'error'
                ? 'text-[color:var(--status-bad)]'
                : 'text-muted-foreground'
            )}
            title={message}
          >
            {message}
          </p>
        </div>
      )}
      <footer className='flex min-h-10 items-center justify-between gap-1 px-2 py-1'>
        <span className='min-w-0 truncate pl-1 text-[11px] text-muted-foreground tabular-nums'>
          {item.result
            ? `${(item.result.duration_ms / 1000).toFixed(1)} 秒`
            : '—'}
          {tokens != null ? ` · ${tokens.toLocaleString()} tokens` : ''}
        </span>
        <div className='flex shrink-0 items-center gap-0.5'>
          {canRetry ? (
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='h-7 px-2 text-xs'
              onClick={onRetry}
              disabled={retryDisabled}
            >
              <RotateCcw className='size-3.5' aria-hidden />
              重试
            </Button>
          ) : null}
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='size-7'
            disabled={!item.result?.text}
            aria-label={`查看 ${item.email || item.vmName} 的源码`}
            title='查看源码'
            onClick={() => onView({ batch, item, tab: 'source' })}
          >
            <Code2 className='size-3.5' aria-hidden />
          </Button>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='size-7'
            disabled={!html}
            aria-label={`放大 ${item.email || item.vmName} 的动画`}
            title='放大预览'
            onClick={() => onView({ batch, item, tab: 'preview' })}
          >
            <Expand className='size-3.5' aria-hidden />
          </Button>
        </div>
      </footer>
    </article>
  )
}
