import { useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { patchVm } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import { useVmPerms } from '@/features/vm/vm-perms'
import { schedulingPriorityTextClass } from '@/features/vm/vm-type-visual'

const LEVELS = Array.from({ length: 10 }, (_, index) => index + 1)
const BLOCK_CLASS =
  'h-6 min-w-6 flex-1 rounded-none border-0 border-r border-r-background/60 p-0 last:border-r-0 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:ring-0 [@media(pointer:coarse)]:h-10'

/** The switch preserves scheduling intent; the buttons only change priority. */
export function VmSchedulingCell({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const perms = useVmPerms()
  const submitting = useRef(false)
  const level = Number(vm.schedule_level)
  const levelOk = Number.isInteger(level) && level >= 1 && level <= 10
  const automatic = vm.schedule_level_mode !== 'manual'
  const mutation = useMutation({
    mutationFn: (next: number | 'auto') =>
      patchVm(vm.id, { schedule_level: next }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      submitting.current = false
    },
  })

  const select = (next: number | 'auto') => {
    if (!perms.admin || submitting.current) return
    if (next === 'auto' ? automatic : !automatic && next === level) return
    submitting.current = true
    mutation.mutate(next)
  }

  return (
    <div
      className='min-w-0 space-y-1.5'
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className='flex min-h-6 items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-2'>
          <SchedulableSwitch {...vmSchedulableProps(vm)} />
          <span className='text-xs whitespace-nowrap text-muted-foreground'>
            {automatic ? '自动' : '手动'}{' '}
            <span
              className={cn(
                'font-semibold tabular-nums',
                schedulingPriorityTextClass(level)
              )}
            >
              {levelOk ? level : '—'}
            </span>
          </span>
        </div>
        {perms.admin ? (
          <Button
            type='button'
            size='sm'
            variant={automatic ? 'secondary' : 'ghost'}
            className='h-6 cursor-pointer px-2 text-xs'
            aria-label={`${vm.id} 自动调度优先级`}
            aria-pressed={automatic}
            disabled={mutation.isPending}
            onClick={() => select('auto')}
          >
            自动
          </Button>
        ) : null}
      </div>
      <div
        role='group'
        aria-label={`${vm.id} 调度优先级`}
        aria-busy={mutation.isPending || undefined}
        className='flex overflow-hidden rounded-sm border border-border'
      >
        {LEVELS.map((value) => {
          const filled = levelOk && value <= level
          const className = cn(
            BLOCK_CLASS,
            filled
              ? 'bg-primary text-primary-foreground hover:bg-primary/80'
              : 'bg-muted hover:bg-accent'
          )
          if (!perms.admin) {
            return <span key={value} aria-hidden className={className} />
          }
          return (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className={cn(className, 'cursor-pointer')}
                  aria-label={`${vm.id} 调度优先级 ${value}`}
                  aria-pressed={!automatic && level === value}
                  disabled={mutation.isPending}
                  onClick={() => select(value)}
                />
              </TooltipTrigger>
              <TooltipContent>调度优先级 {value}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
