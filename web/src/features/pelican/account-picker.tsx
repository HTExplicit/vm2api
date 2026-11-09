import { useState } from 'react'
import type { Vm } from '@/types/panel-vm'
import { Check, ChevronsUpDown, Search, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

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
              仅列出调度已开启的 GPT 账号
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
            return (
              <label
                key={vm.id}
                className='flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 hover:bg-accent'
              >
                <Checkbox
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
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-sm' title={vm.email}>
                    {vm.email || vm.name || vm.id}
                  </span>
                  <span className='block truncate text-xs text-muted-foreground'>
                    {vm.name && vm.name !== vm.id ? `${vm.name} · ` : ''}
                    {vm.id}
                  </span>
                </span>
                <span
                  className={
                    vm.schedule_state === 'restricted'
                      ? 'shrink-0 text-xs text-[color:var(--status-warn)]'
                      : 'shrink-0 text-xs text-muted-foreground'
                  }
                  title={vm.restriction_text || undefined}
                >
                  {vm.schedule_state === 'restricted'
                    ? vm.restriction_text || '暂时受限'
                    : '调度开'}
                </span>
              </label>
            )
          })}
          {!visible.length ? (
            <p className='px-4 py-8 text-center text-sm text-muted-foreground'>
              {term ? '没有匹配的账号' : '暂无调度已开启的 GPT 账号'}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
