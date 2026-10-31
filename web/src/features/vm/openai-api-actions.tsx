import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OpenaiApiView, Vm } from '@/types/panel-vm'
import { Gift, KeyRound, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { trimDecimalZeros } from '@/lib/decimal-display'
import { fmtExpiresAt } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { CodexCreditSummary } from '@/features/vm/codex-credit-summary'
import {
  hasOpenaiApiFeature,
  isProApiAccount,
  openaiApiClaimLabel,
  openaiApiClaimLocked,
} from '@/features/vm/openai-api-state'
import { OpenaiPlatformBrowserDialog } from '@/features/vm/openai-platform-browser-dialog'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

type ApiAction = 'preview' | 'claim' | 'setup' | 'refresh' | 'enabled'

export function OpenaiApiActions({
  vm,
  compact = false,
}: {
  vm: Vm
  compact?: boolean
}) {
  const canUse = useVmPerms().admin
  const [open, setOpen] = useState(false)
  if (!canUse || !hasOpenaiApiFeature(vm)) return null
  return (
    <>
      <Button
        size='sm'
        variant={compact ? 'ghost' : 'outline'}
        className={
          compact
            ? 'h-6 gap-1 px-1.5 text-[11px] text-muted-foreground'
            : undefined
        }
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
      >
        {vm.openai_api?.has_key ? (
          <KeyRound className='size-3' aria-hidden />
        ) : (
          <Gift className='size-3' aria-hidden />
        )}
        {vm.openai_api?.has_key ? 'API管理' : 'API赠额'}
      </Button>
      {open ? (
        <OpenaiApiDialog vm={vm} open={open} onOpenChange={setOpen} />
      ) : null}
    </>
  )
}

export function OpenaiApiDialog({
  vm,
  open,
  onOpenChange,
}: {
  vm: Vm
  open: boolean
  onOpenChange: (value: boolean) => void
}) {
  const qc = useQueryClient()
  const [selection, setSelection] = useState('')
  const [manualBrowser, setManualBrowser] = useState(false)
  const [browserDismissed, setBrowserDismissed] = useState(false)
  const base = `/api/panel/vms/${encodeURIComponent(vm.id)}/openai-api`
  const queryKey = ['panel', 'vm', vm.id, 'openai-api'] as const
  const stateQuery = useQuery({
    queryKey,
    queryFn: () =>
      api<OpenaiApiView>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/openai-api`
      ),
    enabled: open,
    initialData: vm.openai_api || undefined,
    refetchInterval: (query) => {
      const state = query.state.data
      return open &&
        (state?.claim_status === 'pending' ||
          state?.setup_status === 'configuring' ||
          state?.browser_active)
        ? 3000
        : false
    },
  })
  const state = stateQuery.data || vm.openai_api
  const refreshAll = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  const action = useMutation({
    mutationFn: ({ name, body }: { name: ApiAction; body?: object }) =>
      api<OpenaiApiView>(`${base}/${name}`, {
        method: name === 'enabled' ? 'PATCH' : 'POST',
        body: JSON.stringify(body || {}),
      }),
    onSuccess: (data, variables) => {
      qc.setQueryData(queryKey, data)
      if (variables.name === 'setup' || variables.name === 'claim')
        setBrowserDismissed(false)
      const labels = {
        preview: '已查询 API 赠额资格',
        claim: '已提交领取，后续按期自动发放',
        setup: '已开始配置 API',
        refresh: '已刷新 API 状态',
        enabled: data.enabled ? 'API 已开启' : 'API 已关闭',
      }
      toast.success(labels[variables.name])
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: refreshAll,
  })
  const currentVm = { ...vm, openai_api: state }
  const pro = isProApiAccount(currentVm)
  const locked = openaiApiClaimLocked(state)
  const destinations = state?.destinations || []
  const destination =
    selection ||
    (destinations.length === 1 ? destinations[0].destination_account_id : '')
  const offer = state?.offer
  const benefit = offer || state?.benefit
  const browserOpen =
    manualBrowser ||
    (state?.setup_status === 'needs_login' && !browserDismissed)
  const busy = action.isPending
  const showingAction = busy ? action.variables?.name : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className='flex max-h-[90vh] flex-col gap-4 sm:max-w-xl'
        onClick={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>API 赠额与调用</DialogTitle>
          <DialogDescription>
            {vm.email || vm.name || vm.id} · 使用账号当前绑定代理
          </DialogDescription>
        </DialogHeader>
        <div className='grid min-h-0 gap-5 overflow-y-auto'>
          {stateQuery.isError ? (
            <p role='alert' className='m-0 text-sm text-destructive'>
              {stateQuery.error.message}
            </p>
          ) : null}
          <section className='grid gap-3' aria-label='API 赠额'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <h3 className='m-0 text-sm font-medium'>订阅赠额</h3>
              <span
                className={cn(
                  'text-xs',
                  state?.claim_status === 'ineligible'
                    ? 'text-muted-foreground'
                    : 'text-[color:var(--status-ok)]'
                )}
              >
                {openaiApiClaimLabel(state)}
              </span>
            </div>
            {benefit ? (
              <dl className='grid grid-cols-2 gap-x-4 gap-y-2 text-sm'>
                <dt className='text-muted-foreground'>完整账期权益</dt>
                <dd className='m-0 text-end tabular-nums'>
                  ${trimDecimalZeros(benefit.period_credit_amount_usd)} /{' '}
                  {benefit.cadence === 'annual' ? '年' : '月'}
                </dd>
                {offer?.claimable_credit_amount_usd != null ? (
                  <>
                    <dt className='text-muted-foreground'>本次可领取</dt>
                    <dd className='m-0 text-end tabular-nums'>
                      ${trimDecimalZeros(offer.claimable_credit_amount_usd)}
                    </dd>
                  </>
                ) : null}
                <dt className='text-muted-foreground'>本期赠额到期</dt>
                <dd className='m-0 text-end'>
                  {fmtExpiresAt(benefit.expires_at)}
                </dd>
              </dl>
            ) : null}
            {pro && !locked && destinations.length > 0 ? (
              <div className='grid gap-1.5'>
                <Label htmlFor={`api-org-${vm.id}`}>接收组织</Label>
                <Select
                  value={destination}
                  onValueChange={setSelection}
                  disabled={busy}
                >
                  <SelectTrigger id={`api-org-${vm.id}`} className='w-full'>
                    <SelectValue placeholder='选择接收组织' />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.map((org) => (
                      <SelectItem
                        key={org.destination_account_id}
                        value={org.destination_account_id}
                      >
                        {org.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : state?.organization_name ? (
              <p className='m-0 text-xs text-muted-foreground'>
                接收组织：{state.organization_name}
              </p>
            ) : null}
            <div className='flex flex-wrap items-center gap-2'>
              {pro && !locked ? (
                <Button
                  size='sm'
                  variant='outline'
                  disabled={busy}
                  onClick={() => action.mutate({ name: 'preview' })}
                >
                  <RefreshCw
                    className={cn(
                      'size-3.5',
                      showingAction === 'preview' && 'animate-spin'
                    )}
                    aria-hidden
                  />
                  {showingAction === 'preview' ? '查询中…' : '查询领取资格'}
                </Button>
              ) : null}
              {pro || locked ? (
                <Button
                  size='sm'
                  disabled={
                    busy ||
                    locked ||
                    state?.claim_status !== 'eligible' ||
                    !destination
                  }
                  onClick={() =>
                    action.mutate({
                      name: 'claim',
                      body: { destination_account_id: destination },
                    })
                  }
                >
                  {locked
                    ? state?.claim_status === 'pending'
                      ? '发放中'
                      : '已领取'
                    : showingAction === 'claim'
                      ? '领取中…'
                      : '领取并配置 API'}
                </Button>
              ) : null}
            </div>
            {locked ? (
              <p className='m-0 text-xs text-muted-foreground'>
                已关联订阅权益，后续符合条件时由官方按期发放，无需再次领取。
              </p>
            ) : null}
          </section>
          <section
            className='grid gap-3 border-t pt-4'
            aria-label='API 调用配置'
          >
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <Label
                htmlFor={`api-enabled-${vm.id}`}
                className='text-sm font-medium'
              >
                API 独立开关
              </Label>
              <Switch
                id={`api-enabled-${vm.id}`}
                checked={!!state?.enabled}
                disabled={!state?.has_key || busy}
                onCheckedChange={(enabled) =>
                  action.mutate({ name: 'enabled', body: { enabled } })
                }
              />
            </div>
            <p className='m-0 text-xs text-muted-foreground'>
              独立于 GPT 内核启停与 OAuth 调度，使用组织可用余额。
            </p>
            <CodexCreditSummary vm={currentVm} />
            <p className='m-0 text-xs text-muted-foreground'>
              {state?.has_key
                ? `项目 key 已保存${state.key_suffix ? ` · 尾号 ${state.key_suffix}` : ''}`
                : state?.setup_status === 'configuring'
                  ? '正在配置专用项目与 key…'
                  : state?.setup_status === 'needs_login'
                    ? '需要完成 API Platform 登录'
                    : '尚未配置项目 key'}
            </p>
            <div className='flex flex-wrap items-center gap-2'>
              {locked || state?.has_key ? (
                <Button
                  size='sm'
                  variant='outline'
                  disabled={busy || state?.setup_status === 'configuring'}
                  onClick={() => action.mutate({ name: 'setup' })}
                >
                  <KeyRound className='size-3.5' aria-hidden />
                  {showingAction === 'setup'
                    ? '配置中…'
                    : state?.setup_status === 'needs_login'
                      ? '补充 Platform 登录'
                      : state?.has_key
                        ? '连接 Platform'
                        : '继续配置 API'}
                </Button>
              ) : null}
              {state?.browser_active ? (
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => {
                    setBrowserDismissed(false)
                    setManualBrowser(true)
                  }}
                >
                  打开登录窗口
                </Button>
              ) : null}
              <Button
                size='sm'
                variant='outline'
                disabled={busy || (!locked && !state?.has_key)}
                onClick={() => action.mutate({ name: 'refresh' })}
              >
                <RefreshCw
                  className={cn(
                    'size-3.5',
                    showingAction === 'refresh' && 'animate-spin'
                  )}
                  aria-hidden
                />
                {showingAction === 'refresh' ? '刷新中…' : '刷新 API 状态'}
              </Button>
            </div>
            {state?.has_key ? (
              <p className='m-0 text-xs text-muted-foreground'>
                在生成密钥的分组中选择 OpenAI(apikey)，勾选此账号即可调用。API
                余额每 10 分钟自动刷新。
              </p>
            ) : null}
          </section>
          {state?.last_error ? (
            <p role='alert' className='m-0 text-sm text-destructive'>
              {state.last_error}
            </p>
          ) : null}
        </div>
        {browserOpen ? (
          <OpenaiPlatformBrowserDialog
            vmId={vm.id}
            email={vm.email}
            open={browserOpen}
            onOpenChange={(value) => {
              setManualBrowser(value)
              if (!value) setBrowserDismissed(true)
            }}
            onComplete={() => {
              void refreshAll()
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
