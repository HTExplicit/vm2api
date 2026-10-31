import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { codexQuotaDisplayVm } from '@/lib/codex-quota-display'
import { fmtUsd, usedPctOf } from '@/lib/format'
import { formatWindowSpend } from '@/lib/vm-usage'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { CodexQuotaSampleStatus } from '@/features/vm/codex-quota-sample-status'
import { Meter, ResetAt } from '@/features/vm/detail-section-primitives'
import { vmQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

type QuotaPayload = {
  reset_credits?: {
    available_count?: number
    credits?: Array<{ expires_at?: string }>
    fetched_at?: string
  } | null
  warning?: string
}

export function OpenaiQuotaPanel({
  vm,
  u5,
  u7,
  now,
  cost5 = 0,
  cost7 = 0,
}: {
  vm: Vm
  u5: number
  u7: number
  now: number
  cost5?: number
  cost7?: number
}) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const canUse = useVmPerms().credential
  const display = codexQuotaDisplayVm(vm)
  const shownU5 = display === vm ? u5 : usedPctOf(display, '5h')
  const shownU7 = display === vm ? u7 : usedPctOf(display, '7d')
  const credits = vm.reset_credits
  const available = Math.max(0, Number(credits?.available_count) || 0)
  const expiry = credits?.credits?.[0]?.expires_at

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }

  const queryQuota = useMutation({
    mutationFn: () =>
      api<QuotaPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/openai-quota/refresh`,
        { method: 'POST' }
      ),
    onSuccess: async (data) => {
      await refreshAll()
      const count = Number(data?.reset_credits?.available_count)
      toast.success(
        Number.isFinite(count)
          ? `已查询，可用重置券 ${count} 张`
          : '已刷新 GPT 额度'
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const resetQuota = useMutation({
    mutationFn: () =>
      api<QuotaPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/openai-quota/reset`,
        { method: 'POST', signal: AbortSignal.timeout(90_000) }
      ),
    onSuccess: async (data) => {
      setConfirm(false)
      await refreshAll()
      if (data?.warning === 'reset_credit_cache_refresh_failed') {
        toast.warning('重置券已消费，但回读额度失败，请再点查询')
        return
      }
      toast.success('已使用一张重置券')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const busy = queryQuota.isPending || resetQuota.isPending

  return (
    <div className='grid gap-3'>
      <p className='m-0 text-xs text-muted-foreground'>Codex 额度 · 短时窗口</p>
      <CodexQuotaSampleStatus vm={vm} />
      <Meter
        label='5 小时已用'
        value={shownU5}
        hint={quotaHint(vm.status_5h, cost5, vm.estimate_5h)}
      />
      <div className='text-[11px] text-muted-foreground'>
        5h 重置 <ResetAt value={display.reset_5h} now={now} />
      </div>
      <Meter
        label='7 天已用'
        value={shownU7}
        hint={quotaHint(vm.status_7d, cost7, vm.estimate_7d)}
      />
      <div className='text-[11px] text-muted-foreground'>
        7d 重置 <ResetAt value={display.reset_7d} now={now} />
      </div>
      {canUse ? (
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() => queryQuota.mutate()}
          >
            {queryQuota.isPending
              ? '查询中…'
              : `查询重置券${credits ? ` ${available}` : ''}`}
          </Button>
          <Button
            size='sm'
            variant='destructive'
            disabled={busy || available < 1}
            onClick={() => setConfirm(true)}
          >
            {resetQuota.isPending ? '使用中…' : '使用重置券'}
          </Button>
        </div>
      ) : null}
      {expiry ? (
        <p className='m-0 text-[11px] text-muted-foreground'>
          最近一张到期 <ResetAt value={expiry} now={now} />
        </p>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title='使用一张重置券'
        desc={`将消费 1 / ${available} 张上游重置券，不可退回。`}
        confirmText='确认使用'
        destructive
        isLoading={resetQuota.isPending}
        handleConfirm={() => resetQuota.mutate()}
      />
    </div>
  )
}

function quotaHint(
  status: unknown,
  cost: number,
  est: Vm['estimate_5h']
): string {
  const bits: string[] = []
  const text = String(status || '').trim()
  if (text) bits.push(text)
  const spend = formatWindowSpend(cost, est)
  if (spend.costText) bits.push(spend.costText)
  if (spend.remainText) bits.push(spend.remainText)
  if (!spend.costText) bits.push(`合计 ${fmtUsd(cost, 2)}`)
  return bits.join(' · ')
}
