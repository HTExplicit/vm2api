import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type {
  OpenaiApiBatchAction,
  OpenaiApiBatchResult,
  OpenaiApiCallStatus,
  OpenaiApiKeyEntry,
} from '@/types/panel-openai-apikey'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
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
import {
  openaiApiBalanceStatusMessage,
  openaiApiBalanceStatusText,
  openaiApiClaimLabel,
  openaiApiClaimLocked,
} from '@/features/vm/openai-api-state'
import { ApiKeyDetailDialog } from './detail-dialog'
import { batchApiKeys, runApiKeyAction, setApiKeyEnabled } from './key-api'
import {
  balanceText,
  BATCH_STATUS_LABELS,
  batchSummary,
  CALL_STATUS_LABELS,
  CONFIG_FILTERS,
  filterApiKeys,
  targetId,
  type ConfigFilter,
} from './key-display'
import { invalidateOpenaiApiKeys, openaiApiKeysQueryOptions } from './queries'

const BATCH_BUTTONS = [
  ['enable', '开启'],
  ['disable', '关闭'],
  ['refresh_balance', '刷新余额'],
  ['resume', '解除额度阻断'],
] as const

type KeyAction =
  | { item: OpenaiApiKeyEntry; name: 'toggle'; enabled: boolean }
  | { item: OpenaiApiKeyEntry; name: 'refresh' | 'resume' }

function configurationLabel(item: OpenaiApiKeyEntry) {
  if (!openaiApiClaimLocked(item) && !item.has_key) return null
  if (
    item.setup_status === 'configuring' &&
    (item.balance_refresh_status === 'queued' ||
      item.balance_refresh_status === 'refreshing')
  )
    return '配置中'
  if (item.has_key) return '已绑定'
  if (item.setup_status === 'needs_login') return '需要登录'
  if (item.setup_status === 'error') return '配置失败'
  return '待配置'
}

export function OpenaiApiKeyPage({
  vmId,
  onVmIdChange,
}: {
  vmId?: string
  onVmIdChange: (vmId?: string) => void
}) {
  const me = useQuery(meQueryOptions())
  const isAdmin = me.data?.role === 'admin'
  const q = useQuery(openaiApiKeysQueryOptions(isAdmin))
  const qc = useQueryClient()
  const items = q.data?.items || []
  const [search, setSearch] = useState('')
  const [configFilter, setConfigFilter] = useState<ConfigFilter>('all')
  const [callFilter, setCallFilter] = useState<OpenaiApiCallStatus | 'all'>(
    'all'
  )
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const [deleting, setDeleting] = useState<OpenaiApiKeyEntry[]>([])
  const [results, setResults] = useState<
    (OpenaiApiBatchResult & { label: string })[]
  >([])

  const visible = filterApiKeys(items, search, configFilter, callFilter)
  const selectable = visible.filter((item) => item.has_key)
  const selected = items.filter(
    (item) => item.has_key && selection.has(targetId(item))
  )
  const selectedCount = selectable.filter((item) =>
    selection.has(targetId(item))
  ).length
  const detail = items.find((item) => item.vm_id === vmId)

  const action = useMutation({
    mutationFn: ({ item, ...action }: KeyAction) =>
      action.name === 'toggle'
        ? setApiKeyEnabled(item, action.enabled)
        : runApiKeyAction(item, action.name),
    onSuccess: async (_data, action) => {
      toast.success(
        action.name === 'toggle'
          ? action.enabled
            ? 'API 使用已开启'
            : 'API 使用已关闭'
          : action.name === 'refresh'
            ? '余额刷新已提交'
            : '额度阻断已解除'
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
    onSuccess: async (data, { name, rows }) => {
      const names = new Map(
        rows.map((item) => [targetId(item), item.email || item.slot_name])
      )
      setResults(
        data.results.map((row) => ({
          ...row,
          label: names.get(targetId(row)) || row.vm_id,
        }))
      )
      if (name === 'delete') {
        setDeleting([])
        setSelection(new Set())
        if (
          detail &&
          data.results.some(
            (row) => row.status === 'done' && targetId(row) === targetId(detail)
          )
        )
          onVmIdChange()
      }
      const message = batchSummary(data.results)
      if (data.results.some((row) => row.status === 'error'))
        toast.error(message)
      else toast.success(message)
      await invalidateOpenaiApiKeys(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const busy = action.isPending || batch.isPending

  function choose(rows: OpenaiApiKeyEntry[], checked: boolean) {
    setSelection((previous) => {
      const next = new Set(previous)
      for (const item of rows) {
        if (checked) next.add(targetId(item))
        else next.delete(targetId(item))
      }
      return next
    })
  }

  function runBatch(name: OpenaiApiBatchAction, rows: OpenaiApiKeyEntry[]) {
    setResults([])
    batch.mutate({ name, rows })
  }

  const title = VIEW_TITLES['openai-apikey']
  if (me.isLoading)
    return (
      <PageHeader title={title}>
        <TableSkeleton rows={5} columns={7} />
      </PageHeader>
    )
  if (!isAdmin)
    return (
      <PageHeader title={title}>
        <p className='text-sm text-muted-foreground'>
          只有管理员可以管理账号 API Key。
        </p>
      </PageHeader>
    )
  return (
    <PageHeader
      title={title}
      description='查看订阅赠额、配置 OpenAI Platform Key 和管理账号调用。'
      extra={
        <Button variant='outline' asChild>
          <a href='#/models?platform=openai'>OpenAI 模型</a>
        </Button>
      }
      fluid
    >
      <QueryGate
        loading={q.isLoading}
        error={q.error}
        skeleton={<TableSkeleton rows={6} columns={7} />}
      >
        <div className='space-y-4'>
          {vmId && !detail ? (
            <div
              role='status'
              className='flex items-center justify-between rounded-md border px-3 py-2 text-sm'
            >
              <span>该槽位暂无可管理的 OpenAI 账号。</span>
              <Button variant='ghost' size='sm' onClick={() => onVmIdChange()}>
                返回列表
              </Button>
            </div>
          ) : null}
          <div className='flex flex-wrap items-center gap-2'>
            <Input
              className='w-full sm:w-72'
              type='search'
              aria-label='搜索 OpenAI 账号'
              placeholder='搜索槽位、邮箱或组织'
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select
              value={configFilter}
              onValueChange={(value) => setConfigFilter(value as ConfigFilter)}
            >
              <SelectTrigger className='w-36' aria-label='筛选配置状态'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>全部配置状态</SelectItem>
                {Object.entries(CONFIG_FILTERS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={callFilter}
              onValueChange={(value) =>
                setCallFilter(value as typeof callFilter)
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
          {selected.length ? (
            <div className='flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2'>
              <span className='px-1 text-xs text-muted-foreground'>
                已选 {selected.length}
              </span>
              {BATCH_BUTTONS.map(([name, label]) => (
                <Button
                  key={name}
                  variant='outline'
                  size='sm'
                  disabled={busy}
                  onClick={() => runBatch(name, selected)}
                >
                  {label}
                </Button>
              ))}
              <Button
                variant='outline'
                size='sm'
                disabled={busy}
                onClick={() => setDeleting(selected)}
              >
                解除本地绑定
              </Button>
            </div>
          ) : null}
          {results.length ? (
            <div
              role='status'
              className='space-y-2 rounded-md border p-3 text-sm'
            >
              <p className='font-medium'>{batchSummary(results)}</p>
              <ul className='max-h-44 space-y-1 overflow-y-auto'>
                {results.map((result) => (
                  <li key={targetId(result)} className='break-words'>
                    <span>{result.label}</span>
                    <span
                      className={
                        result.status === 'error'
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                      }
                    >
                      {' · '}
                      {BATCH_STATUS_LABELS[result.status]}
                      {result.error ? `：${result.error.message}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className='rounded-md border'>
            <Table density='compact' aria-label='OpenAI 账号 API Key'>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-10'>
                    <Checkbox
                      aria-label='选择当前筛选的已绑定账号'
                      checked={
                        selectedCount > 0 &&
                        (selectedCount === selectable.length
                          ? true
                          : 'indeterminate')
                      }
                      disabled={!selectable.length || busy}
                      onCheckedChange={(checked) =>
                        choose(selectable, checked === true)
                      }
                    />
                  </TableHead>
                  <TableHead>账号 / 槽位</TableHead>
                  <TableHead>赠额与配置</TableHead>
                  <TableHead>API 使用</TableHead>
                  <TableHead>调用状态</TableHead>
                  <TableHead>API 余额</TableHead>
                  <TableHead className='text-end'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className='h-32 text-center whitespace-normal text-muted-foreground'
                    >
                      {items.length
                        ? '没有符合筛选条件的账号'
                        : '暂无可管理的 OpenAI 账号。'}
                    </TableCell>
                  </TableRow>
                ) : null}
                {visible.map((item) => {
                  const id = targetId(item)
                  const checked = item.has_key && selection.has(id)
                  const label = item.email || item.slot_name
                  const balanceStatus = openaiApiBalanceStatusText(item)
                  const setupStatus = configurationLabel(item)
                  return (
                    <TableRow
                      key={id}
                      data-state={checked ? 'selected' : undefined}
                    >
                      <TableCell>
                        {item.has_key ? (
                          <Checkbox
                            aria-label={`选择 ${label}`}
                            checked={checked}
                            disabled={busy}
                            onCheckedChange={(value) =>
                              choose([item], value === true)
                            }
                          />
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <button
                          type='button'
                          className='block max-w-64 truncate text-start font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring'
                          title={label}
                          onClick={() => onVmIdChange(item.vm_id)}
                        >
                          {label}
                        </button>
                        <div className='max-w-64 truncate text-xs text-muted-foreground'>
                          {item.slot_name}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className='text-sm'>
                          {item.claim_status === 'claimed'
                            ? '已领取'
                            : openaiApiClaimLabel(item)}
                        </span>
                        {setupStatus ? (
                          <div className='text-xs text-muted-foreground'>
                            {setupStatus}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {item.has_key ? (
                          <Switch
                            aria-label={`${label} API 使用`}
                            checked={item.enabled}
                            disabled={busy}
                            onCheckedChange={(enabled) =>
                              action.mutate({ item, name: 'toggle', enabled })
                            }
                          />
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        {item.call_status ? (
                          <Badge
                            variant={
                              item.call_status === 'ready'
                                ? 'secondary'
                                : 'outline'
                            }
                          >
                            {CALL_STATUS_LABELS[item.call_status]}
                          </Badge>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className='tabular-nums'>
                        {item.has_key || item.balance != null
                          ? balanceText(item.balance)
                          : '—'}
                        {balanceStatus ? (
                          <div
                            className='text-xs text-muted-foreground'
                            title={openaiApiBalanceStatusMessage(item)}
                          >
                            {balanceStatus}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className='text-end'>
                        <Button
                          size='sm'
                          variant='ghost'
                          onClick={() => onVmIdChange(item.vm_id)}
                        >
                          详情
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </QueryGate>
      {detail ? (
        <ApiKeyDetailDialog
          key={targetId(detail)}
          item={detail}
          busy={busy}
          onClose={() => onVmIdChange()}
          onToggle={(enabled) =>
            action.mutate({ item: detail, name: 'toggle', enabled })
          }
          onRefresh={() => action.mutate({ item: detail, name: 'refresh' })}
          onResume={() => action.mutate({ item: detail, name: 'resume' })}
          onDelete={() => setDeleting([detail])}
        />
      ) : null}
      <ConfirmDialog
        open={deleting.length > 0}
        onOpenChange={(open) => !open && setDeleting([])}
        title={`解除 ${deleting.length} 个账号的本地绑定`}
        desc={
          <div className='space-y-2'>
            <p>仅删除 vm2api 保存的 Key，保留领取记录、组织余额和历史日志。</p>
            <ul className='max-h-48 list-inside list-disc overflow-y-auto break-all'>
              {deleting.map((item) => (
                <li key={targetId(item)}>{item.email || item.slot_name}</li>
              ))}
            </ul>
          </div>
        }
        confirmText='解除本地绑定'
        cancelBtnText='取消'
        destructive
        isLoading={batch.isPending}
        handleConfirm={() => runBatch('delete', deleting)}
      />
    </PageHeader>
  )
}
