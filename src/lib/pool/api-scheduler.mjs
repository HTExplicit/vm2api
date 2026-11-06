import { CLAUDE_OFFICIAL_URL, OPENAI_OFFICIAL_URL, normalizeProtocol, trimBaseUrl } from './api-presets.mjs'
import {
  isCatalogModelId,
  isCodexCatalogModel,
  listGptPublicModels,
  listOfficialModels,
  resolveCatalogModel,
} from '../protocol/models.mjs'
import { isGptSeriesId } from '../protocol/gpt-ids.mjs'

/**
 * CLIProxy-shaped picker: grouped round-robin by endpoint then key.
 * Same alias across endpoints shares a model id; prefix/alias pins an endpoint.
 */
import { accountApiModels } from '../openai-api/model-catalog.mjs'

function norm(s) {
  return String(s || '').trim()
}

function lower(s) {
  return norm(s).toLowerCase()
}

function isOfficialClaude(ep) {
  if (!ep) return false
  if (ep.kind === 'claude') return true
  const u = trimBaseUrl(ep.base_url)
  return u === CLAUDE_OFFICIAL_URL
}

function isOfficialOpenAI(ep) {
  if (!ep) return false
  if (ep.kind === 'openai') return true
  const u = trimBaseUrl(ep.base_url)
  return u === OPENAI_OFFICIAL_URL
}

export function stripPrefix(model, prefix) {
  const p = norm(prefix)
  if (!p) return norm(model)
  const needle = p + '/'
  const raw = norm(model)
  if (raw.toLowerCase().startsWith(needle.toLowerCase())) return raw.slice(needle.length)
  return raw
}

export function modelIdsForEndpoint(ep, { forcePrefix = false, fullCatalog = true } = {}) {
  const prefix = norm(ep.prefix)
  const ids = []
  const seen = new Set()
  const add = (alias) => {
    const a = norm(alias)
    if (!a) return
    if (!forcePrefix || !prefix) {
      if (!seen.has(lower(a))) {
        seen.add(lower(a))
        ids.push(a)
      }
    }
    if (prefix) {
      const pref = `${prefix}/${a}`
      if (!seen.has(lower(pref))) {
        seen.add(lower(pref))
        ids.push(pref)
      }
    }
  }
  for (const m of ep?.models || []) {
    add(m.alias || m.name)
  }
  if (!fullCatalog) return ids
  if (isOfficialClaude(ep)) {
    try {
      for (const m of listOfficialModels()) {
        add(m.id)
      }
    } catch {}
  } else if (isOfficialOpenAI(ep)) {
    try {
      for (const m of listGptPublicModels()) {
        add(m.id)
      }
    } catch {}
  }
  return ids
}

export function resolveUpstreamPool(ep, requestedModel, { fullCatalog = true } = {}) {
  const want = lower(stripPrefix(requestedModel, ep?.prefix))
  if (!want) return []
  const out = []
  const seen = new Set()
  for (const m of ep?.models || []) {
    if (lower(m.alias) !== want) continue
    const name = norm(m.name) || norm(m.alias)
    const key = lower(name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  if (out.length > 0 || !fullCatalog) return out
  if (isOfficialClaude(ep)) {
    const raw = stripPrefix(requestedModel, ep?.prefix)
    const resolved = resolveCatalogModel(raw)
    if (resolved?.ok && resolved.model) return [resolved.model]
    if (isCatalogModelId(raw)) return [raw]
  } else if (isOfficialOpenAI(ep)) {
    const raw = stripPrefix(requestedModel, ep?.prefix)
    if (isGptSeriesId(raw) || isCodexCatalogModel(raw)) return [raw]
  }
  return []
}

export function endpointMatchesModel(ep, requestedModel, options) {
  if (!ep || ep.disabled) return false
  const raw = norm(requestedModel)
  const prefix = norm(ep.prefix)
  if (prefix && raw.toLowerCase().startsWith((prefix + '/').toLowerCase())) {
    return resolveUpstreamPool(ep, raw, options).length > 0
  }
  return resolveUpstreamPool(ep, raw, options).length > 0
}

function keyReady(key, now, disableCooling) {
  if (!key || key.disabled) return false
  if (key.source_account_id && key.cooldown_until === '9999-12-31T23:59:59.999Z') return false
  if (disableCooling) return true
  if (!key.cooldown_until) return true
  return Date.parse(key.cooldown_until) <= now
}

export class ApiScheduler {
  constructor({ resolveAccountKey = null, onAccountKeyError = null, getRouting = () => ({}), getAccountModels } = {}) {
    this.endpoints = []
    this.parentCursor = 0
    this.childCursor = new Map()
    this.modelCursor = new Map()
    this.forcePrefix = false
    this.resolveAccountKey = resolveAccountKey
    this.onAccountKeyError = onAccountKeyError
    this.getAccountModels = getAccountModels || (() => accountApiModels(undefined, getRouting()))
  }

  reload(endpoints = []) {
    this.endpoints = Array.isArray(endpoints) ? endpoints : []
  }

  scopedEndpoints(scope) {
    if (scope?.group_type !== 'openai_apikey') return this.endpoints
    const models = this.getAccountModels()
    return this.endpoints.filter((ep) => ep.kind === 'openai').map((ep) => ({ ...ep, models }))
  }

  /** Resolve again immediately before sending: proxy bindings are live configuration. */
  resolveKey(key, scope = {}) {
    const owned = !!(key?.source_vm_id || key?.source_account_id)
    if (scope?.group_type !== 'openai_apikey') return owned ? null : key
    if (!key?.source_vm_id || !key.source_account_id || !scope.allowed_vms?.includes(key.source_vm_id)) return null
    const source = this.resolveAccountKey?.(key)
    if (
      !source?.enabled ||
      source.accountId !== key.source_account_id ||
      !source.proxyUrl ||
      (source.call_status && source.call_status !== 'ready')
    )
      return null
    return { ...key, ...(source.key || {}), proxy_url: source.proxyUrl, source_email: source.email || null }
  }

  catalog(scope = {}) {
    const data = []
    const seen = new Set()
    const targetGroup = String(scope.group_type || 'all').toLowerCase()
    const fullCatalog = scope.group_type !== 'openai_apikey'
    for (const ep of this.scopedEndpoints(scope)) {
      if (ep.disabled) continue
      const proto = normalizeProtocol(ep.protocol, ep.kind)
      if (targetGroup === 'anthropic' && proto !== 'anthropic') continue
      if (targetGroup === 'openai' && proto !== 'openai') continue
      if (scope.group_type === 'openai_apikey' && ep.kind !== 'openai') continue
      const visibleKeys = (ep.api_key_entries || []).filter((key) => this.resolveKey(key, scope))
      if (!visibleKeys.length && (scope.group_type === 'openai_apikey' || ep.api_key_entries?.length)) continue
      if (
        scope.group_type === 'openai_apikey' &&
        !visibleKeys.some((key) => keyReady(key, Date.now(), ep.disable_cooling))
      )
        continue
      for (const id of modelIdsForEndpoint(ep, { forcePrefix: this.forcePrefix, fullCatalog })) {
        const k = lower(id)
        if (seen.has(k)) continue
        seen.add(k)
        data.push({
          id,
          object: 'model',
          type: 'model',
          display_name: id,
          owned_by: ep.name || 'api',
        })
      }
    }
    return { object: 'list', data, source: 'api-endpoints' }
  }

  pick(requestedModel, now = Date.now(), scope = {}, { excludedAccountIds, excludedKeyIds } = {}) {
    const targetGroup = String(scope.group_type || 'all').toLowerCase()
    const modelOptions = { fullCatalog: scope.group_type !== 'openai_apikey' }
    const parents = this.scopedEndpoints(scope)
      .filter((ep) => {
        if (ep.disabled) return false
        const proto = normalizeProtocol(ep.protocol, ep.kind)
        if (targetGroup === 'anthropic' && proto !== 'anthropic') return false
        if (targetGroup === 'openai' && proto !== 'openai') return false
        return endpointMatchesModel(ep, requestedModel, modelOptions)
      })
      .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))
    if (!parents.length) {
      return { ok: false, code: 'model_not_found', message: `no api endpoint serves ${requestedModel}` }
    }
    const start = this.parentCursor % parents.length
    for (let off = 0; off < parents.length; off++) {
      const ep = parents[(start + off) % parents.length]
      const keys = (ep.api_key_entries || [])
        .filter((key) => !excludedAccountIds?.has(key.source_account_id) && !excludedKeyIds?.has(key.id))
        .filter((key) => keyReady(key, now, ep.disable_cooling))
        .map((key) => this.resolveKey(key, scope))
        .filter(Boolean)
      if (!keys.length) continue
      const c = this.childCursor.get(ep.id) || 0
      const key = keys[c % keys.length]
      this.childCursor.set(ep.id, c + 1)
      this.parentCursor = start + off + 1
      const pool = resolveUpstreamPool(ep, requestedModel, modelOptions)
      const mk = `${ep.id}:${lower(requestedModel)}`
      const mi = this.modelCursor.get(mk) || 0
      const upstreamModel = pool[mi % pool.length] || requestedModel
      this.modelCursor.set(mk, mi + 1)
      return {
        ok: true,
        endpoint: ep,
        key,
        upstream_model: upstreamModel,
        requested_model: requestedModel,
      }
    }
    return { ok: false, code: 'api_pool_exhausted', message: 'no ready api key for this model' }
  }
}
