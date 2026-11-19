import fs from 'node:fs'
import path from 'node:path'
import { wakeOpenAIWaiter } from '../pool/openai-account-runtime.mjs'
import { HOLD_PROXY } from '../pool/schedule-state.mjs'
import { codexKernelHealth } from '../transport/codex-kernel-client.mjs'
import { boundProxyUrl, slotNetworkForVm } from './egress.mjs'
import { hostProxyUrlForVm, slotHost } from './slot-host.mjs'
import { slotExecContainer } from './slot-exec.mjs'
import { slotExec } from './slot-runtime.mjs'
import { clearVerifiedProxyHold, getVm, isCodexVm } from './vm-registry.mjs'
import { inspectContainer } from './vm-runtime.mjs'

async function runtimeProxyMatches(projectRoot, vm) {
  if (isCodexVm(vm)) {
    const filename = path.join(projectRoot, 'vms', vm.id, 'run', 'codex-kernel.json')
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (config.proxy_url !== hostProxyUrlForVm(vm)) return false
    const health = await codexKernelHealth(slotExec(projectRoot, vm), { requireInternalToken: true })
    return health.status === 200 && health.ok !== false && health.healthy !== false && health.proxy_ok !== false
  }
  if (slotHost(vm).kind !== 'local') return false
  const network = slotNetworkForVm(vm)
  const container = inspectContainer(slotExecContainer(vm))
  return !!network && container?.running === true && container.networkMode === network
}

/** Called after a fresh proxy probe; only owns the proxy hold, never power or the operator switch. */
export async function recoverProxyScheduleHold(
  projectRoot,
  vmId,
  { proxy, isCurrent, reloaded = false, verifyRuntime = runtimeProxyMatches, wake = wakeOpenAIWaiter },
) {
  if (!isCurrent()) return false
  const vm = getVm(projectRoot, vmId)
  const hold = vm?.schedule_hold
  if (hold?.reason !== HOLD_PROXY || vm.proxy?.id !== proxy.id) return false
  const proxyUrl = boundProxyUrl(proxy)
  if (boundProxyUrl(vm.proxy) !== proxyUrl) return false
  if (hold.detail?.tag !== proxy.id && (!reloaded || isCodexVm(vm))) {
    if (!['running', 'paused'].includes(vm.status) || !(await verifyRuntime(projectRoot, vm))) return false
  }
  if (!isCurrent()) return false
  const result = clearVerifiedProxyHold(projectRoot, vmId, { proxyId: proxy.id, proxyUrl, hold, status: vm.status })
  if (result?.status === 'running' && result.schedulable && isCodexVm(vm)) wake(vmId)
  return !!result
}
