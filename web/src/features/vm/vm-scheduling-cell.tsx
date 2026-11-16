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

const LEVELS = Array.from({ length: 10 }, (_, index) => index + 1)
const BLOCK_CLASS =
  'group/priority relative flex min-h-6 min-w-6 flex-1 items-start border-0 bg-transparent p-0 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring [@media(pointer:coarse)]:min-h-10'

/** The switch preserves scheduling intent; the buttons only change priority. */
export function VmSchedulingCell({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const perms = useVmPerms()
  const submitting = useRef(false)
  const level = Number(vm.schedule_level)
  const levelOk = Number.isInteger(level) && level >= 1 && level <= 10
  const automatic = vm.schedule_level_mode !== 'manual'
  const priorityDescription = `${automatic ? '自动' : '手动'}调度优先级，当前等级 ${levelOk ? level : '未知'}`
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
      className='w-60 shrink-0'
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className='flex h-6 items-center gap-2'>
        <SchedulableSwitch {...vmSchedulableProps(vm)} />
        {perms.admin ? (
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className={cn(
              'h-6 cursor-pointer rounded-sm px-1 text-xs shadow-none',
              automatic
                ? 'text-[color:var(--status-ok)]'
                : 'text-muted-foreground'
            )}
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
        aria-description={priorityDescription}
        aria-busy={mutation.isPending || undefined}
        className='flex w-60'
      >
        {LEVELS.map((value) => {
          const filled = levelOk && value <= level
          const segment = (
            <span
              aria-hidden
              className='pointer-events-none flex h-4 w-full items-center'
            >
              <span
                data-slot='priority-segment'
                className={cn(
                  'h-1.5 w-full border-r border-r-background/70 transition-colors group-first/priority:rounded-l-full group-last/priority:rounded-r-full group-last/priority:border-r-0',
                  filled
                    ? automatic
                      ? 'bg-[color:var(--status-ok-solid)] group-hover/priority:bg-[color:var(--status-ok)]'
                      : 'bg-sky-600 group-hover/priority:bg-sky-700 dark:bg-sky-400 dark:group-hover/priority:bg-sky-300'
                    : 'track-recessed group-hover/priority:bg-accent'
                )}
              />
            </span>
          )
          if (!perms.admin) {
            return (
              <span
                key={value}
                aria-hidden
                title={priorityDescription}
                className={BLOCK_CLASS}
              >
                {segment}
              </span>
            )
          }
          return (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <button
                  type='button'
                  className={cn(
                    BLOCK_CLASS,
                    'cursor-pointer disabled:opacity-50'
                  )}
                  aria-label={`${vm.id} 调度优先级 ${value}`}
                  aria-pressed={!automatic && level === value}
                  disabled={mutation.isPending}
                  onClick={() => select(value)}
                >
                  {segment}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {priorityDescription}；设为手动 {value}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
