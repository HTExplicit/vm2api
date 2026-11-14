import type { FailureDiagnostics, UsageLogRow } from '@/types/panel-usage-logs'
import { Copy } from 'lucide-react'
import { formatDuration } from '@/lib/usage-format'
import { Button } from '@/components/ui/button'
import { copyText } from '../log-display'

const PHASES: Record<FailureDiagnostics['phase'], string> = {
  connect: '连接内核',
  headers: '等待响应头',
  first_event: '等待首个协议事件',
  stream: '读取响应流',
  finalize: '终态收尾',
}
const USAGE = {
  missing: '未取得用量',
  partial: '仅取得部分用量',
  final: '已取得最终用量',
}

function Field({
  label,
  value,
  copyable = false,
}: {
  label: string
  value: string | null
  copyable?: boolean
}) {
  if (value == null) return null
  return (
    <div className='grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-3'>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd className='flex min-w-0 items-start gap-2'>
        <span className='min-w-0 break-all'>{value}</span>
        {copyable ? (
          <Button
            variant='ghost'
            size='icon'
            className='size-5 shrink-0'
            aria-label={`复制${label}`}
            onClick={() => void copyText(value)}
          >
            <Copy className='size-3' />
          </Button>
        ) : null}
      </dd>
    </div>
  )
}

export function FailureDiagnosticsPanel({ row }: { row: UsageLogRow }) {
  const diagnostic = row.failureDiagnostics
  if (!diagnostic) return null
  return (
    <section className='space-y-3' aria-label='请求诊断'>
      <h4 className='text-sm font-semibold'>
        {diagnostic.cleanupErrorCode ? '连接收尾诊断' : '请求诊断'}
      </h4>
      {diagnostic.cleanupErrorCode ? (
        <p className='text-sm text-muted-foreground'>
          已收到有效完成终态，连接收尾出现 {diagnostic.cleanupErrorCode}
          ，请求结果仍为成功。
        </p>
      ) : null}
      <dl className='space-y-2 text-xs'>
        <Field label='观测环节' value='Codex 内核转发' />
        <Field label='发生阶段' value={PHASES[diagnostic.phase]} />
        <Field
          label='最后协议事件'
          value={diagnostic.lastEventType || '尚未收到协议事件'}
        />
        <Field
          label='距最后事件'
          value={
            diagnostic.lastEventAgoMs == null
              ? null
              : formatDuration(diagnostic.lastEventAgoMs)
          }
        />
        <Field
          label='已开始向客户端输出'
          value={diagnostic.responseCommitted ? '是' : '否'}
        />
        <Field label='用量记录' value={USAGE[diagnostic.usageState]} />
        <Field label='请求 ID' value={row.requestId} copyable />
        <Field
          label='内核请求 ID'
          value={diagnostic.kernelRequestId ?? null}
          copyable
        />
        <Field label='内核运行 ID' value={diagnostic.kernelRunId} copyable />
      </dl>
      <p className='text-xs text-muted-foreground'>
        以上为网关实际观测。根因需结合服务器内核日志确认。
      </p>
    </section>
  )
}
