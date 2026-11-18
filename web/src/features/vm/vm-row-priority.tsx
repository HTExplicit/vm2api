import { useId } from 'react'
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { patchVm } from '@/lib/api'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from './queries'
import { SCHEDULE_LEVELS } from './scheduling-steps'

export function VmRowPriority({ vm, editable }: { vm: Vm; editable: boolean }) {
  const groupName = useId()
  const client = useQueryClient()
  const mutationKey = ['vm-row-priority', vm.id]
  const busy = useIsMutating({ mutationKey, exact: true }) > 0
  const save = useMutation({
    mutationKey,
    mutationFn: (level: number | null) =>
      patchVm(vm.id, { schedule_level: level }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        client.invalidateQueries({
          queryKey: vmQueryOptions(vm.id).queryKey,
          exact: true,
        }),
        client.invalidateQueries({
          queryKey: dashboardQueryOptions().queryKey,
        }),
      ]),
  })
  const level = vm.schedule_level
  const known = level != null && SCHEDULE_LEVELS.includes(level)
  const manual = vm.schedule_level_mode === 'manual'
  const current = manual ? (known ? level : undefined) : null
  const selected = save.isPending ? save.variables : current
  const summary = manual
    ? known
      ? `手动 P${level}`
      : '手动 · 档位未知'
    : known
      ? `自动 · 当前 P${level}`
      : '自动'

  function option(value: number | null) {
    const auto = value === null
    return (
      <label key={value ?? 'auto'} className='relative block min-w-0'>
        <input
          type='radio'
          name={groupName}
          value={value ?? 'auto'}
          aria-label={auto ? '自动' : `P${value}`}
          checked={selected === value}
          disabled={!editable}
          aria-disabled={!editable || busy}
          className='absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-default aria-disabled:cursor-default'
          onChange={() => {
            if (!editable || client.isMutating({ mutationKey, exact: true }))
              return
            save.mutate(value)
          }}
        />
        <span
          className={
            auto ? 'vm-priority-option vm-priority-auto' : 'vm-priority-option'
          }
        >
          {auto ? '自动' : value}
        </span>
      </label>
    )
  }

  return (
    <fieldset className='m-0 min-w-0 border-0 p-0 text-xs'>
      <legend className='sr-only'>调度优先级</legend>
      <div className='mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1'>
        <span aria-hidden='true' className='font-semibold'>
          调度优先级
        </span>
        <div className='flex items-center gap-2'>
          <span role='status' className='text-muted-foreground tabular-nums'>
            {busy ? '保存中…' : summary}
          </span>
          {option(null)}
        </div>
      </div>
      <div className='vm-priority-track'>{SCHEDULE_LEVELS.map(option)}</div>
      {save.isError && editable ? (
        <p role='alert' className='mt-1.5 text-destructive'>
          保存失败：{save.error.message}
        </p>
      ) : null}
    </fieldset>
  )
}
