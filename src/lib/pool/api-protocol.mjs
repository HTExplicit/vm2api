import { OFFICIAL_CLAUDE_CLI_UA } from '../identity/vm-identity.mjs'
import { officialMessagesBody } from '../protocol/anthropic-messages.mjs'
import { restoreToolNamesInSSELine } from '../protocol/anthropic-policy.mjs'
import { prepareClassifierBody } from '../protocol/request-purpose.mjs'
import { consumeClaudeSSEData } from '../protocol/convert.mjs'
import { clientCancelledResult, isCompleteAssistantMessage, mapUpstreamError } from '../core/errors.mjs'
import { isContentPolicyErrorCode } from '../core/refusal-guard.mjs'
import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'
import { messagesUrl, normalizeProtocol, resolvePreset, responsesUrl, upstreamAuthHeaders } from './api-presets.mjs'
import { claudeToOpenAIResponsesRequest } from './api-openai.mjs'
import {
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  createAnthropicSseState,
  createChatSseState,
  responsesSseToAnthropicEvents,
  isToolArgumentsError,
  responsesSseToChatChunk,
} from '../protocol/codex-convert.mjs'
import { usageFromSseLine } from '../protocol/handle-codex.mjs'
import { BETA_CONTEXT_1M } from '../protocol/claude-code-betas.mjs'
import { shouldPassContext1mByPolicy } from '../protocol/model-policy.mjs'
import { createStreamTiming } from '../protocol/stream-timing.mjs'
import { mergeUsage } from '../protocol/openai-usage.mjs'
import { fromClaudeToOpenAICompletions } from '../protocol/convert.mjs'
import { keyScopeFromRequest } from '../admin/key-scope.mjs'

export function resolveInferenceBackend(req) {
  if (req?.apiKeyKind !== 'managed') return 'oauth'
  return String(req.apiKeyRecord?.category || '')
    .trim()
    .toLowerCase() === 'api'
    ? 'api'
    : 'oauth'
}

export { messagesUrl, responsesUrl } from './api-presets.mjs'

function joinHeaderMap(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v == null || v === '') continue
    out[k] = String(v)
  }
  return out
}

/**
 * Native Anthropic Messages is a compatibility boundary.  Keep protocol
 * headers supplied by the caller, including beta names this gateway does not
 * know yet.  Headers the operator configured on the endpoint win; anthropic-beta
 * is the union of endpoint and caller tokens so neither opt-in is dropped.
 */
function forwardAnthropicProtocolHeaders(headers = {}, protocol = '', protocolKind = '', { passthrough = false } = {}) {
  if (protocol !== 'anthropic.messages' || protocolKind !== 'anthropic') return {}
  const out = {}
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName || '').toLowerCase()
    if (name === 'user-agent' && !passthrough) continue
    if (
      !name.startsWith('anthropic-') &&
      !name.startsWith('x-claude-code-') &&
      !name.startsWith('x-stainless-') &&
      name !== 'x-app' &&
      name !== 'x-client-request-id' &&
      name !== 'user-agent' &&
      name !== 'accept-language' &&
      name !== 'sec-fetch-mode'
    )
      continue
    if (rawValue == null || rawValue === '') continue
    out[name] = Array.isArray(rawValue) ? rawValue.join(',') : String(rawValue)
  }
  return out
}

function splitBetas(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Caller context-1m follows the model-page 1M policy, same as the slot path. */
function callerBetaTokens(value, model) {
  const tokens = splitBetas(value)
  if (!tokens.includes(BETA_CONTEXT_1M) || shouldPassContext1mByPolicy(model)) return tokens
  return tokens.filter((t) => t !== BETA_CONTEXT_1M)
}

function mergeCallerProtocolHeaders(base = {}, caller = {}, configured = {}, model = '') {
  const out = { ...base }
  const configuredNames = new Set(Object.keys(configured).map((k) => k.toLowerCase()))
  for (const [name, value] of Object.entries(caller)) {
    const existing = Object.keys(out).filter((k) => k.toLowerCase() === name)
    if (name === 'anthropic-beta') {
      const merged = new Set([...existing.flatMap((k) => splitBetas(out[k])), ...callerBetaTokens(value, model)])
      for (const k of existing) delete out[k]
      if (merged.size) out[name] = [...merged].join(',')
      continue
    }
    if (configuredNames.has(name)) continue
    for (const k of existing) delete out[k]
    out[name] = value
  }
  return out
}

async function readLines(stream, onLine) {
  let buf = ''
  let receivedAt = null
  for await (const chunk of stream) {
    receivedAt = Date.now()
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      await onLine(line, receivedAt)
    }
  }
  if (buf) await onLine(buf, receivedAt)
}

function openAIResponsesSseEvent(line) {
  const raw = String(line || '').trim()
  if (!raw.startsWith('data:')) return null
  const payload = raw.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function openAIResponsesItemHasOutput(item) {
  if (!item || typeof item !== 'object') return false
  if (item.arguments || item.input || item.result || item.encrypted_content) return true
  for (const value of [item.content, item.summary]) {
    if (!Array.isArray(value)) continue
    if (
      value.some(
        (part) =>
          part &&
          typeof part === 'object' &&
          (part.text || part.transcript || part.arguments || part.input || part.result || part.encrypted_content),
      )
    )
      return true
  }
  return false
}

/** Lifecycle events are transport metadata, not downstream model output. */
export function isOpenAIResponsesCommitEvent(event) {
  if (!event || typeof event !== 'object') return false
  const type = String(event.type || '').trim()
  if (
    !type ||
    type === 'error' ||
    type === 'response.failed' ||
    type === 'response.created' ||
    type === 'response.queued' ||
    type === 'response.in_progress' ||
    type === 'response.metadata' ||
    type === 'keepalive'
  )
    return false
  if (type === 'response.output_item.added' || type === 'response.output_item.done')
    return openAIResponsesItemHasOutput(event.item)
  if (
    type === 'response.content_part.added' ||
    type === 'response.content_part.done' ||
    type === 'response.reasoning_summary_part.added' ||
    type === 'response.reasoning_summary_part.done'
  )
    return !!(event.part?.text || event.part?.transcript)
  if (type === 'response.function_call_arguments.done') return !!event.arguments
  if (type === 'response.custom_tool_call_input.done') return !!event.input
  if (type === 'response.image_generation_call.partial_image') return !!event.partial_image_b64
  return type.startsWith('response.output_') || (type.startsWith('response.') && /\.(delta|done)$/.test(type))
}

function openAIResponsesFailure(event) {
  if (!event || typeof event !== 'object') return null
  if (event.type === 'error') return event
  if (event.type !== 'response.failed') return null
  return {
    type: 'error',
    error: event.response?.error || event.error || { type: 'server_error', message: 'Response failed' },
  }
}

function mappedOpenAIResponsesFailure(resultBase, event, committed, extras = {}) {
  const declared = Number(event?.error?.status || event?.status)
  const preserved = event?.error?.code
    ? { ...event, error: { ...event.error, upstream_code: event.error.code } }
    : event
  const mapped = mapUpstreamError(declared >= 400 && declared < 600 ? declared : 500, preserved)
  if (event?.error?.code && mapped.body?.error) mapped.body.error.upstream_code = event.error.code
  return {
    ...resultBase,
    ...mapped,
    ok: false,
    terminalState: committed ? 'incomplete' : 'rejected',
    committed,
    ...extras,
  }
}

function recordApiKeyFailure(picked, { status, code, message, headers = {} }, store, scheduler) {
  const accountKey = !!picked.key.source_account_id
  if (accountKey && typeof store?.getKey === 'function') {
    const current = store.getKey(picked.key.id)
    // A late response belongs to the secret actually sent, never its replacement.
    if (
      !current ||
      current.api_key !== picked.key.api_key ||
      current.source_account_id !== picked.key.source_account_id ||
      current.source_vm_id !== picked.key.source_vm_id
    )
      return
  }
  const exhausted = ['credit_balance_exhausted', 'insufficient_quota'].includes(code)
  const invalid = status === 401 || ['invalid_api_key', 'invalid_key'].includes(code)
  if (accountKey && (exhausted || invalid)) {
    // An administrator releases exhaustion; invalid keys require reconnecting.
    if (invalid) store.updateKey(picked.key.id, { disabled: true })
    else store.setKeyCooldown(picked.key.id, '9999-12-31T23:59:59.999Z')
    scheduler.reload(store.listRaw())
  } else if (status === 429 && !picked.endpoint.disable_cooling) {
    const retry = Number(headers['retry-after'] || 30)
    const until = new Date(Date.now() + Math.max(1, retry) * 1000).toISOString()
    store.setKeyCooldown(picked.key.id, until)
    scheduler.reload(store.listRaw())
  }
  if (accountKey)
    scheduler.onAccountKeyError?.(picked.key, {
      code: code || (invalid ? 'invalid_api_key' : 'api_error'),
      message: String(message || `upstream ${status}`).slice(0, 300),
    })
}

function apiResultIdentity(picked, key) {
  return {
    vmId: null,
    accountId: key.id,
    endpointId: picked.endpoint.id,
    model: picked.upstream_model,
    ...(key.source_vm_id
      ? {
          sourceVmId: key.source_vm_id,
          sourceAccountId: key.source_account_id,
          sourceEmail: key.source_email || null,
        }
      : {}),
  }
}

function accountRetryLimits(routing = {}) {
  const policy = routing.failover || {}
  const integer = (value, fallback, minimum) =>
    Number.isFinite(Number(value)) ? Math.max(minimum, Math.floor(Number(value))) : fallback
  return {
    attempts: Math.min(integer(policy.max_total_attempts, 12, 1), 1 + integer(policy.max_account_switches, 10, 0)),
    deadlineMs: integer(policy.total_retry_deadline_ms, 120_000, 0),
  }
}

/** Account API retries are only for explicit HTTP rejections before any output. */
export async function runApiInference(options = {}) {
  const scope = keyScopeFromRequest(options.req)
  if (scope.group_type !== 'openai_apikey') return runApiAttempt(options)
  const model = (options.nativeResponsesBody || options.convertedBody)?.model
  const routing = options.getRouting?.() || options.cfg?.routing || {}
  const limits = accountRetryLimits(routing)
  const excludedAccountIds = new Set()
  const excludedKeyIds = new Set()
  const startedAt = Date.now()
  let lastResult
  let attemptCount = 0
  for (let hop = 0; hop < limits.attempts; hop++) {
    if (options.signal?.aborted) return { ...clientCancelledResult(lastResult), attemptCount }
    if (hop > 0 && Date.now() - startedAt >= limits.deadlineMs) break
    const picked = options.scheduler.pick(model, Date.now(), scope, { excludedAccountIds, excludedKeyIds })
    if (!picked.ok) {
      if (lastResult) break
      return { ...(await runApiAttempt({ ...options, picked })), attemptCount }
    }
    // One account gets at most one attempt, including a transport-unknown result.
    excludedAccountIds.add(picked.key.source_account_id)
    excludedKeyIds.add(picked.key.id)
    let dispatched = false
    let dispatchAt
    let sourceKey = picked.key
    let result
    try {
      result = await runApiAttempt({
        ...options,
        picked,
        onDispatch(key) {
          dispatched = true
          sourceKey = key
          dispatchAt = Date.now()
          attemptCount++
          options.attemptsRepo?.begin({
            requestId: options.requestId,
            attemptNo: attemptCount,
            vmId: null,
            accountId: key.id,
            model: picked.upstream_model,
            selectionReason: 'account_api',
            sourceAccountId: key.source_account_id,
            sourceVmId: key.source_vm_id,
            sourceEmail: key.source_email,
          })
        },
      })
    } catch (error) {
      result = {
        ...apiResultIdentity(picked, sourceKey),
        ok: false,
        status: 502,
        via: 'api-kernel',
        transportError: true,
        committed: !!options.res?.headersSent,
        terminalState: options.res?.headersSent ? 'incomplete' : 'transport_error',
        body: {
          type: 'error',
          error: {
            type: 'api_error',
            code: error.code || 'upstream_stream_interrupted',
            message: String(error.message || error).slice(0, 300),
          },
        },
      }
      if (options.signal?.aborted) result = clientCancelledResult(result)
    }
    if (options.signal?.aborted && !result.clientCancelled) result = clientCancelledResult(result)
    if (!dispatched && lastResult) break
    lastResult = { ...result, attemptCount }
    const maySwitch =
      result.retryableAccountRejection === true &&
      !options.res?.headersSent &&
      !options.signal?.aborted &&
      hop + 1 < limits.attempts &&
      Date.now() - startedAt < limits.deadlineMs
    if (dispatched)
      options.attemptsRepo?.complete(options.requestId, attemptCount, {
        upstreamStatus: result.status,
        errorScope: result.ok ? null : result.status === 401 ? 'credential' : 'account',
        action: maySwitch ? 'next_unit' : 'return',
        downstreamCommitted: !!options.res?.headersSent || !!result.committed,
        terminalState: result.terminalState,
        usage: result.usage,
        ttftMs: result.ttftMs,
        latencyMs: Date.now() - dispatchAt,
        errorCode: result.body?.error?.upstream_code || result.body?.error?.code || null,
        errorMessage: result.body?.error?.message || null,
      })
    if (!maySwitch) break
  }
  return lastResult
}

async function runApiAttempt({
  req,
  res,
  cfg,
  scheduler,
  store,
  protocol,
  inbound,
  convertedBody,
  nativeResponsesBody = null,
  clientStream,
  deliveryMode,
  signal,
  timeoutMs,
  personaHideTokens,
  cacheTtl,
  converters,
  requestContext = null,
  forwardImpl = forwardApi,
  passthrough = false,
  toolNames = {},
  picked: selected = null,
  onDispatch = null,
} = {}) {
  const model = (nativeResponsesBody || convertedBody)?.model
  const scope = keyScopeFromRequest(req)
  const picked = selected || scheduler.pick(model, Date.now(), scope)
  if (!picked.ok) {
    return {
      ok: false,
      status: picked.code === 'model_not_found' ? 404 : 503,
      via: 'api-kernel',
      body: { type: 'error', error: { type: 'api_error', code: picked.code, message: picked.message } },
      terminalState: 'exhausted',
    }
  }

  const preset = resolvePreset(picked.endpoint.kind, picked.endpoint)
  const protocolKind = normalizeProtocol(picked.endpoint.protocol || preset.protocol, preset.kind)
  const extraHeaders = joinHeaderMap(picked.endpoint.headers)
  const isOpenAI = protocolKind === 'openai'
  const nativeResponses = !!nativeResponsesBody && isOpenAI
  const canonical = nativeResponses ? nativeResponsesBody : officialMessagesBody(convertedBody)
  if (requestContext && (isOpenAI || picked.upstream_model !== canonical.model)) {
    return {
      ok: false,
      status: 400,
      terminalState: 'rejected',
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'classifier_model_incompatible',
          message: 'Classifier requests require the selected Anthropic model without endpoint model substitution.',
        },
      },
    }
  }
  const body = isOpenAI
    ? {
        ...(nativeResponses ? nativeResponsesBody : claudeToOpenAIResponsesRequest(canonical)),
        model: picked.upstream_model,
        stream: true,
      }
    : { ...canonical, model: picked.upstream_model, stream: true }
  if (nativeResponses) {
    // Codex Lite's additional_tools items are public Responses input. Keep
    // their position and remove only metadata from Codex's internal transport.
    delete body.client_metadata
    if (Array.isArray(body.input)) {
      body.input = body.input.map((item) => {
        if (!item || !Object.hasOwn(item, 'internal_chat_message_metadata_passthrough')) return item
        const publicItem = { ...item }
        delete publicItem.internal_chat_message_metadata_passthrough
        return publicItem
      })
    }
  }
  if (requestContext) Object.assign(body, prepareClassifierBody(body))
  const callerProtocolHeaders = forwardAnthropicProtocolHeaders(req?.headers, protocol, protocolKind, {
    passthrough,
  })
  const authHeaders = upstreamAuthHeaders(protocolKind, picked.key.api_key, {
    ...extraHeaders,
    auth_scheme: picked.endpoint.auth_scheme || extraHeaders.auth_scheme || extraHeaders.anthropic_apikey_auth_scheme,
  })
  if (
    protocolKind === 'anthropic' &&
    !passthrough &&
    !Object.keys(authHeaders).some((key) => key.toLowerCase() === 'user-agent')
  ) {
    authHeaders['user-agent'] = OFFICIAL_CLAUDE_CLI_UA
  }
  const headers = mergeCallerProtocolHeaders(
    {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...authHeaders,
    },
    callerProtocolHeaders,
    extraHeaders,
    canonical.model,
  )

  const timing = createStreamTiming()
  let upstream
  let dispatchedKey = picked.key
  let dispatched = false
  try {
    const currentKey = scheduler.resolveKey ? scheduler.resolveKey(picked.key, scope) : picked.key
    if (!currentKey) {
      return {
        ok: false,
        status: 503,
        via: 'api-kernel',
        body: {
          type: 'error',
          error: { type: 'api_error', code: 'api_account_unavailable', message: '所选 API 账号或绑定代理不可用' },
        },
        terminalState: 'exhausted',
      }
    }
    dispatchedKey = currentKey
    if (currentKey.api_key !== picked.key.api_key) {
      const currentAuth = upstreamAuthHeaders(protocolKind, currentKey.api_key, {
        ...extraHeaders,
        auth_scheme: picked.endpoint.auth_scheme || extraHeaders.auth_scheme,
      })
      for (const [name, value] of Object.entries(currentAuth)) headers[name] = value
    }
    onDispatch?.(currentKey)
    dispatched = true
    upstream = await forwardImpl({
      cfg,
      url: isOpenAI ? responsesUrl(preset.base_url) : messagesUrl(preset.base_url),
      headers,
      body,
      proxyUrl: currentKey.proxy_url,
      signal,
      timeoutMs,
    })
  } catch (error) {
    const failure = {
      ...(dispatched ? apiResultIdentity(picked, dispatchedKey) : {}),
      ok: false,
      status: 502,
      via: 'api-kernel',
      body: {
        type: 'error',
        error: {
          type: 'api_error',
          code: error.code || 'api_kernel_transport',
          message: String(error.message || error).slice(0, 300),
        },
      },
      terminalState: 'transport_error',
      transportError: true,
    }
    return signal?.aborted ? clientCancelledResult(failure) : failure
  }

  const status = Number(upstream.statusCode) || 502
  const resultBase = {
    ok: status >= 200 && status < 300,
    status,
    via: 'api-kernel',
    ...apiResultIdentity(picked, dispatchedKey),
    headers: { ...upstream.headers },
  }

  if (status >= 400) {
    const payload = await readApiJson(upstream).catch(() => ({}))
    const message = payload?.error?.message || payload?.message || `upstream ${status}`
    const upstreamCode = String(payload?.error?.code || payload?.code || '').trim()
    const contentCode = isContentPolicyErrorCode(upstreamCode) ? upstreamCode.toLowerCase() : ''
    recordApiKeyFailure(
      { ...picked, key: dispatchedKey },
      { status, code: upstreamCode, message, headers: upstream.headers },
      store,
      scheduler,
    )
    return {
      ...resultBase,
      ok: false,
      body: {
        type: 'error',
        error: {
          ...(requestContext ? payload?.error : {}),
          ...(upstreamCode ? { upstream_code: upstreamCode } : {}),
          ...(!requestContext && (contentCode || upstreamCode) ? { code: contentCode || upstreamCode } : {}),
          type: requestContext ? payload?.error?.type || 'api_error' : 'api_error',
          message: String(message).slice(0, 300),
        },
      },
      terminalState: 'rejected',
      retryableAccountRejection:
        !!picked.key.source_account_id &&
        (status === 401 ||
          ['invalid_api_key', 'invalid_key', 'credit_balance_exhausted', 'insufficient_quota'].includes(upstreamCode) ||
          status === 429),
    }
  }

  if (isOpenAI) {
    const result = await runOpenAIResponsesUpstream({
      upstream,
      resultBase,
      protocol,
      inbound,
      clientStream,
      deliveryMode,
      res,
      converters,
      body,
      timing,
      nativeResponses,
    })
    if (!result.ok) {
      recordApiKeyFailure(
        { ...picked, key: dispatchedKey },
        {
          status: result.status,
          code: result.body?.error?.upstream_code || result.body?.error?.details?.upstream_code,
          message: result.body?.error?.message,
          headers: result.headers,
        },
        store,
        scheduler,
      )
    }
    return result
  }

  const classifierSseState = { dataBuf: '' }
  let classifierError = null
  let classifierStopped = false
  let streamedUsage = null
  const readUpstreamLines = async (onLine) => {
    try {
      await readLines(upstream, async (line, receivedAt) => {
        line = restoreToolNamesInSSELine(line, toolNames)
        const event = consumeClaudeSSEData(line, classifierSseState)
        timing.observe(event, receivedAt)
        streamedUsage = mergeUsage(streamedUsage, event?.message?.usage || event?.usage)
        if (requestContext) {
          // The same decoded event drives classifier validation and performance timing.
          if (event?.type === 'error')
            classifierError = {
              ...event,
              error: { ...event.error, ...(event.error?.code ? { upstream_code: event.error.code } : {}) },
            }
          if (event?.type === 'message_stop') classifierStopped = true
        }
        await onLine(line)
      })
    } catch (error) {
      if (!requestContext) throw error
      classifierError = {
        type: 'error',
        error: {
          type: 'api_error',
          code: 'upstream_stream_interrupted',
          status: 502,
          message: String(error.message || 'Classifier stream interrupted').slice(0, 300),
        },
      }
    }
  }
  const classifierFailure = () => {
    if (!requestContext || (!classifierError && classifierStopped)) return null
    const body = classifierError || {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'upstream_stream_interrupted',
        status: 502,
        message: 'Classifier stream ended before message_stop',
      },
    }
    const declared = Number(body.error?.status)
    const status = declared >= 400 && declared < 600 ? declared : mapUpstreamError(200, body).status
    return {
      ...resultBase,
      ok: false,
      status,
      body,
      headers: {
        ...resultBase.headers,
        ...(body.error?.retry_after ? { 'retry-after': String(body.error.retry_after) } : {}),
      },
      terminalState: 'rejected',
    }
  }

  if (!clientStream) {
    const assembler = converters.createClaudeMessageAssembler()
    let committed = false
    let sawMessageStop = false
    let terminalError = null
    await readUpstreamLines(async (line) => {
      applyMaybeUsageHide(line, personaHideTokens, cacheTtl, converters)
      converters.applyClaudeSSELineToMessage(line, assembler)
      const raw = String(line || '')
      if (raw.startsWith('data:')) {
        if (!committed) committed = true
        const piece = raw.slice(5).trim()
        if (piece && piece !== '[DONE]') {
          try {
            const evt = JSON.parse(piece)
            if (evt?.type === 'message_stop') sawMessageStop = true
            if (evt?.type === 'error') terminalError = evt
          } catch {}
        }
      }
    })
    const failure = classifierFailure()
    if (failure) return { ...failure, ...timing.snapshot(), committed: false }
    if (terminalError) {
      const declared = Number(terminalError.error?.status)
      const status = declared >= 400 && declared < 600 ? declared : mapUpstreamError(200, terminalError).status
      return {
        ...resultBase,
        ...timing.snapshot(),
        ok: false,
        status,
        body: terminalError,
        usage: assembler.message?.usage || null,
        terminalState: 'rejected',
        committed,
        sawMessageStop,
      }
    }
    const assembled = assembler.message
    if (!sawMessageStop) {
      return {
        ...resultBase,
        ...timing.snapshot(),
        ok: false,
        body: assembled || { type: 'error', error: { message: 'empty api upstream' } },
        usage: assembled?.usage || null,
        terminalState: assembled || committed ? 'incomplete' : 'rejected',
        committed,
        sawMessageStop: false,
      }
    }
    const hop = { body: assembled, stopReason: assembled?.stop_reason, sawMessageStop: true }
    const complete = resultBase.ok && isCompleteAssistantMessage(hop)
    return {
      ...resultBase,
      ...timing.snapshot(),
      ok: complete,
      body: assembled || { type: 'error', error: { message: 'empty api upstream' } },
      usage: assembled?.usage || null,
      terminalState: complete ? 'verified' : 'incomplete',
      committed,
      sawMessageStop: true,
    }
  }

  let state
  if (protocol === 'openai.chat')
    state = converters.createOpenAIChatStreamState(inbound.model || body.model, picked.endpoint.id)
  else if (protocol === 'openai.completions')
    state = converters.createOpenAICompletionStreamState(inbound.model || body.model, picked.endpoint.id)
  else if (protocol === 'openai.responses')
    state = converters.createResponsesStreamState(inbound.model || body.model, picked.endpoint.id)

  let committed = false
  let sawStop = false
  await readUpstreamLines(async (line) => {
    if (personaHideTokens) line = converters.hidePersonaUsageInSseLine(line, personaHideTokens, cacheTtl) || line
    if (String(line).includes('message_stop')) sawStop = true
    if (!committed && String(line).startsWith('data:')) {
      committed = true
      if (protocol === 'anthropic.messages' && !res.headersSent) converters.writeSSEHeaders(res)
    }
    if (protocol === 'anthropic.messages') {
      if (!res.headersSent) converters.writeSSEHeaders(res)
      res.write(String(line).endsWith('\n') ? String(line) : `${line}\n`)
      return
    }
    const writeChunks = (chunks) => {
      if (!chunks.length) return
      if (!res.headersSent) converters.writeSSEHeaders(res)
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    if (protocol === 'openai.chat') writeChunks(converters.claudeSSELineToOpenAIChatChunks(line, state))
    else if (protocol === 'openai.completions')
      writeChunks(converters.claudeSSELineToOpenAICompletionChunks(line, state))
    else writeChunks(converters.claudeSSELineToResponsesEvents(line, state))
  })

  const failure = classifierFailure()
  if (failure) return { ...failure, ...timing.snapshot(), committed }

  return {
    ...resultBase,
    ...timing.snapshot(),
    usage: streamedUsage,
    ok: resultBase.ok && (deliveryMode !== 'verified' || sawStop),
    terminalState: sawStop ? 'verified' : committed ? 'incomplete' : 'rejected',
    committed,
  }
}

async function runOpenAIResponsesUpstream({
  upstream,
  resultBase,
  protocol,
  inbound,
  clientStream,
  deliveryMode,
  res,
  converters,
  body,
  timing,
  nativeResponses = false,
}) {
  const chunks = []
  const anthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
  const chatSse = createChatSseState()
  let conversionError = null
  let committed = false
  let completed = false
  let downstreamDone = false
  let sawTerminal = false
  let streamedUsage = null
  let terminalFailure = null
  let nativeCompleted = false
  const pendingLines = []

  const writeStreamLine = (raw) => {
    if (!res.headersSent) converters.writeSSEHeaders(res)
    if (protocol === 'openai.responses') {
      res.write(raw.endsWith('\n') ? raw : raw + '\n')
      if (/response\.(completed|done)/.test(raw)) completed = true
      if (raw.trim() === 'data: [DONE]') downstreamDone = true
      return
    }
    try {
      let mapped =
        protocol === 'anthropic.messages'
          ? responsesSseToAnthropicEvents(raw, anthropicSse)
          : responsesSseToChatChunk(raw, 'codex', chatSse)
      if (mapped && protocol === 'openai.completions') {
        mapped = mapped
          .split('\n')
          .map((line) => {
            if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') return line
            const chunk = JSON.parse(line.slice(5))
            const choice = chunk.choices?.[0]
            const completion = fromClaudeToOpenAICompletions(
              { id: chunk.id, content: [{ type: 'text', text: choice?.delta?.content || '' }], usage: chunk.usage },
              inbound?.model || body.model,
            )
            completion.choices[0].finish_reason = choice?.finish_reason ?? null
            if (!chunk.usage) delete completion.usage
            return `data: ${JSON.stringify(completion)}`
          })
          .join('\n')
      }
      if (mapped) {
        res.write(mapped)
        if (mapped.includes('data: [DONE]')) downstreamDone = true
        if (mapped.includes('[DONE]') || mapped.includes('event: message_stop\n')) completed = true
      }
    } catch (error) {
      if (error.code !== 'tool_arguments_mismatch') throw error
      conversionError = { type: 'upstream_protocol_error', code: error.code, message: error.message }
      const payload = JSON.stringify({ error: conversionError })
      res.write(
        protocol === 'anthropic.messages'
          ? 'event: error\ndata: ' + JSON.stringify({ type: 'error', error: conversionError }) + '\n\n'
          : 'data: ' + payload + '\n\ndata: [DONE]\n\n',
      )
    }
  }

  try {
    await readLines(upstream, async (line, receivedAt) => {
      if (conversionError) return
      const raw = String(line || '')
      const event = openAIResponsesSseEvent(raw)
      timing.observe(event, receivedAt)
      const failure = openAIResponsesFailure(event)
      if (failure) terminalFailure = failure
      const seen = usageFromSseLine(raw)
      if (seen) streamedUsage = mergeUsage(streamedUsage, seen)
      const startsOutput = isOpenAIResponsesCommitEvent(event)
      const completes = event?.type === 'response.completed' || event?.type === 'response.done'
      if (completes || event?.type === 'response.incomplete')
        nativeCompleted = completes && event.response?.status === 'completed'
      const wasCommitted = committed
      if (!committed && (startsOutput || completes)) committed = true
      if (!clientStream) {
        chunks.push(raw)
        if (/response\.(completed|done)/.test(raw) || raw.trim() === 'data: [DONE]') sawTerminal = true
        return
      }
      if (!wasCommitted) {
        pendingLines.push(raw)
        if (!committed) return
        for (const pending of pendingLines.splice(0)) writeStreamLine(pending)
        return
      }
      writeStreamLine(raw)
    })
  } catch (error) {
    if (!nativeResponses) throw error
    return {
      ...resultBase,
      ...timing.snapshot(),
      ok: false,
      status: 502,
      body: { error: { type: 'api_error', code: 'upstream_stream_interrupted', message: String(error.message) } },
      terminalState: committed ? 'incomplete' : 'rejected',
      committed,
      usage: streamedUsage,
    }
  }

  if (!clientStream) {
    if (terminalFailure)
      return mappedOpenAIResponsesFailure(resultBase, terminalFailure, committed, {
        usage: streamedUsage,
        ...timing.snapshot(),
      })
    let assembled
    let outBody
    try {
      assembled = assembleCodexBodyFromSse(chunks, {})
      // Native Responses retain their output items. Compatibility clients use
      // the canonical message consumed by the protocol handler.
      outBody = nativeResponses ? assembled : codexBodyToAnthropicMessage(assembled, inbound?.model || body?.model)
    } catch (error) {
      if (!isToolArgumentsError(error)) throw error
      return {
        ...resultBase,
        ...timing.snapshot(),
        ok: false,
        status: 502,
        body: { error: { type: 'upstream_protocol_error', code: error.code, message: error.message } },
        terminalState: 'incomplete',
        committed,
        usage: streamedUsage,
      }
    }
    const hasBody = !!(assembled && (assembled.output || assembled.id || outBody))
    const complete = resultBase.ok && (nativeResponses ? nativeCompleted : sawTerminal) && hasBody
    return {
      ...resultBase,
      ...timing.snapshot(),
      ok: complete,
      body: outBody,
      ...(nativeResponses ? { nativeResponse: outBody } : {}),
      usage: mergeUsage(streamedUsage, assembled?.usage || outBody?.usage),
      terminalState: complete ? 'verified' : hasBody ? 'incomplete' : 'rejected',
      committed,
    }
  }
  if (terminalFailure)
    return mappedOpenAIResponsesFailure(resultBase, terminalFailure, committed, {
      usage: streamedUsage,
      ...timing.snapshot(),
    })
  if (conversionError)
    return {
      ...resultBase,
      ok: false,
      status: 502,
      body: { error: conversionError },
      terminalState: 'incomplete',
      committed,
      usage: streamedUsage,
      ...timing.snapshot(),
    }

  return {
    ...resultBase,
    ok: resultBase.ok && (nativeResponses ? nativeCompleted : deliveryMode !== 'verified' || completed || committed),
    usage: streamedUsage,
    terminalState: (nativeResponses ? nativeCompleted : completed) ? 'verified' : committed ? 'incomplete' : 'rejected',
    committed,
    downstreamDone,
    ...timing.snapshot(),
  }
}

function applyMaybeUsageHide() {}
