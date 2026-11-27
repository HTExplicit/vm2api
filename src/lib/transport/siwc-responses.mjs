import { SIWC_RESOURCE } from '../oauth/codex-siwc.mjs'
import { siwcModelAvailable } from '../vm/codex-siwc-store.mjs'
import { isOpenAIResponsesCommitEvent, readApiSseLines } from '../pool/api-protocol.mjs'
import { parseSseDataLine } from '../protocol/stream-keepalive.mjs'
import { createStreamTiming } from '../protocol/stream-timing.mjs'
import { createSseRestorer, ensureRedaction, maskJson, restoreJsonValue } from '../redaction/runtime.mjs'

const UNSUPPORTED_TOOLS = new Set([
  'image_generation',
  'file_search',
  'code_interpreter',
  'computer',
  'computer_use',
  'computer_use_preview',
  'mcp',
  'tool_search',
  'programmatic_tool_calling',
])
const OMIT_FIELDS = [
  'background',
  'conversation',
  'generate',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_options',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
]
const EVENT_STATUS = {
  subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_user_unavailable: 503,
  subscription_sharing_invalid_user: 401,
  subscription_sharing_user_not_eligible: 403,
  subscription_sharing_unsupported_capability: 400,
}

function unsupportedTool(tools) {
  return tools?.find?.((tool) => UNSUPPORTED_TOOLS.has(tool?.type) || unsupportedTool(tool?.tools))
}

export function siwcRequestProblem(body, nativeOnly = false) {
  if (nativeOnly) return { message: 'SIWC 槽位不支持此专用接口。' }
  if (body?.previous_response_id) {
    return { param: 'previous_response_id', message: 'SIWC 的 HTTP 调用需要在 input 中携带完整历史。' }
  }
  if (
    unsupportedTool(body?.tools) ||
    unsupportedTool(body?.tool_choice?.tools) ||
    UNSUPPORTED_TOOLS.has(body?.tool_choice?.type) ||
    body?.input?.some?.((item) => item?.type === 'additional_tools' && unsupportedTool(item.tools))
  ) {
    return { param: 'tools', message: '此请求包含 SIWC 不支持的工具。' }
  }
  return null
}

export function formatSiwcBody(body) {
  const next = { ...body, model: String(body.model).split('/').at(-1), stream: true, store: false }
  for (const field of OMIT_FIELDS) delete next[field]
  if (Array.isArray(next.input)) {
    // SIWC accepts reasoning effort at the request level.
    const update = next.input.findLast((item) => item?.type === 'configuration_update' && item.reasoning?.effort)
    if (update) next.reasoning = { ...next.reasoning, effort: update.reasoning.effort }
    next.input = next.input.filter((item) => item?.type !== 'configuration_update')
  }
  if (Array.isArray(next.tools)) {
    const flat = next.tools.filter((tool) => tool?.type === 'function' || tool?.type === 'custom')
    if (flat.length) {
      next.tools = next.tools.filter((tool) => !flat.includes(tool))
      next.input = [{ type: 'additional_tools', role: 'developer', tools: flat }, ...(next.input || [])]
    }
  }
  return next
}

function failure(status, code, message, extras = {}) {
  return {
    ok: false,
    status,
    committed: false,
    terminalState: 'rejected',
    ...extras,
    body: { error: { type: 'api_error', code, message } },
  }
}

function eventFailure(event) {
  if (event.type !== 'response.failed' && event.type !== 'response.error' && event.type !== 'error') return null
  return event.response?.error || event.error || event
}

export async function streamSiwcResponses({
  siwc,
  exec,
  routing,
  body,
  envelope,
  signal,
  timeoutMs = 600_000,
  idleTimeoutMs = 180_000,
  redactionPrincipal,
  redactionSession,
  onEvent,
}) {
  const { vmId, projectRoot } = exec
  const timing = createStreamTiming()
  const abort = new AbortController()
  const combined = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal
  const total = setTimeout(() => abort.abort(), timeoutMs).unref()
  let idle
  let response
  let used
  let committed = false
  let headers = {}
  let terminal
  const armIdle = () => {
    clearTimeout(idle)
    idle = setTimeout(() => abort.abort(), idleTimeoutMs).unref()
  }
  try {
    if ((envelope?.body || body)?.generate === false) {
      return failure(400, 'unsupported_prewarm', 'SIWC 上游不支持 generate=false 预热。')
    }
    combined.throwIfAborted()
    used = await siwc.access(vmId)
    const models = used.models || (await siwc.refreshModels(vmId))
    if (!siwcModelAvailable(models, body.model)) {
      return failure(400, 'model_not_allowed', '此 SIWC 账号的模型目录不包含所选模型。')
    }
    const state = await ensureRedaction(routing || {}, { projectRoot })
    const redaction = state.enabled
      ? { principal: redactionPrincipal, session: redactionSession, maxBodyBytes: state.maxBodyBytes }
      : null
    let outgoing = formatSiwcBody(envelope?.body || body)
    if (redaction) outgoing = await maskJson(outgoing, redaction)
    combined.throwIfAborted()
    siwc.assertInUse(vmId, used)
    response = await siwc.request(vmId, SIWC_RESOURCE + '/responses', {
      method: 'POST',
      signal: combined,
      headers: {
        authorization: 'Bearer ' + used.access_token,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': 'vm2api',
      },
      body: JSON.stringify(outgoing),
    })
    headers = Object.fromEntries(response.headers)
    if (!response.ok) {
      if (response.status === 401) await siwc.rejectAccess(vmId, used)
      const raw = await response.json().catch(() => null)
      const payload = redaction && raw ? await restoreJsonValue(raw, redaction) : raw
      const error = payload?.error
      const out = failure(
        response.status,
        error?.code || 'siwc_upstream_error',
        error?.message || payload?.detail || 'OpenAI 未接受 SIWC 请求。',
        { headers, upstreamHttpStatus: response.status, siwcRevision: used.revision },
      )
      if (error && typeof error === 'object') Object.assign(out.body.error, error)
      return out
    }

    const pending = []
    response.body.setEncoding('utf8')
    armIdle()
    await readApiSseLines(
      response.body,
      async (line, receivedAt) => {
        armIdle()
        const event = parseSseDataLine(line)
        if (!event) return
        timing.observe(event, receivedAt)
        const error = eventFailure(event)
        const completes = event.type === 'response.completed' && event.response?.status === 'completed'
        const incomplete = event.type === 'response.incomplete'
        if (error) {
          const status = EVENT_STATUS[error.code] || Number(error.status || event.status) || 502
          terminal = failure(status, error.code || 'siwc_upstream_error', error.message || 'SIWC 响应失败。', {
            committed,
            terminalState: committed ? 'incomplete' : 'rejected',
          })
          if (error.param != null) terminal.body.error.param = error.param
          if (status === 401) await siwc.rejectAccess(vmId, used)
          if (committed) await onEvent(line)
          return false
        }
        if (!committed) {
          pending.push(line)
          if (!completes && !incomplete && !isOpenAIResponsesCommitEvent(event)) return
          committed = true
          for (const buffered of pending.splice(0)) await onEvent(buffered)
        } else {
          await onEvent(line)
        }
        if (completes || incomplete) {
          terminal = {
            ok: true,
            status: 200,
            committed,
            terminalState: completes ? 'verified' : 'incomplete',
            body: event.response,
          }
          return false
        }
      },
      redaction ? createSseRestorer(redaction) : null,
    )
    return {
      ...(terminal ||
        failure(502, 'siwc_upstream_stream_incomplete', 'SIWC 响应在终止事件前断开。', {
          committed,
          terminalState: 'incomplete',
          transportError: !committed,
        })),
      ...timing.snapshot(),
      headers,
      upstreamHttpStatus: response.status,
      siwcRevision: used.revision,
    }
  } catch (error) {
    const transport = !error.status && !signal?.aborted
    return failure(
      error.status || (signal?.aborted ? 499 : 502),
      error.publicMessage ? error.code : 'siwc_upstream_transport',
      error.publicMessage || 'SIWC 调用中断或出口不可用。',
      {
        ...timing.snapshot(),
        committed,
        headers,
        upstreamHttpStatus: response?.status,
        siwcRevision: used?.revision,
        transportError: transport,
        terminalState: signal?.aborted ? 'cancelled' : committed ? 'incomplete' : 'rejected',
      },
    )
  } finally {
    clearTimeout(total)
    clearTimeout(idle)
    response?.body?.destroy?.()
  }
}
