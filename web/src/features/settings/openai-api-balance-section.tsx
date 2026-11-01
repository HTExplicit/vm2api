import type { OpenaiApiConfig } from '@/types/panel-routing'
import { Wallet } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { SettingRow } from '@/components/setting-row'
import { ChipGroup, PaneSection } from './scheduler-controls'

export function OpenaiApiBalanceSection({
  value,
  onChange,
  saving = false,
}: {
  value: Partial<OpenaiApiConfig>
  onChange: (next: OpenaiApiConfig) => void
  saving?: boolean
}) {
  const interval = value.balance_refresh_interval_minutes ?? 10
  const update = (minutes: number) =>
    onChange({ ...value, balance_refresh_interval_minutes: minutes })
  return (
    <PaneSection
      icon={Wallet}
      title='账号 API 余额'
      desc='复用 Billing 会话直接查询组织总余额，独立于 GPT OAuth 路由和内核。'
      aside={
        <Badge variant='secondary'>
          {interval === 0 ? '仅手动刷新' : `每 ${interval} 分钟`}
        </Badge>
      }
    >
      <SettingRow
        label='余额刷新间隔（分钟）'
        desc='全局设置，默认 10 分钟；1–1440 分钟自动刷新，0 表示仅手动刷新。保存后无需重启。'
      >
        <Input
          type='number'
          inputMode='numeric'
          min={0}
          max={1440}
          step={1}
          className='w-24 tabular-nums'
          value={interval}
          disabled={saving}
          aria-label='余额刷新间隔（分钟）'
          onChange={(event) => {
            const minutes = Number(event.target.value)
            if (Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440)
              update(minutes)
          }}
        />
      </SettingRow>
      <ChipGroup
        label='余额刷新常用间隔'
        value={interval}
        options={[
          [0, '仅手动'],
          [5, '5 分钟'],
          [10, '10 分钟'],
          [30, '30 分钟'],
          [60, '1 小时'],
        ]}
        disabled={saving}
        onChange={update}
      />
      <p className='text-xs leading-5 text-muted-foreground'>
        会话缺失或失效时自动恢复一次浏览器，需要验证码时提示补登录。余额只作展示，不决定
        API 调度。
      </p>
    </PaneSection>
  )
}
