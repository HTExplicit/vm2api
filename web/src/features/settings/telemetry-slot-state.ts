import type { Vm, VmDetailPayload } from '@/types/panel-vm'
import { telemetryEnabled } from '@/features/vm/telemetry-policy'
import { telemetryStatusLabel } from '@/features/vm/telemetry-status'

export type LiveKey = 'live' | 'idle' | 'blocked' | 'parked' | 'unknown' | 'off'
export const LIVE_ORDER: LiveKey[] = [
  'live',
  'idle',
  'blocked',
  'parked',
  'unknown',
  'off',
]
export type SlotState = {
  vm: Vm
  on: boolean
  live: LiveKey
  label: string
  probing: boolean
}

export function slotState(
  vm: Vm,
  detail: { data?: VmDetailPayload; isPending: boolean } | undefined
): SlotState {
  const on = telemetryEnabled(vm.seed_policy)
  const observed = detail?.data?.kernel?.telemetry
  if (observed?.state === 'unsupported')
    return {
      vm,
      on,
      live: on ? 'blocked' : 'off',
      label: '此运行环境不支持',
      probing: false,
    }
  if (!on)
    return {
      vm,
      on,
      live: 'off',
      label: observed?.enabled ? '关 · 等待 VM 确认' : '关',
      probing: false,
    }
  if (vm.status !== 'running')
    return { vm, on, live: 'parked', label: '槽已停', probing: false }
  if (!detail || detail.isPending)
    return { vm, on, live: 'unknown', label: '探测中', probing: true }
  if (!observed)
    return { vm, on, live: 'unknown', label: '状态未知', probing: false }
  const live =
    observed.state === 'uploading'
      ? 'live'
      : observed.state === 'idle'
        ? 'idle'
        : 'blocked'
  return { vm, on, live, label: telemetryStatusLabel(observed), probing: false }
}
