import type { VmKernelSnapshot } from '@/types/panel-vm'

export function telemetryStatusLabel(
  telemetry: VmKernelSnapshot['telemetry'] | { enabled: boolean }
) {
  if (!telemetry) return '状态未知'
  if (!('state' in telemetry))
    return telemetry.enabled ? '等待 VM 状态确认' : '未启用'
  switch (telemetry.state) {
    case 'unsupported':
      return '此运行环境不支持'
    case 'disabled':
      return '未启用'
    case 'waiting_credentials':
      return '等待有效凭证'
    case 'waiting_egress':
      return '等待当前出口信息'
    case 'uploading':
      return '上传中'
    case 'error':
      return '上传失败'
    case 'idle':
      return telemetry.pending_events
        ? `待合批 · ${telemetry.pending_events} 条`
        : '空闲'
  }
}
