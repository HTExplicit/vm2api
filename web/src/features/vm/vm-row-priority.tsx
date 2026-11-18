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
  const current = manual && known ? String(level) : 'auto'
  const automatic = known && !manual ? `自动（当前 P${level}）` : '自动'
  return (
    <div className='flex flex-wrap items-center gap-2 text-xs'>
      <label className='flex items-center gap-2 font-medium'>
        调度优先级
        {editable ? (
          <select
            className='h-8 rounded-md border border-input bg-background px-2 text-sm font-normal'
            disabled={busy}
            value={save.isPending ? String(save.variables ?? 'auto') : current}
            onChange={(e) => {
              const choice = e.currentTarget.value
              if (
                choice === current ||
                client.isMutating({ mutationKey, exact: true })
              )
                return
              save.mutate(choice === 'auto' ? null : Number(choice))
            }}
          >
            <option value='auto'>{automatic}</option>
            {SCHEDULE_LEVELS.map((n) => (
              <option key={n} value={n}>
                P{n}
              </option>
            ))}
          </select>
        ) : (
          <span className='text-muted-foreground'>
            {known ? `P${level} · ${manual ? '手动' : '自动'}` : '—'}
          </span>
        )}
      </label>
      {busy ? (
        <span role='status' className='text-muted-foreground'>
          保存中…
        </span>
      ) : null}
      {save.isError && editable ? (
        <span role='alert' className='text-destructive'>
          保存失败：{save.error.message}
        </span>
      ) : null}
    </div>
  )
}
