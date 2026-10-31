import type { Vm } from '@/types/panel-vm'
import { isOpenaiApiKeyCandidate } from '@/features/vm/openai-api-state'

/** Keep existing selections visible without offering depleted accounts as new choices. */
export function openaiApiAccountChoices(
  vms: Vm[],
  retainedIds: string[] = [],
  selectedIds: string[] = []
): Vm[] {
  const retained = new Set(retainedIds)
  const selected = new Set(selectedIds)
  return vms.filter(
    (vm) =>
      isOpenaiApiKeyCandidate(vm) ||
      (retained.has(vm.id) && selected.has(vm.id))
  )
}
