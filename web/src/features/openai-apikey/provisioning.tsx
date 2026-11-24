import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { OpenaiApiKeyEntry } from '@/types/panel-openai-apikey'
import { toast } from 'sonner'
import { formatBalanceAmount } from '@/lib/decimal-display'
import { fmtExpiresAt } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  openaiApiClaimLabel,
  openaiApiClaimLocked,
} from '@/features/vm/openai-api-state'
import { OpenaiPlatformBrowserDialog } from '@/features/vm/openai-platform-browser-dialog'
import { runApiKeyAction } from './key-api'
import { invalidateOpenaiApiKeys } from './queries'

const ACTION_MESSAGES = {
  preview: '已查询 API 赠额资格',
  claim: '已提交 API 赠额领取',
  refresh: '已查询赠额发放状态',
}

export function ApiKeyProvisioning({
  item,
  busy,
  onBind,
}: {
  item: OpenaiApiKeyEntry
  busy: boolean
  onBind: () => void
}) {
  const [selection, setSelection] = useState('')
  const [browserOpen, setBrowserOpen] = useState(false)
  const qc = useQueryClient()
  const linked = openaiApiClaimLocked(item)
  const canClaim = item.pro_eligible && !linked
  const destinations = item.destinations || []
  const selectedOrg =
    destinations.find((org) => org.destination_account_id === selection) ||
    (destinations.length === 1 ? destinations[0] : undefined)
  const destination = selectedOrg?.destination_account_id || ''
  const benefit = item.offer || item.benefit
  const action = useMutation({
    mutationFn: (name: keyof typeof ACTION_MESSAGES) =>
      runApiKeyAction(item, name, name === 'claim' ? destination : undefined),
    onSuccess: (_data, name) => toast.success(ACTION_MESSAGES[name]),
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => invalidateOpenaiApiKeys(qc),
  })
  const pending = busy || action.isPending

  return (
    <section className='space-y-3' aria-label='赠额与配置'>
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h3 className='text-sm font-semibold'>赠额与配置</h3>
        <span className='text-xs text-muted-foreground'>
          {openaiApiClaimLabel(item)}
        </span>
      </div>
      {benefit ? (
        <dl className='grid grid-cols-2 gap-2 text-sm'>
          <dt className='text-muted-foreground'>完整账期权益</dt>
          <dd className='text-end tabular-nums'>
            ${formatBalanceAmount(benefit.period_credit_amount_usd)} /{' '}
            {benefit.cadence === 'annual' ? '年' : '月'}
          </dd>
          {canClaim && item.offer?.claimable_credit_amount_usd != null ? (
            <>
              <dt className='text-muted-foreground'>本次可领取</dt>
              <dd className='text-end tabular-nums'>
                ${formatBalanceAmount(item.offer.claimable_credit_amount_usd)}
              </dd>
            </>
          ) : null}
          <dt className='text-muted-foreground'>本期赠额到期</dt>
          <dd className='text-end'>{fmtExpiresAt(benefit.expires_at)}</dd>
        </dl>
      ) : null}
      {canClaim && destinations.length > 0 ? (
        <div className='space-y-2'>
          <Label htmlFor='api-credit-destination'>接收组织</Label>
          <Select
            value={destination}
            onValueChange={setSelection}
            disabled={pending}
          >
            <SelectTrigger id='api-credit-destination' className='w-full'>
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
      ) : item.organization_id ? (
        <p className='text-sm text-muted-foreground'>
          接收组织 {item.organization_name || item.organization_id}
        </p>
      ) : null}
      {item.offer_checked_at || item.link_checked_at ? (
        <p className='text-xs text-muted-foreground'>
          {item.link_checked_at
            ? '关联确认 ' + fmtExpiresAt(item.link_checked_at)
            : '资格查询 ' + fmtExpiresAt(item.offer_checked_at)}
        </p>
      ) : null}
      <div className='flex flex-wrap gap-2'>
        {canClaim ? (
          <>
            <Button
              size='sm'
              variant='outline'
              disabled={pending}
              onClick={() => action.mutate('preview')}
            >
              {item.offer_stale ? '重新查询资格' : '查询领取资格'}
            </Button>
            <Button
              size='sm'
              disabled={
                pending ||
                item.claim_status !== 'eligible' ||
                item.offer_stale ||
                !destination
              }
              onClick={() => action.mutate('claim')}
            >
              领取赠额
            </Button>
          </>
        ) : null}
        {!item.has_key && item.claim_status === 'pending' ? (
          <Button
            size='sm'
            variant='outline'
            disabled={pending}
            onClick={() => action.mutate('refresh')}
          >
            刷新发放状态
          </Button>
        ) : null}
        {linked || item.has_key ? (
          <Button
            size='sm'
            variant={item.has_key ? 'outline' : 'default'}
            disabled={pending}
            onClick={() => setBrowserOpen(true)}
          >
            {item.has_key ? '连接 Platform' : '配置 API Key'}
          </Button>
        ) : null}
        {linked && item.organization_id && !item.has_key ? (
          <Button
            size='sm'
            variant='outline'
            disabled={pending}
            onClick={onBind}
          >
            绑定已有 Key
          </Button>
        ) : null}
      </div>
      {item.last_error &&
      (!item.has_key || item.last_error !== item.balance_error) ? (
        <p role='alert' className='text-sm break-words text-destructive'>
          {item.last_error}
        </p>
      ) : null}
      {browserOpen ? (
        <OpenaiPlatformBrowserDialog
          vmId={item.vm_id}
          accountId={item.account_id}
          email={item.email}
          open
          onOpenChange={(open) => {
            setBrowserOpen(open)
            if (!open) void invalidateOpenaiApiKeys(qc)
          }}
          onComplete={() => void invalidateOpenaiApiKeys(qc)}
        />
      ) : null}
    </section>
  )
}
