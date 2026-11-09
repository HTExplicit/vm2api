import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TestModelsPayload } from '@/types/panel-vm'
import {
  ChevronDown,
  Focus,
  LayoutGrid,
  Play,
  Settings2,
  Trash2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { apiBase, storedUser } from '@/lib/session'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSidebar } from '@/components/ui/sidebar'
import { PageHeader } from '@/components/page-header'
import { errorMessage } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { vmsListQueryOptions } from '@/features/vm/queries'
import { PelicanAccountPicker } from './account-picker'
import { PelicanResultCard, type PelicanView } from './result-card'
import { PelicanResultViewer } from './result-viewer'
import { PELICAN_PROMPT, type PelicanBatch } from './types'
import { usePelicanRuns } from './use-pelican-runs'

const DEFAULT_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

export function PelicanPage() {
  const me = useQuery(meQueryOptions())
  if (!me.data) {
    return (
      <PageHeader title='鹈鹕测试' fluid>
        <p className='text-sm text-muted-foreground'>
          {me.error ? errorMessage(me.error) : '正在读取账号权限…'}
        </p>
      </PageHeader>
    )
  }
  if (me.data.role !== 'admin') {
    return (
      <PageHeader title='鹈鹕测试' fluid>
        <p className='text-sm text-muted-foreground'>此功能仅供管理员使用。</p>
      </PageHeader>
    )
  }
  const scope = JSON.stringify([
    apiBase() || location.origin,
    me.data.user || storedUser(),
  ])
  return <PelicanWorkspace key={scope} scope={scope} />
}

function batchSummary(batch: PelicanBatch) {
  const counts = {
    success: 0,
    error: 0,
    running: 0,
    queued: 0,
    cancelled: 0,
    interrupted: 0,
  }
  for (const item of batch.results) counts[item.status]++
  return [
    `${counts.success} / ${batch.results.length} 已完成`,
    counts.running ? `${counts.running} 生成中` : '',
    counts.error ? `${counts.error} 失败` : '',
    counts.queued + counts.cancelled
      ? `${counts.queued + counts.cancelled} 未发送`
      : '',
    counts.interrupted ? `${counts.interrupted} 结果未知` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function PelicanWorkspace({ scope }: { scope: string }) {
  const vms = useQuery(vmsListQueryOptions(5000))
  const modelsQuery = useQuery({
    queryKey: ['panel', 'test-models', 'pelican-openai'],
    queryFn: () =>
      api<TestModelsPayload>('/api/panel/test-models?platform=openai'),
  })
  const accounts = useMemo(
    () =>
      (vms.data?.items || []).filter(
        (vm) =>
          isCodexVm(vm) &&
          vm.status === 'running' &&
          vm.runtime?.stopped !== true
      ),
    [vms.data?.items]
  )
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedAccounts = accounts.filter((vm) => selectedIds.includes(vm.id))
  const models = modelsQuery.data?.items || modelsQuery.data?.models || []
  const [pickedModel, setPickedModel] = useState('')
  const model = models.find((item) => item.id === pickedModel) || models[0]
  const efforts = model?.supported_reasoning_levels?.length
    ? model.supported_reasoning_levels
    : DEFAULT_EFFORTS
  const [pickedEffort, setPickedEffort] = useState('')
  const effort = efforts.includes(pickedEffort)
    ? pickedEffort
    : model?.default_reasoning_level &&
        efforts.includes(model.default_reasoning_level)
      ? model.default_reasoning_level
      : efforts.includes('medium')
        ? 'medium'
        : efforts[0]
  const [density, setDensity] = useState<'compact' | 'standard'>('compact')
  const [focused, setFocused] = useState(false)
  const [showParameters, setShowParameters] = useState(true)
  const [openedBatches, setOpenedBatches] = useState<Record<string, boolean>>(
    {}
  )
  const [view, setView] = useState<PelicanView | null>(null)
  const sidebar = useSidebar()
  const sidebarBeforeFocus = useRef<boolean | null>(null)
  const sidebarSetter = useRef(sidebar.setOpen)
  const runs = usePelicanRuns(scope)

  useEffect(() => {
    sidebarSetter.current = sidebar.setOpen
  }, [sidebar.setOpen])
  useEffect(
    () => () => {
      if (sidebarBeforeFocus.current !== null)
        sidebarSetter.current(sidebarBeforeFocus.current)
    },
    []
  )

  function toggleFocus() {
    if (!focused) {
      sidebarBeforeFocus.current = sidebar.open
      sidebar.setOpen(false)
      sidebar.setOpenMobile(false)
      setShowParameters(false)
    } else {
      sidebar.setOpen(sidebarBeforeFocus.current ?? true)
      sidebarBeforeFocus.current = null
      setShowParameters(true)
    }
    setFocused(!focused)
  }

  function start() {
    if (!model) return
    runs.start(
      selectedAccounts.map((vm) => ({
        vmId: vm.id,
        vmName: vm.name || vm.id,
        email: vm.email,
      })),
      model.id,
      effort
    )
  }

  const readyToStart =
    runs.ready && !runs.running && !!model && selectedAccounts.length > 0

  return (
    <PageHeader
      title='鹈鹕测试'
      fluid
      extra={
        <div className='flex flex-wrap items-center gap-1'>
          <div
            className='mr-1 flex items-center rounded-md border p-0.5'
            aria-label='结果卡片密度'
          >
            <Button
              type='button'
              size='sm'
              variant={density === 'compact' ? 'secondary' : 'ghost'}
              className='h-7 px-2 text-xs'
              aria-pressed={density === 'compact'}
              onClick={() => setDensity('compact')}
            >
              <LayoutGrid className='size-3.5' aria-hidden />
              紧凑
            </Button>
            <Button
              type='button'
              size='sm'
              variant={density === 'standard' ? 'secondary' : 'ghost'}
              className='h-7 px-2 text-xs'
              aria-pressed={density === 'standard'}
              onClick={() => setDensity('standard')}
            >
              标准
            </Button>
          </div>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            aria-pressed={showParameters}
            onClick={() => setShowParameters(!showParameters)}
          >
            <Settings2 aria-hidden />
            参数
          </Button>
          <Button
            type='button'
            variant={focused ? 'secondary' : 'ghost'}
            size='sm'
            aria-pressed={focused}
            onClick={toggleFocus}
          >
            <Focus aria-hidden />
            {focused ? '退出专注' : '专注'}
          </Button>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            disabled={runs.running || !runs.ready || !runs.batches.length}
            onClick={() => {
              setView(null)
              void runs.clear()
            }}
          >
            <Trash2 aria-hidden />
            清理结果
          </Button>
        </div>
      }
    >
      <div className='space-y-5'>
        {showParameters ? (
          <section className='space-y-3 border-b pb-4' aria-label='测试参数'>
            <div className='flex flex-wrap items-end gap-x-3 gap-y-3'>
              <div className='w-full space-y-1.5 sm:w-auto'>
                <p className='text-xs font-medium text-muted-foreground'>
                  测试账号
                </p>
                <PelicanAccountPicker
                  accounts={accounts}
                  selectedIds={selectedAccounts.map((vm) => vm.id)}
                  onChange={setSelectedIds}
                  disabled={runs.running}
                  loading={vms.isPending}
                />
              </div>
              <div className='min-w-0 flex-1 basis-56 space-y-1.5 sm:max-w-80'>
                <Label
                  htmlFor='pelican-model'
                  className='text-xs text-muted-foreground'
                >
                  统一模型
                </Label>
                <Select
                  value={model?.id || ''}
                  onValueChange={(id) => {
                    setPickedModel(id)
                    setPickedEffort(effort)
                  }}
                  disabled={
                    runs.running || modelsQuery.isPending || !models.length
                  }
                >
                  <SelectTrigger id='pelican-model' className='w-full'>
                    <SelectValue
                      placeholder={
                        modelsQuery.isPending ? '正在读取模型…' : '暂无可用模型'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label || item.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='w-40 space-y-1.5'>
                <Label
                  htmlFor='pelican-effort'
                  className='text-xs text-muted-foreground'
                >
                  推理强度
                </Label>
                <Select
                  value={effort}
                  onValueChange={setPickedEffort}
                  disabled={runs.running || !model}
                >
                  <SelectTrigger id='pelican-effort' className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {efforts.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='flex items-center gap-2'>
                <Button type='button' onClick={start} disabled={!readyToStart}>
                  <Play aria-hidden />
                  开始测试
                  {selectedAccounts.length
                    ? ` · ${selectedAccounts.length}`
                    : ''}
                </Button>
              </div>
            </div>
            <details className='text-xs text-muted-foreground'>
              <summary className='w-fit cursor-pointer select-none'>
                固定提示词 · 查看原文
              </summary>
              <p className='mt-2 max-w-3xl rounded-md bg-muted/60 px-3 py-2 text-foreground'>
                {PELICAN_PROMPT}
              </p>
            </details>
          </section>
        ) : null}
        {vms.error || modelsQuery.error ? (
          <p role='alert' className='text-sm text-[color:var(--status-bad)]'>
            {errorMessage(vms.error || modelsQuery.error)}
          </p>
        ) : null}
        {runs.storageError ? (
          <p role='alert' className='text-sm text-[color:var(--status-warn)]'>
            {runs.storageError}
          </p>
        ) : null}
        {!runs.ready ? (
          <p className='py-12 text-center text-sm text-muted-foreground'>
            正在读取历史结果…
          </p>
        ) : null}
        {runs.ready && !runs.batches.length ? (
          <div className='flex min-h-64 items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center'>
            <div className='max-w-md space-y-2'>
              <h3 className='text-base font-medium'>
                把每个账号的动画放在一起看
              </h3>
              <p className='text-sm leading-relaxed text-muted-foreground'>
                选择已开机的 GPT
                账号、模型和推理强度，开始后每个账号会生成一份鹈鹕骑车动画。
              </p>
            </div>
          </div>
        ) : null}
        {runs.batches.map((batch, index) => (
          <Collapsible
            key={batch.id}
            open={openedBatches[batch.id] ?? index === 0}
            onOpenChange={(open) =>
              setOpenedBatches((current) => ({ ...current, [batch.id]: open }))
            }
          >
            <CollapsibleTrigger className='group mb-3 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md py-1 text-left'>
              <ChevronDown
                className='size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90'
                aria-hidden
              />
              <span className='text-sm font-medium'>
                {new Date(batch.createdAt).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false,
                })}
              </span>
              <span className='min-w-0 truncate text-xs text-muted-foreground'>
                {batch.model} · {batch.reasoningEffort || '模型默认'}
              </span>
              <span className='ml-auto text-xs text-muted-foreground tabular-nums'>
                {batchSummary(batch)}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div
                className={cn(
                  'grid gap-3',
                  density === 'compact'
                    ? 'grid-cols-[repeat(auto-fill,minmax(min(100%,250px),1fr))]'
                    : 'grid-cols-[repeat(auto-fill,minmax(min(100%,360px),1fr))]'
                )}
              >
                {batch.results.map((item) => (
                  <PelicanResultCard
                    key={item.id}
                    batch={batch}
                    item={item}
                    retryDisabled={runs.running}
                    onRetry={() => runs.retry(batch.id, item.id)}
                    onView={setView}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
      {view ? (
        <PelicanResultViewer
          key={`${view.batch.id}:${view.item.id}:${view.tab}`}
          view={view}
          onClose={() => setView(null)}
        />
      ) : null}
    </PageHeader>
  )
}
