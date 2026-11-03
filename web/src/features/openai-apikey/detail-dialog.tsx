import { useState } from 'react'
import type { OpenaiApiKeyEntry } from '@/types/panel-openai-apikey'
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { copyText } from '@/lib/clipboard'
import { fmtExpiresAt, fmtUsd } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { OpenaiApiCreditDetails } from '@/features/vm/openai-api-credit-details'
import {
  openaiApiBalanceStatusMessage,
  openaiApiBalanceStatusText,
} from '@/features/vm/openai-api-state'
import { revealApiKey } from './key-api'
import {
  balanceText,
  CALL_STATUS_LABELS,
  maskedKey,
  proxyAddress,
  proxyName,
} from './key-display'

const MANAGEMENT_STATUS = {
  idle: '尚未配置',
  needs_login: '需要补充 Platform 登录',
  configuring: '正在配置',
  ready: '配置完成',
  error: '管理任务失败',
}

export function ApiKeyDetailDialog({
  item,
  busy,
  onClose,
  onToggle,
  onRefresh,
  onResume,
  onReplace,
  onDelete,
}: {
  item: OpenaiApiKeyEntry
  busy: boolean
  onClose: () => void
  onToggle: (enabled: boolean) => void
  onRefresh: () => void
  onResume: () => void
  onReplace: () => void
  onDelete: () => void
}) {
  const [secret, setSecret] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const balanceStatus = openaiApiBalanceStatusText(item)
  const balanceMessage = openaiApiBalanceStatusMessage(item)
  async function readSecret(copy: boolean) {
    setReading(true)
    try {
      const value = secret || (await revealApiKey(item)).api_key
      if (copy) {
        if (!(await copyText(value)))
          throw new Error('复制失败，请查看后手动复制')
        toast.success('官方 key 已复制')
      } else setSecret(value)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setReading(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className='flex max-h-[92vh] flex-col gap-4 sm:max-w-3xl'>
        <DialogHeader className='pe-8'>
          <DialogTitle>账号 API key</DialogTitle>
          <DialogDescription className='break-all'>
            {item.email}
          </DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 space-y-6 overflow-y-auto pe-3'>
          <section className='space-y-3' aria-label='调用状态'>
            <div className='flex items-center justify-between gap-3'>
              <label htmlFor='account-api-use' className='text-sm font-medium'>
                API 使用
              </label>
              <Switch
                id='account-api-use'
                checked={item.enabled}
                disabled={busy}
                onCheckedChange={onToggle}
              />
            </div>
            <Badge
              variant={item.call_status === 'ready' ? 'secondary' : 'outline'}
            >
              {CALL_STATUS_LABELS[item.call_status]}
            </Badge>
            {item.call_status === 'rate_limited' && item.cooldown_until ? (
              <p className='text-sm text-muted-foreground'>
                冷却至 {fmtExpiresAt(item.cooldown_until)}
              </p>
            ) : null}
            {item.call_error ? (
              <div className='space-y-1 rounded-md bg-muted/60 p-3 text-sm'>
                <p className='font-medium'>
                  最近调用错误 · {item.call_error.code}
                </p>
                <p className='break-words'>{item.call_error.message}</p>
                <p className='text-xs text-muted-foreground'>
                  {fmtExpiresAt(item.call_error.at)}
                </p>
              </div>
            ) : null}
            {item.quota_blocked ? (
              <div className='space-y-2'>
                <p className='text-sm text-muted-foreground'>
                  上游已返回额度或配额不足，余额刷新不会自动解除阻断。
                </p>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={busy}
                  onClick={onResume}
                >
                  解除额度阻断
                </Button>
              </div>
            ) : null}
            <p className='text-xs text-muted-foreground'>
              关闭后不再分配新请求，已发送的请求继续完成。
            </p>
          </section>
          <section className='space-y-3' aria-label='官方 key'>
            <h3 className='text-sm font-semibold'>官方 key</h3>
            <div className='rounded-md border p-3'>
              <p
                className='font-mono text-xs break-all'
                aria-label='官方 key 内容'
              >
                {secret || maskedKey(item.key_prefix)}
              </p>
            </div>
            <div className='flex flex-wrap gap-2'>
              <Button
                size='sm'
                variant='outline'
                disabled={reading}
                onClick={() =>
                  secret ? setSecret(null) : void readSecret(false)
                }
              >
                {secret ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                {secret ? '隐藏' : reading ? '读取中…' : '查看'}
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={reading}
                onClick={() => void readSecret(true)}
              >
                <Copy aria-hidden />
                复制
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={busy}
                onClick={onReplace}
              >
                替换 key
              </Button>
            </div>
          </section>
          <section className='space-y-3' aria-label='来源与代理'>
            <h3 className='text-sm font-semibold'>来源与代理</h3>
            <DetailRows
              rows={[
                ['槽位', item.slot_name || item.vm_id],
                [
                  '组织',
                  item.organization_name || item.organization_id || '未知',
                ],
                ['组织 ID', item.organization_id || '未知'],
                ['绑定代理', proxyName(item.proxy)],
                ...(proxyAddress(item.proxy)
                  ? [['代理地址', proxyAddress(item.proxy)] as [string, string]]
                  : []),
              ]}
            />
            <Button size='sm' variant='outline' asChild>
              <a href={`#/vm/${encodeURIComponent(item.vm_id)}`}>打开账号</a>
            </Button>
          </section>
          <section className='space-y-3' aria-label='余额与赠额'>
            <div className='flex items-center justify-between gap-3'>
              <h3 className='text-sm font-semibold'>API 余额</h3>
              <Button
                size='sm'
                variant='outline'
                disabled={busy}
                onClick={onRefresh}
              >
                <RefreshCw aria-hidden />
                刷新余额
              </Button>
            </div>
            <p className='text-2xl font-semibold tabular-nums'>
              {balanceText(item.balance)}
            </p>
            {balanceStatus ? (
              <p className='text-sm text-muted-foreground'>
                {balanceStatus}
                {item.balance != null ? '，保留最后成功查询值' : ''}
              </p>
            ) : null}
            <DetailRows
              rows={[
                [
                  '最近成功查询',
                  item.balance_checked_at
                    ? fmtExpiresAt(item.balance_checked_at)
                    : '尚无样本',
                ],
                [
                  '自动刷新',
                  item.balance_refresh_interval_minutes === 0
                    ? '仅手动刷新'
                    : `每 ${item.balance_refresh_interval_minutes ?? 10} 分钟`,
                ],
              ]}
            />
            <OpenaiApiCreditDetails state={item} />
            {balanceMessage ? (
              <p className='text-sm break-words text-muted-foreground'>
                {balanceMessage}
              </p>
            ) : null}
          </section>
          <section className='space-y-3' aria-label='管理会话'>
            <h3 className='text-sm font-semibold'>管理会话</h3>
            <p className='text-sm'>{MANAGEMENT_STATUS[item.setup_status]}</p>
            {item.last_error ? (
              <p className='text-sm break-words text-muted-foreground'>
                {item.last_error}
              </p>
            ) : null}
            <p className='text-xs text-muted-foreground'>
              Platform 登录和 Billing 刷新状态独立于 API
              调用。补充登录及自动配置请在账号页操作。
            </p>
          </section>
          <section className='space-y-3' aria-label='调用统计'>
            <h3 className='text-sm font-semibold'>调用统计</h3>
            <DetailRows
              rows={[
                ['今日调用', String(item.today_requests)],
                [
                  '今日估算费用',
                  item.today_cost == null ? '未知' : fmtUsd(item.today_cost),
                ],
                [
                  '最近调用',
                  item.last_used_at
                    ? fmtExpiresAt(item.last_used_at)
                    : '暂无调用',
                ],
              ]}
            />
            {item.unpriced_requests ? (
              <p className='text-xs text-muted-foreground'>
                今日有 {item.unpriced_requests}{' '}
                次调用未定价，费用不代表官方实际扣款。
              </p>
            ) : (
              <p className='text-xs text-muted-foreground'>
                费用按 vm2api 用量与价格估算，不代表官方实际扣款。
              </p>
            )}
            <Button size='sm' variant='outline' asChild>
              <a
                href={`#/logs?source_account_id=${encodeURIComponent(item.account_id)}`}
              >
                查看该账号日志
              </a>
            </Button>
          </section>
          <div className='border-t pt-4'>
            <Button
              variant='destructive'
              size='sm'
              disabled={busy}
              onClick={onDelete}
            >
              解除本地绑定
            </Button>
            <p className='mt-2 text-xs text-muted-foreground'>
              保留领取、余额和历史日志，不撤销官方 key。
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DetailRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className='space-y-2 text-sm'>
      {rows.map(([label, value]) => (
        <div key={label} className='grid grid-cols-[7rem_minmax(0,1fr)] gap-3'>
          <dt className='text-muted-foreground'>{label}</dt>
          <dd className='m-0 text-end break-words'>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
