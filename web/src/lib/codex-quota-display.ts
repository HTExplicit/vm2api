import type { Vm } from '@/types/panel-vm'

/** Display-only fallback; raw quota values remain the scheduling authority. */
export function codexQuotaDisplayVm(vm: Vm): Vm {
  const usage = vm.codex_usage
  if (!usage?.pending_refresh || !usage.last_success) return vm
  const windows = ['5h', '7d'].map((id) => {
    const current = usage.windows?.find((window) => window.id === id)
    const previous = usage.last_success?.windows?.find(
      (window) => window.id === id
    )
    return current?.used_percent != null
      ? current
      : previous || current || { id, used_percent: null, reset_at: null }
  })
  const [five, seven] = windows
  return {
    ...vm,
    codex_usage: { ...usage, windows },
    utilization_5h:
      five.used_percent != null ? five.used_percent / 100 : vm.utilization_5h,
    utilization_7d:
      seven.used_percent != null ? seven.used_percent / 100 : vm.utilization_7d,
    reset_5h: five.reset_at ?? vm.reset_5h,
    reset_7d: seven.reset_at ?? vm.reset_7d,
  }
}
