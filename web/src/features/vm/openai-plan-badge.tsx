import type { Vm } from '@/types/panel-vm'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { claudeTier } from '@/lib/vm-status'

export function OpenaiPlanBadge({
  vm,
  size = 'md',
}: {
  vm: Vm
  size?: 'sm' | 'md'
}) {
  const tone = claudeTier(vm)
  const skin = tierVisual(vm)
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center rounded-full font-medium whitespace-nowrap',
        size === 'sm' ? 'px-1.5 py-0 text-[11px]' : 'px-2 py-0.5 text-xs',
        skin.badge
      )}
    >
      {tone.label}
    </span>
  )
}
