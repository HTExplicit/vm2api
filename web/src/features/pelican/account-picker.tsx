import { useState } from 'react'
import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { Check, ChevronsUpDown, Search, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  restrictionCopy,
  scheduleStateLabel,
  type ScheduleStateLabel,
} from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { StatusMark } from '@/components/status-mark'

const scheduleTones: Record<ScheduleStateLabel, StatusTone> = {
  开: { key: 'on', text: '调度开', cls: 'ok' },
  关: { key: 'off', text: '调度关', cls: 'off' },
  受限: { key: 'restricted', text: '暂时受限', cls: 'warn' },
  不可调度: { key: 'unschedulable', text: '不可调度', cls: 'bad' },
}

export function PelicanAccountPicker({
  accounts,
  selectedIds,
  onChange,
  disabled,
  loading,
}: {
  accounts: Vm[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  loading?: boolean
}) {
  const [search, setSearch] = useState('')
  const term = search.trim().toLowerCase()
  const visible = accounts.filter((vm) =>
    [vm.id, vm.name, vm.email].some((value) =>
      value?.toLowerCase().includes(term)
    )
  )
  const selected = new Set(selectedIds)
  const allVisible =
    visible.length > 0 && visible.every((vm) => selected.has(vm.id))

  function selectVisible() {
    onChange([...new Set([...selectedIds, ...visible.map((vm) => vm.id)])])
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          className='w-full justify-between sm:w-60'
          disabled={disabled || loading}
          aria-label={`选择测试账号，已选 ${selectedIds.length} 个`}
        >
          <span className='flex items-center gap-2'>
            <Users className='size-4 text-muted-foreground' aria-hidden />
            {loading
              ? '正在读取账号…'
              : `账号 · 已选 ${selectedIds.length} / ${accounts.length}`}
          </span>
          <ChevronsUpDown
            className='size-3.5 text-muted-foreground'
            aria-hidden
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[min(26rem,calc(100vw-2rem))] p-0'
      >
        <div className='space-y-2 border-b p-3'>
          <div className='relative'>
            <Search
              className='absolute top-2.5 left-2.5 size-4 text-muted-foreground'
              aria-hidden
            />
            <Input
              aria-label='搜索账号、邮箱或槽位'
              placeholder='搜索账号、邮箱或槽位'
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className='pl-9'
            />
          </div>
          <div className='flex items-center justify-between gap-2'>
            <span className='text-xs text-muted-foreground'>
              已开机的 GPT 账号，含调度关闭
            </span>
            <div className='flex gap-1'>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                onClick={selectVisible}
                disabled={allVisible || !visible.length}
              >
                <Check aria-hidden />
                {term ? '全选搜索结果' : '全选'}
              </Button>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                onClick={() => onChange([])}
                disabled={!selectedIds.length}
              >
                清空
              </Button>
            </div>
          </div>
        </div>
        <div className='max-h-80 overflow-y-auto p-1'>
          {visible.map((vm) => {
            const checked = selected.has(vm.id)
            const state = scheduleStateLabel(vm)
            const reason =
              state === '不可调度' &&
              vm.unschedulable_reason === 'no_credential' &&
              !vm.has_token
                ? vm.unschedulable_text || '未导入凭据'
                : state === '受限' || state === '不可调度'
                  ? restrictionCopy(vm)
                  : null
            return (
              <label
                key={vm.id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border border-transparent px-3 py-2.5 focus-within:ring-2 focus-within:ring-ring/50 hover:bg-muted/50',
                  checked && 'border-border bg-muted/60 hover:bg-muted/80'
                )}
              >
                <Checkbox
                  className='mt-0.5'
                  checked={checked}
                  onCheckedChange={(next) =>
                    onChange(
                      next
                        ? [...selectedIds, vm.id]
                        : selectedIds.filter((id) => id !== vm.id)
                    )
                  }
                  aria-label={`选择 ${vm.email || vm.name || vm.id}`}
                />
                <span className='min-w-0 flex-1 space-y-0.5'>
                  <span className='flex items-center justify-between gap-2'>
                    <span className='truncate text-sm' title={vm.email}>
                      {vm.email || vm.name || vm.id}
                    </span>
                    <StatusMark tone={scheduleTones[state]} variant='pill' />
                  </span>
                  <span className='block truncate text-xs text-muted-foreground'>
                    {vm.name && vm.name !== vm.id ? `${vm.name} · ` : ''}
                    {vm.id}
                  </span>
                  {reason ? (
                    <span className='block text-xs leading-relaxed break-words text-muted-foreground'>
                      {reason}
                    </span>
                  ) : null}
                </span>
              </label>
            )
          })}
          {!visible.length ? (
            <p className='px-4 py-8 text-center text-sm text-muted-foreground'>
              {term ? '没有匹配的账号' : '暂无已开机的 GPT 账号'}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
