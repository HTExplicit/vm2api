import { readRoutingConfigFile } from '../core/config.mjs'
import { getVm, summarizeVm } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import {
  codexAdmissionBlock,
  codexSlotAllowsModel,
  isCodexSlotReady,
  pickCodexSlots,
} from '../pool/codex-slot-pool.mjs'
import { CODEX_REASONING_EFFORTS } from '../protocol/codex-convert.mjs'
import { corsHeadersForRequest } from '../http/cors.mjs'
import { extractResponsesText, listTestableModels, runVmTestChat } from './vm-test-chat.mjs'

export const PELICAN_TEST_PROMPT = '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试'
const OPERATION_TIMEOUT_MS = 600_000

/** JSON whitespace keeps long generations alive through ordinary HTTP proxies. */
export async function respondPelicanTest({ req, res, run, heartbeatMs = 20_000 }) {
  res.writeHead(
    200,
    corsHeadersForRequest(req, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'identity',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    }),
  )
  res.flushHeaders?.()
  const heartbeat = setInterval(() => res.write('\n'), heartbeatMs)
  heartbeat.unref?.()
  const stopHeartbeat = () => clearInterval(heartbeat)
  res.once('close', stopHeartbeat)
  let payload
  try {
    payload = { ok: true, data: await run() }
  } catch (error) {
    payload = {
      ok: false,
      error: { code: error.code || 'pelican_test_failed', message: String(error.message || error) },
    }
  } finally {
    stopHeartbeat()
    res.off('close', stopHeartbeat)
  }
  // Closing a page stops heartbeats; it does not claim that the upstream job ended.
  if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify(payload))
}

/** Pinning a diagnostic normally bypasses operator gates; this test must not. */
export function pelicanTestAdmission({ projectRoot, vmId, model, routing = {} }) {
  if (!isValidVmId(vmId)) return { code: 'vm_not_found', message: '账号不存在' }
  const vm = getVm(projectRoot, vmId)
  if (!vm) return { code: 'vm_not_found', message: '账号不存在' }
  if (!isCodexVm(vm)) return { code: 'platform_mismatch', message: '鹈鹕测试只支持 GPT / Codex 账号' }
  if (vm.runtime?.stopped === true || vm.status !== 'running') {
    return { code: 'vm_stopped', message: '账号未运行，请先在账号页开机' }
  }
  if (vm.schedule_off === true || vm.schedulable === false || vm.unschedulable || vm.schedule_hold) {
    return { code: 'vm_unschedulable', message: '账号当前未开启调度或受限，请刷新账号状态' }
  }
  const summary = summarizeVm(vm, projectRoot, routing)
  if (!isCodexSlotReady(summary)) return { code: 'credential_unavailable', message: '账号凭证或出口当前不可用' }
  if (!codexSlotAllowsModel(summary, model)) return { code: 'model_not_allowed', message: '账号未允许此模型' }
  const blocked = codexAdmissionBlock(summary, Date.now(), routing.codex?.quota)
  if (blocked) return { code: blocked.error, message: '账号当前受限，暂时无法测试' }
  const picked = pickCodexSlots([summary], { model, quotaPolicy: routing.codex?.quota })
  if (!picked.ids.includes(vmId)) return { code: picked.error || 'vm_unschedulable', message: '账号当前不在可调度时段' }
  return null
}

export function isPelicanTestRequest(req) {
  return (
    req?.apiKeyKind === 'master' &&
    isValidVmId(req?.headers?.['x-kin-vm']) &&
    req?.headers?.['x-kin-pelican-test'] === '1'
  )
}

export async function runPelicanTest(opts) {
  const started = Date.now()
  const deadline = started + OPERATION_TIMEOUT_MS
  const vmId = String(opts.vmId || '')
  const model = String(opts.model || '').trim()
  const catalogModel = listTestableModels('openai').find((item) => item.id === model)
  const levels = catalogModel?.supported_reasoning_levels?.length
    ? catalogModel.supported_reasoning_levels
    : CODEX_REASONING_EFFORTS
  const effort = String(opts.reasoning_effort || catalogModel?.default_reasoning_level || 'medium')
  const failed = (error) => ({
    ok: false,
    vm_id: vmId,
    model,
    reasoning_effort: effort,
    text: null,
    duration_ms: Date.now() - started,
    usage: null,
    stop_reason: null,
    error,
  })
  if (!catalogModel) return failed({ code: 'model_not_allowed', message: '请选择已启用的 GPT 模型' })
  if (!levels.includes(effort)) return failed({ code: 'invalid_reasoning_effort', message: '此模型不支持所选推理强度' })
  const routing = readRoutingConfigFile(opts.projectRoot)
  const blocked = pelicanTestAdmission({ ...opts, model, routing })
  if (blocked) return failed(blocked)
  const result = await runVmTestChat({
    projectRoot: opts.projectRoot,
    vmId,
    model,
    reasoning_effort: effort,
    prompt: PELICAN_TEST_PROMPT,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    accountQuota: opts.accountQuota,
    timeoutMs: 600000,
    timeoutCapMs: 600000,
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    extraHeaders: { 'x-kin-pelican-test': '1' },
  })
  return {
    ok: result.ok,
    vm_id: vmId,
    model,
    reasoning_effort: effort,
    text: result.ok ? extractResponsesText(result.body) : null,
    duration_ms: Date.now() - started,
    usage: result.usage || null,
    stop_reason: result.stop_reason || null,
    error: result.error || null,
  }
}
