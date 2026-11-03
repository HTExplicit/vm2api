import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type {
  OpenaiApiBatchAction,
  OpenaiApiBatchResult,
  OpenaiApiCallStatus,
  OpenaiApiKeyEntry,
} from '@/types/panel-openai-apikey'
import { Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { fmtAgo, fmtExpiresAt, fmtUsd } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { TableSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { isOpenaiApiBalancePending } from '@/features/vm/openai-api-state'
import { ApiKeyBindDialog } from './bind-dialog'
import { ApiKeyDetailSheet } from './detail-sheet'
import { batchApiKeys, runApiKeyAction, setApiKeyEnabled } from './key-api'
import {
  balanceText,
  BATCH_STATUS_LABELS,
  batchSummary,
  CALL_STATUS_LABELS,
  filterApiKeys,
  maskedKey,
  targetId,
} from './key-display'
import { invalidateOpenaiApiKeys, openaiApiKeysQueryOptions } from './queries'

export function OpenaiApiKeyPage({
  initialVmId = '',
}: {
  initialVmId?: string
}) {
  const me = useQuery(meQueryOptions())
  const isAdmin = me.data?.role === 'admin'
  const q = useQuery(openaiApiKeysQueryOptions(isAdmin))
  const qc = useQueryClient()
  const items = q.data?.items || []
  const [search, setSearch] = useState('')
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'on' | 'off'>(
    'all'
  )
  const [statusFilter, setStatusFilter] = useState<OpenaiApiCallStatus | 'all'>(
    'all'
  )
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const [detailId, setDetailId] = useState('')
  const [binding, setBinding] = useState(false)
  const [replacing, setReplacing] = useState<OpenaiApiKeyEntry | null>(null)
  const [deleting, setDeleting] = useState<OpenaiApiKeyEntry[]>([])
  const [results, setResults] = useState<OpenaiApiBatchResult[]>([])
  const [resultNames, setResultNames] = useState<Record<string, string>>({})
  const visible = filterApiKeys(items, search, enabledFilter, statusFilter)
  const selected = items.filter((item) => selection.has(targetId(item)))
  const detail = items.find((item) => targetId(item) === detailId)
  const located = items.find((item) => item.vm_id === initialVmId)
  const locatedId = located ? targetId(located) : ''
  const allVisibleSelected =
    visible.length > 0 && visible.every((item) => selection.has(targetId(item)))
  useEffect(() => {
    if (initialVmId) setDetailId(locatedId)
  }, [initialVmId, locatedId])

  const action = useMutation({
    mutationFn: async ({
      item,
      name,
      enabled,
    }: {
      item: OpenaiApiKeyEntry
      name: 'toggle' | 'refresh' | 'resume'
      enabled?: boolean
    }) => {
      if (name === 'toggle') await setApiKeyEnabled(item, !!enabled)
      else await runApiKeyAction(item, name)
    },
    onSuccess: async (_data, variables) => {
      toast.success(
        variables.name === 'refresh'
          ? '余额刷新已提交'
          : variables.name === 'resume'
            ? '额度阻断已解除'
            : variables.enabled
              ? 'API 使用已开启'
              : 'API 使用已关闭'
      )
      await invalidateOpenaiApiKeys(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const batch = useMutation({
    mutationFn: ({
      name,
      rows,
    }: {
      name: OpenaiApiBatchAction
      rows: OpenaiApiKeyEntry[]
    }) => batchApiKeys(name, rows),
    onSuccess: async (data, variables) => {
      setResults(data.results)
      setDeleting([])
      if (variables.name === 'delete') {
        setSelection(new Set())
        const removed = new Set(
          data.results.filter((row) => row.status === 'done').map(targetId)
        )
        if (removed.has(detailId)) setDetailId('')
      }
      if (data.results.some((row) => row.status === 'error'))
        toast.error(batchSummary(data.results))
      else toast.success(batchSummary(data.results))
      await invalidateOpenaiApiKeys(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const busy = action.isPending || batch.isPending
  function choose(item: OpenaiApiKeyEntry, checked: boolean) {
    setSelection((previous) => {
      const next = new Set(previous)
      if (checked) next.add(targetId(item))
      else next.delete(targetId(item))
      return next
    })
  }
  function runBatch(name: OpenaiApiBatchAction) {
    setResults([])
    setResultNames(
      Object.fromEntries(selected.map((item) => [targetId(item), item.email]))
    )
    batch.mutate({ name, rows: selected })
  }

  if (me.isLoading)
    return (
      <PageHeader title={VIEW_TITLES['openai-apikey']}>
        <TableSkeleton rows={5} columns={8} />
      </PageHeader>
    )
  if (!isAdmin)
    return (
      <PageHeader title={VIEW_TITLES['openai-apikey']}>
        <p className='text-sm text-muted-foreground'>
          只有管理员可以管理账号 API key。
        </p>
      </PageHeader>
    )
  return (
    <PageHeader
      title={VIEW_TITLES['openai-apikey']}
      description='管理账号绑定的官方 key。调用使用槽位当前代理，余额仅作展示。'
      extra={
        <div className='flex flex-wrap gap-2'>
          <Button variant='outline' asChild>
            <a href='#/models?platform=openai'>OpenAI 模型</a>
          </Button>
          <Button onClick={() => setBinding(true)}>
            <Plus aria-hidden />
            绑定已有 key
          </Button>
        </div>
      }
      fluid
    >
      <QueryGate
        loading={q.isLoading}
        error={q.error}
        skeleton={<TableSkeleton rows={6} columns={9} />}
      >
        <div className='space-y-4'>
          <div className='flex flex-wrap items-center gap-2'>
            <Input
              className='w-full sm:w-72'
              aria-label='搜索账号 API key'
              placeholder='搜索槽位、邮箱或组织'
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select
              value={enabledFilter}
              onValueChange={(value) =>
                setEnabledFilter(value as typeof enabledFilter)
              }
            >
              <SelectTrigger className='w-32' aria-label='筛选使用开关'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>全部开关</SelectItem>
                <SelectItem value='on'>已开启</SelectItem>
                <SelectItem value='off'>已关闭</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) =>
                setStatusFilter(value as typeof statusFilter)
              }
            >
              <SelectTrigger className='w-36' aria-label='筛选调用状态'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>全部调用状态</SelectItem>
                {Object.entries(CALL_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant='ghost'
              size='sm'
              disabled={q.isFetching}
              onClick={() => void q.refetch()}
            >
              <RefreshCw aria-hidden />
              刷新列表
            </Button>
            <span className='text-xs text-muted-foreground'>
              {visible.length} / {items.length} 个账号
            </span>
          </div>
          <div className='flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2'>
            <span className='px-1 text-xs text-muted-foreground'>
              已选 {selected.length}
            </span>
            <Button
              variant='outline'
              size='sm'
              disabled={!selected.length || busy}
              onClick={() => runBatch('enable')}
            >
              开启
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={!selected.length || busy}
              onClick={() => runBatch('disable')}
            >
              关闭
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={!selected.length || busy}
              onClick={() => runBatch('refresh_balance')}
            >
              刷新余额
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={!selected.length || busy}
              onClick={() => runBatch('resume')}
            >
              解除额度阻断
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={!selected.length || busy}
              onClick={() => setDeleting(selected)}
            >
              解除本地绑定
            </Button>
          </div>
          {results.length ? (
            <div
              role='status'
              className='space-y-2 rounded-md border p-3 text-sm'
            >
              <p className='font-medium'>{batchSummary(results)}</p>
              <ul className='max-h-44 space-y-1 overflow-y-auto'>
                {results.map((result) => (
                  <li key={targetId(result)} className='break-words'>
                    <span>{resultNames[targetId(result)] || result.vm_id}</span>
                    <span
                      className={
                        result.status === 'error'
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                      }
                    >
                      {' '}
                      · {BATCH_STATUS_LABELS[result.status]}
                      {result.error ? `：${result.error.message}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className='rounded-md border'>
            <Table density='compact'>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-10'>
                    <Checkbox
                      aria-label='选择当前筛选的全部账号'
                      checked={
                        allVisibleSelected
                          ? true
                          : visible.some((item) =>
                                selection.has(targetId(item))
                              )
                            ? 'indeterminate'
                            : false
                      }
                      disabled={!visible.length || busy}
                      onCheckedChange={(checked) =>
                        setSelection((previous) => {
                          const next = new Set(previous)
                          for (const item of visible) {
                            if (checked) next.add(targetId(item))
                            else next.delete(targetId(item))
                          }
                          return next
                        })
                      }
                    />
                  </TableHead>
                  <TableHead>账号 / 槽位</TableHead>
                  <TableHead>官方 key</TableHead>
                  <TableHead>API 使用</TableHead>
                  <TableHead>调用状态</TableHead>
                  <TableHead>API 余额</TableHead>
                  <TableHead>当前代理</TableHead>
                  <TableHead className='text-end'>今日调用</TableHead>
                  <TableHead className='text-end'>今日估算费用</TableHead>
                  <TableHead>最近调用</TableHead>
                  <TableHead className='text-end'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!visible.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={11}
                      className='h-32 text-center whitespace-normal text-muted-foreground'
                    >
                      {items.length
                        ? '没有符合筛选条件的账号'
                        : '还没有已绑定的官方 key。请在账号页完成赠额领取和自动配置，或绑定已有 key。'}
                    </TableCell>
                  </TableRow>
                ) : null}
                {visible.map((item) => (
                  <TableRow
                    key={targetId(item)}
                    data-state={
                      selection.has(targetId(item)) ? 'selected' : undefined
                    }
                  >
                    <TableCell>
                      <Checkbox
                        aria-label={`选择 ${item.email}`}
                        checked={selection.has(targetId(item))}
                        disabled={busy}
                        onCheckedChange={(checked) => choose(item, !!checked)}
                      />
                    </TableCell>
                    <TableCell>
                      <button
                        className='block max-w-64 truncate text-start font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring'
                        title={item.email}
                        onClick={() => setDetailId(targetId(item))}
                      >
                        {item.email}
                      </button>
                      <div className='max-w-64 truncate text-xs text-muted-foreground'>
                        {item.slot_name || item.vm_id}
                      </div>
                    </TableCell>
                    <TableCell className='font-mono text-xs'>
                      {maskedKey(item.key_suffix)}
                    </TableCell>
                    <TableCell>
                      <Switch
                        aria-label={`${item.email} API 使用`}
                        checked={item.enabled}
                        disabled={busy}
                        onCheckedChange={(enabled) =>
                          action.mutate({ item, name: 'toggle', enabled })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          item.call_status === 'ready' ? 'secondary' : 'outline'
                        }
                      >
                        {CALL_STATUS_LABELS[item.call_status]}
                      </Badge>
                    </TableCell>
                    <TableCell className='tabular-nums'>
                      <span>{balanceText(item.balance)}</span>
                      {isOpenaiApiBalancePending(item) ? (
                        <div className='text-[11px] text-muted-foreground'>
                          待刷新
                        </div>
                      ) : null}
                      {item.balance_refresh_interval_minutes === 0 ? (
                        <div className='text-[11px] text-muted-foreground'>
                          仅手动刷新
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span
                        className='block max-w-36 truncate'
                        title={item.proxy?.name || ''}
                      >
                        {item.proxy?.name || item.proxy?.id || '未绑定'}
                      </span>
                    </TableCell>
                    <TableCell className='text-end tabular-nums'>
                      {item.today_requests}
                    </TableCell>
                    <TableCell className='text-end tabular-nums'>
                      {item.today_cost == null
                        ? '未知'
                        : fmtUsd(item.today_cost)}
                      {item.unpriced_requests ? (
                        <div className='text-[11px] text-muted-foreground'>
                          含未定价调用
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell
                      className='text-xs text-muted-foreground'
                      title={
                        item.last_used_at
                          ? fmtExpiresAt(item.last_used_at)
                          : undefined
                      }
                    >
                      {item.last_used_at
                        ? fmtAgo(item.last_used_at)
                        : '暂无调用'}
                    </TableCell>
                    <TableCell className='text-end'>
                      <Button
                        size='sm'
                        variant='ghost'
                        onClick={() => setDetailId(targetId(item))}
                      >
                        详情
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className='text-xs leading-relaxed text-muted-foreground'>
            调用统计按账号累计，包含官方明确拒绝的尝试；费用为 vm2api
            估算。客户端密钥仍在“密钥”页选择 OpenAI(apikey) 并勾选槽位。
          </p>
        </div>
      </QueryGate>
      {detail ? (
        <ApiKeyDetailSheet
          key={`${targetId(detail)}:${detail.key_suffix || ''}`}
          item={detail}
          busy={busy}
          onClose={() => setDetailId('')}
          onToggle={(enabled) =>
            action.mutate({ item: detail, name: 'toggle', enabled })
          }
          onRefresh={() => action.mutate({ item: detail, name: 'refresh' })}
          onResume={() => action.mutate({ item: detail, name: 'resume' })}
          onReplace={() => {
            setDetailId('')
            setReplacing(detail)
          }}
          onDelete={() => setDeleting([detail])}
        />
      ) : null}
      {binding || replacing ? (
        <ApiKeyBindDialog
          candidates={q.data?.bind_candidates || []}
          replacing={replacing}
          onClose={() => {
            setBinding(false)
            setReplacing(null)
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting.length > 0}
        onOpenChange={(open) => !open && setDeleting([])}
        title={`解除 ${deleting.length} 个账号的本地绑定`}
        desc={
          <div className='space-y-2'>
            <p>
              仅删除 vm2api 保存的 key，保留领取记录、组织余额和历史日志，官方
              key 不会被撤销。
            </p>
            <ul className='max-h-48 list-inside list-disc overflow-y-auto break-all'>
              {deleting.map((item) => (
                <li key={targetId(item)}>{item.email}</li>
              ))}
            </ul>
          </div>
        }
        confirmText='解除本地绑定'
        cancelBtnText='取消'
        destructive
        isLoading={batch.isPending}
        handleConfirm={() => {
          setResults([])
          setResultNames(
            Object.fromEntries(
              deleting.map((item) => [targetId(item), item.email])
            )
          )
          batch.mutate({ name: 'delete', rows: deleting })
        }}
      />
    </PageHeader>
  )
}
