import { useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { patchVm } from '@/lib/api'
import { cn } from '@/lib/utils'
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
  'group/priority relative flex min-h-6 min-w-6 flex-1 items-center border-0 bg-transparent p-0 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11'

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

  const automaticSegment = (
    <span
      aria-hidden
      className='pointer-events-none flex h-4 w-full items-center'
    >
      <span
        data-slot='priority-auto-segment'
        className={cn(
          'h-1.5 w-full rounded-full transition-colors',
          automatic
            ? 'bg-[color:var(--status-ok-solid)] group-hover/priority:bg-[color:var(--status-ok)]'
            : 'track-recessed group-hover/priority:bg-accent'
        )}
      />
    </span>
  )
  const automaticClass = cn(
    BLOCK_CLASS,
    'w-6 flex-none [@media(pointer:coarse)]:w-11'
  )

  return (
    <div
      className='flex w-full items-center gap-2'
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <SchedulableSwitch
        {...vmSchedulableProps(vm)}
        className='flex shrink-0'
      />
      <div
        role='group'
        aria-label={`${vm.id} 调度优先级`}
        aria-description={priorityDescription}
        aria-busy={mutation.isPending || undefined}
        className='flex w-[268px] shrink-0 items-center gap-1 [@media(pointer:coarse)]:w-[488px]'
      >
        {perms.admin ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type='button'
                className={cn(
                  automaticClass,
                  'cursor-pointer disabled:opacity-50'
                )}
                aria-label={`${vm.id} 自动调度优先级`}
                aria-pressed={automatic}
                disabled={mutation.isPending}
                onClick={() => select('auto')}
              >
                {automaticSegment}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {priorityDescription}；{automatic ? '当前为自动' : '切换为自动'}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span
            aria-hidden
            title={priorityDescription}
            className={automaticClass}
          >
            {automaticSegment}
          </span>
        )}
        <div className='flex w-60 shrink-0 [@media(pointer:coarse)]:w-[440px]'>
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
    </div>
  )
}
