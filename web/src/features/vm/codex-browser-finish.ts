import { api } from '@/lib/api'

export type FinishRetry = 'start' | 'verify' | 'schedule'

export class CodexBrowserFinishError extends Error {
  constructor(
    message: string,
    readonly retry: FinishRetry
  ) {
    super(message)
    this.name = 'CodexBrowserFinishError'
  }
}

type KernelHealthResponse = {
  id?: string
  kernel?: {
    codex_health?: {
      reachable?: boolean
      process_up?: boolean
      status?: number | string | null
      vm_id?: string | null
      healthy?: boolean
    } | null
  }
}

type SlotState = {
  vm?: { id?: string; status?: string; runtime?: { stopped?: boolean } }
}

function kernelReady(data: KernelHealthResponse, vmId: string) {
  const health = data.kernel?.codex_health
  return (
    data.id === vmId &&
    health?.vm_id === vmId &&
    health.reachable === true &&
    health.process_up === true &&
    health.status === 200 &&
    health.healthy !== false
  )
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : '请求失败'
}

/** Complete only after this slot's kernel and explicit scheduling both succeed. */
export async function finishCodexBrowserLogin(
  vmId: string,
  options: {
    retry?: FinishRetry
    isCurrent?: () => boolean
    onProgress?: (stage: 'starting' | 'checking' | 'scheduling') => void
  } = {}
): Promise<void> {
  const base = `/api/panel/vms/${encodeURIComponent(vmId)}`
  const assertCurrent = () => {
    if (options.isCurrent?.() === false)
      throw new Error('登录窗口已关闭或槽位已切换')
  }
  const progress = (stage: 'starting' | 'checking' | 'scheduling') => {
    assertCurrent()
    options.onProgress?.(stage)
  }
  const readHealth = async () => {
    progress('checking')
    const health = await api<KernelHealthResponse>(`${base}/health`)
    assertCurrent()
    return kernelReady(health, vmId)
  }
  const reconcile = async () => {
    progress('checking')
    const [health, detail] = await Promise.allSettled([
      api<KernelHealthResponse>(`${base}/health`),
      api<SlotState>(base),
    ])
    assertCurrent()
    const vm = detail.status === 'fulfilled' ? detail.value.vm : undefined
    const sameSlot = vm?.id === vmId
    const stopped =
      sameSlot && (vm.status === 'stopped' || vm.runtime?.stopped === true)
    const running =
      sameSlot && vm.status === 'running' && vm.runtime?.stopped !== true
    return {
      stopped,
      ready:
        !stopped &&
        running &&
        health.status === 'fulfilled' &&
        kernelReady(health.value, vmId),
    }
  }

  let ready = false
  let shouldStart = (options.retry || 'start') === 'start'
  if (options.retry === 'verify') {
    const observed = await reconcile()
    ready = observed.ready
    shouldStart = observed.stopped
    if (!ready && !shouldStart)
      throw new CodexBrowserFinishError(
        '凭据已保存，尚未确认内核就绪。请重试检查；需要时在槽位页检查运行状态。',
        'verify'
      )
  }

  if (shouldStart) {
    progress('starting')
    try {
      const result = await api<{ boot?: { rust_ok?: boolean } }>(
        `${base}/start`,
        {
          method: 'POST',
          body: JSON.stringify({ ensure_kernel: true }),
        }
      )
      assertCurrent()
      if (result.boot?.rust_ok === false)
        throw new CodexBrowserFinishError('槽位已启动，但内核未就绪', 'start')
    } catch (reason) {
      assertCurrent()
      // A lost response does not prove that the server failed to start the slot.
      const observed = await reconcile()
      const confirmedFailure =
        (reason instanceof CodexBrowserFinishError &&
          reason.retry === 'start') ||
        (typeof reason === 'object' &&
          reason !== null &&
          'status' in reason &&
          typeof reason.status === 'number' &&
          reason.status > 0)
      if (!observed.ready || confirmedFailure) {
        const retryStart = observed.stopped || confirmedFailure
        throw new CodexBrowserFinishError(
          `凭据已保存，开机尚未完成：${errorMessage(reason)}。${retryStart ? '可重试开机。' : '请重试检查当前状态。'}`,
          retryStart ? 'start' : 'verify'
        )
      }
      ready = true
    }
  }

  if (!ready) {
    try {
      ready = await readHealth()
    } catch (reason) {
      assertCurrent()
      throw new CodexBrowserFinishError(
        `凭据已保存，内核健康检查失败：${errorMessage(reason)}。可重试检查。`,
        options.retry === 'schedule' ? 'schedule' : 'verify'
      )
    }
    if (!ready)
      throw new CodexBrowserFinishError(
        '凭据已保存，目标槽位内核尚未就绪。可重试检查，无需重新登录。',
        options.retry === 'schedule' ? 'schedule' : 'verify'
      )
  }

  progress('scheduling')
  try {
    const scheduled = await api<{ id?: string; schedulable?: boolean }>(
      `${base}/schedulable`,
      { method: 'POST', body: JSON.stringify({ schedulable: true }) }
    )
    assertCurrent()
    if (scheduled.id !== vmId || scheduled.schedulable !== true)
      throw new Error('服务器未确认目标槽位已开启调度')
  } catch (reason) {
    assertCurrent()
    throw new CodexBrowserFinishError(
      `内核已就绪，调度尚未确认开启：${errorMessage(reason)}。可重试开启调度。`,
      'schedule'
    )
  }
}
