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
import { ApiKeyBindDialog } from './bind-dialog'
import { revealApiKey } from './key-api'
import {
  balanceText,
  CALL_STATUS_LABELS,
  maskedKey,
  proxyAddress,
  proxyName,
} from './key-display'
import { ApiKeyProvisioning } from './provisioning'

export function ApiKeyDetailDialog({
  item,
  busy,
  onClose,
  onToggle,
  onRefresh,
  onResume,
  onDelete,
}: {
  item: OpenaiApiKeyEntry
  busy: boolean
  onClose: () => void
  onToggle: (enabled: boolean) => void
  onRefresh: () => void
  onResume: () => void
  onDelete: () => void
}) {
  const [editingKey, setEditingKey] = useState(false)
  const balanceStatus = openaiApiBalanceStatusText(item)
  const balanceMessage = openaiApiBalanceStatusMessage(item)
  const address = proxyAddress(item.proxy)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className='flex max-h-[92vh] flex-col gap-4 sm:max-w-3xl'>
        <DialogHeader className='pe-8'>
          <DialogTitle>账号 API Key</DialogTitle>
          <DialogDescription className='break-all'>
            {item.email || item.slot_name}
          </DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 space-y-6 overflow-y-auto pe-3'>
          <ApiKeyProvisioning
            item={item}
            busy={busy}
            onBind={() => setEditingKey(true)}
          />
          {item.has_key ? (
            <SavedKeySection
              key={
                item.key_id +
                ':' +
                (item.key_prefix || '') +
                ':' +
                (item.key_suffix || '')
              }
              item={item}
              busy={busy}
              onReplace={() => setEditingKey(true)}
            />
          ) : null}
          {item.has_key || item.balance != null ? (
            <section className='space-y-3' aria-label='API 余额'>
              <div className='flex items-center justify-between gap-3'>
                <h3 className='text-sm font-semibold'>API 余额</h3>
                {item.has_key ? (
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={busy}
                    onClick={onRefresh}
                  >
                    <RefreshCw aria-hidden />
                    刷新余额
                  </Button>
                ) : null}
              </div>
              <p className='text-2xl font-semibold tabular-nums'>
                {balanceText(item.balance)}
              </p>
              {balanceStatus ? (
                <p
                  role='status'
                  className='text-sm break-words text-muted-foreground'
                >
                  {balanceStatus}
                  {balanceMessage ? ` · ${balanceMessage}` : ''}
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
                    '刷新方式',
                    item.balance_refresh_interval_minutes === 0
                      ? '仅手动刷新'
                      : `每 ${item.balance_refresh_interval_minutes ?? 10} 分钟`,
                  ],
                ]}
              />
              <OpenaiApiCreditDetails state={item} />
            </section>
          ) : null}
          {item.has_key && item.call_status ? (
            <section className='space-y-3' aria-label='调用状态'>
              <div className='flex items-center justify-between gap-3'>
                <label
                  htmlFor='account-api-use'
                  className='text-sm font-medium'
                >
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
                    上游额度不足，须手动解除阻断。
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
                关闭后停止分配新请求，已发送的请求继续完成。
              </p>
            </section>
          ) : null}
          <section className='space-y-3' aria-label='来源与代理'>
            <h3 className='text-sm font-semibold'>来源与代理</h3>
            <DetailRows
              rows={[
                ['槽位', item.slot_name],
                [
                  '组织',
                  item.organization_name || item.organization_id || '未知',
                ],
                ['组织 ID', item.organization_id || '未知'],
                ['绑定代理', proxyName(item.proxy)],
                ...(address ? [['代理地址', address] as [string, string]] : []),
              ]}
            />
            <Button size='sm' variant='outline' asChild>
              <a href={`#/vm/${encodeURIComponent(item.vm_id)}`}>打开账号</a>
            </Button>
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
                今日有 {item.unpriced_requests} 次调用未定价。
              </p>
            ) : null}
            <Button size='sm' variant='outline' asChild>
              <a
                href={`#/logs?source_account_id=${encodeURIComponent(item.account_id)}`}
              >
                查看该账号日志
              </a>
            </Button>
          </section>
          {item.has_key ? (
            <div className='border-t pt-4'>
              <Button
                variant='destructive'
                size='sm'
                disabled={busy}
                onClick={onDelete}
              >
                解除本地绑定
              </Button>
            </div>
          ) : null}
        </div>
        {editingKey ? (
          <ApiKeyBindDialog item={item} onClose={() => setEditingKey(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SavedKeySection({
  item,
  busy,
  onReplace,
}: {
  item: OpenaiApiKeyEntry
  busy: boolean
  onReplace: () => void
}) {
  const [secret, setSecret] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  async function reveal() {
    setReading(true)
    try {
      setSecret((await revealApiKey(item)).api_key)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setReading(false)
    }
  }
  async function copy() {
    if (!secret) return
    if (await copyText(secret)) toast.success('官方 Key 已复制')
    else toast.error('复制失败，请手动复制')
  }
  return (
    <section className='space-y-3' aria-label='官方 Key'>
      <h3 className='text-sm font-semibold'>官方 Key</h3>
      <p
        className='rounded-md border p-3 font-mono text-xs break-all'
        aria-label='官方 key 内容'
      >
        {secret || maskedKey(item.key_prefix)}
      </p>
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={reading || busy}
          onClick={() => (secret ? setSecret(null) : void reveal())}
        >
          {secret ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          {secret ? '隐藏' : reading ? '读取中…' : '查看'}
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={!secret || busy}
          onClick={() => void copy()}
        >
          <Copy aria-hidden />
          复制
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={reading || busy}
          onClick={() => {
            setSecret(null)
            onReplace()
          }}
        >
          替换 Key
        </Button>
      </div>
    </section>
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
