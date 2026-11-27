import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import fetch from 'node-fetch'
import {
  codexSiwcOwner,
  codexSiwcPath,
  readCodexSiwc,
  sameSiwcOwner,
  siwcCanRenew,
  siwcHasAccess,
  siwcRefreshDue,
  summarizeCodexSiwc,
  writeCodexSiwc,
} from '../vm/codex-siwc-store.mjs'
import { readCodexAccounts } from '../vm/codex-slot.mjs'
import { clearOpenAIAccountHold, openAIAccountHold } from '../pool/openai-account-runtime.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { withVmLock } from '../vm/vm-file.mjs'
import { createProxyAgent } from '../vm/proxy-agent.mjs'
import { resolveSlotOAuthProxy } from '../vm/proxy-resolve.mjs'
import { decodeJwtPayload } from './openai-jwt.mjs'

const ISSUER = 'https://auth.openai.com'
const TOKEN_URL = ISSUER + '/api/accounts/oauth/token'
const AUTHORIZE_URL = ISSUER + '/api/accounts/authorize'
const JWKS_URL = ISSUER + '/.well-known/jwks.json'
export const SIWC_RESOURCE = 'https://api.openai.com/v1'
export const SIWC_REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback'
const DYNAMIC_CLIENT = 'dynamic_agent_client'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPES = 'openid profile email offline_access resource.invoke ' + PLAN_SCOPE
const BIND_TTL = 5 * 60_000
const RENEWAL_BACKOFF_START = 30_000
const RENEWAL_BACKOFF_MAX = 5 * 60_000
const REJECTED_GRANTS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
  'invalid_client',
])
const DNS_NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN'])
const CONNECT_NOT_SENT = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'])
const REFRESH_NOT_SENT = Symbol('refresh_not_sent')

function issue(code, publicMessage, status = 400) {
  return Object.assign(new Error(publicMessage), { code, publicMessage, status })
}

function needSignIn() {
  return issue('siwc_reauth_required', '请在槽位凭据中重新绑定 SIWC，或手动切回普通 Codex。', 401)
}

function nonce() {
  return randomBytes(32).toString('base64url')
}

function instant(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const ms = typeof value === 'number' || /^\d+(\.\d+)?$/.test(text) ? Number(value) * 1000 : Date.parse(text)
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? ms : null
}

function wasNotSent(error) {
  if (DNS_NOT_SENT.has(error?.code)) return true
  // node-fetch v2 preserves the error code but can wrap the connect syscall in its reason text.
  return (
    CONNECT_NOT_SENT.has(error?.code) &&
    (error.syscall === 'connect' || String(error.message).includes('reason: connect ' + error.code + ' '))
  )
}

function renewalBackoff(record, now) {
  const previous =
    Number.isSafeInteger(record.refresh_failures) && record.refresh_failures > 0 ? record.refresh_failures : 0
  const failures = Math.min(previous + 1, 5)
  const delay = Math.min(RENEWAL_BACKOFF_MAX, RENEWAL_BACKOFF_START * 2 ** (failures - 1))
  return { state: 'ready', refresh_failures: failures, retry_at: now + delay }
}

function parseCallback(raw, attempt) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw issue('siwc_callback_invalid', '请粘贴 OpenAI 返回的完整回调 URL。')
  }
  if (url.origin + url.pathname !== SIWC_REDIRECT_URI || url.username || url.password || url.hash) {
    throw issue('siwc_callback_invalid', '回调地址与此次 SIWC 授权不匹配。')
  }
  const parameter = (key) => {
    const values = url.searchParams.getAll(key)
    if (values.length > 1) throw issue('siwc_callback_invalid', '授权回调包含重复参数。')
    return values[0] || ''
  }
  if (parameter('state') !== attempt.id) throw issue('siwc_state_mismatch', '回调状态与此次 SIWC 授权不匹配。')
  if (parameter('error')) return { denied: true }
  const code = parameter('code')
  const issuedId = parameter('client_id')
  const clientId = issuedId || attempt.clientId
  if (!code || !clientId || clientId === DYNAMIC_CLIENT || (attempt.clientId && clientId !== attempt.clientId)) {
    throw issue('siwc_callback_invalid', '授权回调缺少有效的授权码或客户端 ID。')
  }
  return { code, clientId }
}

function validateIdToken(token, keys, attempt, clientId, now) {
  try {
    const [head, body, signature, extra] = token.split('.')
    const header = JSON.parse(Buffer.from(head, 'base64url').toString())
    const claims = decodeJwtPayload(token)
    const key = keys.find((item) => item.kid === header.kid && item.kty === 'RSA')
    const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud]
    if (
      extra !== undefined ||
      header.alg !== 'RS256' ||
      !key ||
      claims?.iss !== ISSUER ||
      !audience.includes(clientId) ||
      (audience.length > 1 && claims.azp !== clientId) ||
      claims.nonce !== attempt.nonce ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= now ||
      !verify(
        'RSA-SHA256',
        Buffer.from(head + '.' + body),
        createPublicKey({ key, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      )
    ) {
      throw new Error('invalid claims or signature')
    }
    return claims
  } catch {
    throw issue('siwc_id_token_invalid', 'OpenAI 返回的 SIWC 身份凭据校验失败。')
  }
}

function verifiedEmail(identity) {
  return identity?.email_verified === true && typeof identity.email === 'string'
    ? identity.email.trim().toLowerCase()
    : ''
}

function tokenFields(payload, now, previous = {}) {
  const scope = Object.hasOwn(payload || {}, 'scope') ? payload.scope : previous.scope
  const rawTtl = payload?.expires_in
  const ttl = typeof rawTtl === 'number' || typeof rawTtl === 'string' ? Number(rawTtl) : NaN
  const expiresAt = now + ttl * 1000
  if (
    typeof payload?.access_token !== 'string' ||
    !payload.access_token.trim() ||
    typeof payload.refresh_token !== 'string' ||
    !payload.refresh_token.trim() ||
    !Number.isSafeInteger(ttl) ||
    ttl <= 0 ||
    expiresAt > 8.64e15 ||
    typeof scope !== 'string' ||
    !scope.trim()
  ) {
    throw issue('siwc_grant_incomplete', 'OpenAI 未返回可续期的 ChatGPT 计划授权。请重新绑定。')
  }
  if (!scope.split(/\s+/).includes(PLAN_SCOPE)) {
    throw issue('siwc_plan_scope_missing', 'OpenAI 授权缺少 ChatGPT 计划权限，请重新绑定。')
  }
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: expiresAt,
    earliest_refresh_at: instant(payload.earliest_refresh_at),
    scope,
    state: 'ready',
    access_rejected: false,
    retry_at: null,
    refresh_failures: 0,
  }
}

/** One control-plane owner for each slot's SIWC grant, including across restart. */
export class CodexSiwcService {
  constructor({ projectRoot, getVm, proxyPool, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { projectRoot, getVm, proxyPool, fetchImpl, now })
    this.attempts = new Map()
    this.refreshes = new Map()
    this.catalogs = new Map()
  }

  locked(vmId, action) {
    // Slot lifecycle handlers can wait for a browser callback under the VM record lock.
    return withVmLock(codexSiwcPath(this.projectRoot, vmId), action)
  }

  read(vmId) {
    return readCodexSiwc(this.projectRoot, vmId)
  }

  write(vmId, record) {
    return writeCodexSiwc(this.projectRoot, vmId, record)
  }

  slot(vmId) {
    const vm = this.getVm(vmId)
    if (!vm || !isCodexVm(vm)) throw issue('vm_not_found', 'GPT 槽位不存在。', 404)
    const account = readCodexAccounts(this.projectRoot, vmId)[0] || {}
    return { vm, owner: codexSiwcOwner(account), account }
  }

  view(vmId) {
    const { owner } = this.slot(vmId)
    return summarizeCodexSiwc(this.read(vmId), owner, this.now())
  }

  slotExit(vm) {
    const proxyUrl = resolveSlotOAuthProxy(vm, this.proxyPool)
    return { proxyUrl, agent: proxyUrl ? createProxyAgent(proxyUrl) : undefined }
  }

  request(vmId, url, options = {}, { proxyUrl, agent } = this.slotExit(this.slot(vmId).vm)) {
    return this.fetchImpl(url, { ...options, redirect: 'manual', ...(agent ? { agent } : {}) }, { vmId, proxyUrl })
  }

  async postToken(vmId, fields, exit) {
    let response
    try {
      response = await this.request(
        vmId,
        TOKEN_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ ...fields, resource: SIWC_RESOURCE }).toString(),
          signal: AbortSignal.timeout(15_000),
        },
        exit,
      )
    } catch (error) {
      if (exit && wasNotSent(error)) {
        throw Object.assign(new Error('SIWC refresh could not connect'), { code: REFRESH_NOT_SENT })
      }
      throw error
    }
    const payload = await response.json()
    if (!response.ok) {
      const proof = typeof payload?.error === 'string' ? payload.error : payload?.error?.code
      const rejected = (response.status === 400 || response.status === 401) && REJECTED_GRANTS.has(proof)
      const code = rejected ? proof : 'siwc_token_exchange_failed'
      throw issue(code, 'OpenAI 未完成 SIWC 换票。', response.status)
    }
    return payload
  }

  start(vmId) {
    return this.locked(vmId, () => {
      const { vm, owner, account } = this.slot(vmId)
      if (!owner.subject) throw issue('siwc_codex_login_required', '请先为该槽位完成普通 Codex 登录。', 409)
      resolveSlotOAuthProxy(vm, this.proxyPool)
      const current = this.attempts.get(vmId)
      if (current?.expires_at > this.now() && sameSiwcOwner(current.owner, owner)) return current.public

      const record =
        this.read(vmId) ||
        this.write(vmId, {
          host_id: 'urn:uuid:' + randomUUID(),
          enabled: false,
          state: 'unbound',
        })
      const clientId = sameSiwcOwner(record.owner, owner) ? record.client_id : null
      const attempt = {
        id: nonce(),
        nonce: nonce(),
        verifier: nonce(),
        clientId,
        siwcSubject: clientId ? record.siwc_subject || owner.subject : null,
        codexEmail: verifiedEmail(decodeJwtPayload(account.id_token)),
        owner,
        expires_at: this.now() + BIND_TTL,
      }
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        client_id: clientId || DYNAMIC_CLIENT,
        ...(!clientId ? { agent_name_hint: 'vm2api' } : {}),
        ext_agent_host_id: record.host_id,
        response_type: 'code',
        redirect_uri: SIWC_REDIRECT_URI,
        resource: SIWC_RESOURCE,
        scope: SCOPES,
        state: attempt.id,
        nonce: attempt.nonce,
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })
      attempt.public = { session_id: attempt.id, auth_url: url.href, expires_at: attempt.expires_at }
      this.attempts.set(vmId, attempt)
      return attempt.public
    })
  }

  assertAttempt(vmId, sessionId) {
    const attempt = this.attempts.get(vmId)
    if (!attempt || attempt.id !== sessionId || attempt.expires_at <= this.now()) {
      throw issue('siwc_session_expired', 'SIWC 授权会话已结束，请开始新的绑定。', 409)
    }
    if (!sameSiwcOwner(attempt.owner, this.slot(vmId).owner)) {
      throw issue('siwc_account_changed', '槽位账号已变化，请重新绑定。', 409)
    }
    return attempt
  }

  authorization(vmId, sessionId) {
    return this.assertAttempt(vmId, sessionId).public
  }

  cancel(vmId, sessionId) {
    const attempt = this.attempts.get(vmId)
    if (!attempt || (sessionId && sessionId !== attempt.id)) return false
    return this.attempts.delete(vmId)
  }

  async finish(vmId, sessionId, raw, { assertCurrent = () => {} } = {}) {
    const attempt = this.assertAttempt(vmId, sessionId)
    if (attempt.exchanging) throw issue('siwc_callback_busy', '此授权回调已在处理。', 409)
    const callback = parseCallback(raw, attempt)
    attempt.exchanging = true
    try {
      if (callback.denied) throw issue('siwc_access_denied', 'OpenAI 授权未完成。')
      const { code, clientId } = callback
      const payload = await this.postToken(vmId, {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: SIWC_REDIRECT_URI,
      })
      const fields = tokenFields(payload, this.now())
      const jwks = await this.request(vmId, JWKS_URL, { signal: AbortSignal.timeout(15_000) })
      if (!jwks.ok) throw issue('siwc_jwks_unavailable', '暂时无法核验 OpenAI 授权签名。', 502)
      const identity = validateIdToken(payload.id_token, (await jwks.json()).keys, attempt, clientId, this.now())
      const workspace = identity['https://api.openai.com/auth']?.chatgpt_account_id
      let accountMatches = identity.sub === (attempt.siwcSubject || attempt.owner.subject)
      // First-time registration can issue a subject specific to the new OAuth client.
      if (!accountMatches && !attempt.clientId) {
        const email = verifiedEmail(identity)
        if (!email || !attempt.codexEmail) {
          throw issue('siwc_account_unverified', '无法确认两个登录属于同一账号。请确认邮箱已验证后重新授权。', 409)
        }
        accountMatches = email === attempt.codexEmail
      }
      if (!accountMatches || (workspace && attempt.owner.workspace && workspace !== attempt.owner.workspace)) {
        throw issue('siwc_account_mismatch', '登录账号与槽位账号不一致。请选择此槽位原账号与工作区。', 409)
      }
      await this.locked(vmId, () => {
        assertCurrent()
        this.assertAttempt(vmId, sessionId)
        this.write(vmId, {
          host_id: this.read(vmId).host_id,
          enabled: true,
          owner: attempt.owner,
          client_id: clientId,
          siwc_subject: identity.sub,
          id_token: payload.id_token,
          revision: randomUUID(),
          ...fields,
        })
        this.clearSiwcHold(vmId)
      })
    } finally {
      this.cancel(vmId, sessionId)
    }
    await this.refreshModels(vmId).catch(() => {})
    return this.view(vmId)
  }

  clearSiwcHold(vmId) {
    if (openAIAccountHold(vmId)?.reason === 'siwc_rate_limited') clearOpenAIAccountHold(vmId)
  }

  setEnabled(vmId, enabled) {
    return this.locked(vmId, () => {
      const { owner } = this.slot(vmId)
      const record = this.read(vmId)
      if (enabled && !summarizeCodexSiwc(record, owner, this.now())?.has_token) throw needSignIn()
      this.cancel(vmId)
      if (record) this.write(vmId, { ...record, enabled })
      if (!enabled) this.clearSiwcHold(vmId)
      return this.view(vmId)
    })
  }

  unbind(vmId) {
    return this.locked(vmId, () => {
      this.slot(vmId)
      const record = this.read(vmId)
      this.cancel(vmId)
      if (record) {
        const { host_id, owner, client_id, siwc_subject } = record
        this.write(vmId, { host_id, owner, client_id, siwc_subject, enabled: false, state: 'unbound' })
      }
      this.clearSiwcHold(vmId)
      return this.view(vmId)
    })
  }

  inUse(vmId, revision) {
    const vm = this.getVm(vmId)
    if (!vm || !isCodexVm(vm)) return false
    const record = this.read(vmId)
    const account = readCodexAccounts(this.projectRoot, vmId)[0]
    return (
      record?.enabled === true && record.revision === revision && sameSiwcOwner(record.owner, codexSiwcOwner(account))
    )
  }

  assertInUse(vmId, credential) {
    if (!this.inUse(vmId, credential.revision)) {
      throw issue('siwc_mode_changed', '槽位的 SIWC 绑定已变化，请重试。', 503)
    }
  }

  async access(vmId, { enabled = true } = {}) {
    const { owner } = this.slot(vmId)
    let record = this.read(vmId)
    if (!sameSiwcOwner(record?.owner, owner) || (enabled && !record.enabled) || record.state === 'unbound') {
      throw needSignIn()
    }
    const canRefresh = siwcCanRenew(record)
    if (canRefresh && (record.state === 'refresh_pending' || siwcRefreshDue(record) <= this.now())) {
      const renewal = this.renew(vmId)
      if (!siwcHasAccess(record, this.now())) {
        await renewal
        record = this.read(vmId)
      } else {
        void renewal.catch(() => {})
      }
    }
    if (!record || !sameSiwcOwner(record.owner, this.slot(vmId).owner) || (enabled && !record.enabled)) {
      throw needSignIn()
    }
    if (siwcHasAccess(record, this.now())) return record
    if (!siwcCanRenew(record)) {
      throw needSignIn()
    }
    throw issue('siwc_refresh_pending', 'SIWC 正在等待可续期的时间。', 503)
  }

  renew(vmId) {
    const existing = this.refreshes.get(vmId)
    if (existing) return existing
    const renewal = this.performRenewal(vmId).finally(() => this.refreshes.delete(vmId))
    this.refreshes.set(vmId, renewal)
    return renewal
  }

  async performRenewal(vmId) {
    const claim = await this.locked(vmId, () => {
      const record = this.read(vmId)
      if (!record) return null
      const { vm, owner } = this.slot(vmId)
      if (!sameSiwcOwner(record.owner, owner)) return null
      if (record.state === 'refresh_pending') {
        // A pending record without a live flight may have already spent its refresh token.
        this.write(vmId, { ...record, state: 'refresh_outcome_unknown', retry_at: null })
        return null
      }
      if (!siwcCanRenew(record) || siwcRefreshDue(record) > this.now()) return null
      let exit
      try {
        exit = this.slotExit(vm)
      } catch {
        this.write(vmId, { ...record, ...renewalBackoff(record, this.now()) })
        return null
      }
      return { record: this.write(vmId, { ...record, state: 'refresh_pending' }), exit }
    })
    if (!claim) return
    const { record, exit } = claim
    const stillClaimed = (current) =>
      current?.state === 'refresh_pending' &&
      current.revision === record.revision &&
      current.refresh_token === record.refresh_token
    if (!stillClaimed(this.read(vmId))) return
    let patch
    try {
      const payload = await this.postToken(
        vmId,
        {
          grant_type: 'refresh_token',
          client_id: record.client_id,
          refresh_token: record.refresh_token,
        },
        exit,
      )
      patch = tokenFields(payload, this.now(), record)
    } catch (error) {
      if (REJECTED_GRANTS.has(error?.code) || error?.code === 'siwc_plan_scope_missing') {
        patch = {
          state: 'reauth_required',
          access_token: null,
          refresh_token: null,
          id_token: null,
          retry_at: null,
          refresh_failures: 0,
          ...(error.code === 'invalid_client' ? { client_id: null } : {}),
        }
      } else if (error?.code === REFRESH_NOT_SENT) {
        patch = renewalBackoff(record, this.now())
      } else {
        patch = { state: 'refresh_outcome_unknown', retry_at: null }
      }
    }
    await this.locked(vmId, () => {
      const current = this.read(vmId)
      if (!stillClaimed(current)) return
      const vm = this.getVm(vmId)
      if (!vm || !isCodexVm(vm) || !sameSiwcOwner(current.owner, this.slot(vmId).owner)) return
      this.write(vmId, { ...current, ...patch })
    })
  }

  rejectAccess(vmId, used) {
    return this.locked(vmId, () => {
      const current = this.read(vmId)
      if (current?.revision === used.revision && current.access_token === used.access_token) {
        this.write(vmId, { ...current, access_rejected: true })
      }
    })
  }

  refreshModels(vmId) {
    const pending = this.catalogs.get(vmId)
    if (pending) return pending
    const lookup = this.fetchModels(vmId).finally(() => this.catalogs.delete(vmId))
    this.catalogs.set(vmId, lookup)
    return lookup
  }

  async fetchModels(vmId) {
    const record = await this.access(vmId, { enabled: false })
    const response = await this.request(vmId, SIWC_RESOURCE + '/models', {
      headers: { authorization: 'Bearer ' + record.access_token },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401) await this.rejectAccess(vmId, record)
    if (!response.ok) throw issue('siwc_catalog_unavailable', '暂时无法取得该账号的 SIWC 模型目录。', 503)
    const { models } = await response.json()
    if (!Array.isArray(models)) throw issue('siwc_catalog_unavailable', 'OpenAI 返回的 SIWC 模型目录无效。', 503)
    const catalog = models
      .filter((row) => typeof row?.slug === 'string' && row.slug)
      .map((row) => ({ id: row.slug, name: row.display_name || row.slug, visible: row.visibility === 'list' }))
    return this.locked(vmId, () => {
      const current = this.read(vmId)
      if (current?.revision !== record.revision || !sameSiwcOwner(current.owner, this.slot(vmId).owner)) {
        throw needSignIn()
      }
      this.write(vmId, { ...current, models: catalog })
      return catalog
    })
  }

  startMaintenance(listSlots) {
    const tick = () => {
      for (const vm of listSlots()) {
        if (vm.codex_siwc?.has_refresh && vm.status !== 'disabled') {
          void this.access(vm.id, { enabled: false }).catch(() => {})
        }
      }
    }
    this.timer = setInterval(tick, 30_000).unref()
    tick()
  }

  stopMaintenance() {
    clearInterval(this.timer)
  }

  cancelBindings() {
    this.attempts.clear()
  }
}
