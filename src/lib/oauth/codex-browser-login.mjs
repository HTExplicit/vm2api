import { cancelCodexAuthSession, exchangeCodexAuthCode, generateCodexAuthUrl } from './codex-oauth.mjs'
import { openaiIdentityFromOauthTokens } from './openai-jwt.mjs'
import { CODEX_OAUTH_REDIRECT_URI } from '../protocol/codex-models.mjs'

const REDIRECT = new URL(CODEX_OAUTH_REDIRECT_URI)

function problem(code, message) {
  return Object.assign(new Error(message), { code, publicMessage: message })
}

function identityOf(vm) {
  return {
    accountId: String(vm?.codex?.chatgpt_account_id || vm?.chatgpt_account_id || ''),
    email: String(vm?.codex?.email || vm?.email || '')
      .trim()
      .toLowerCase(),
  }
}

function sameIdentity(left, right) {
  return left.accountId === right.accountId && left.email === right.email
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  // A callback may arrive before navigation returns or cancellation is awaited.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

async function unlessCancelled(operation, signal) {
  if (signal.aborted) throw signal.reason
  let cancel
  const cancelled = new Promise((_, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  try {
    return await Promise.race([operation, cancelled])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

export function parseCodexBrowserCallback(raw, expectedState) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw problem('oauth_callback_invalid', 'OpenAI 授权回调地址无效，请重新登录。')
  }
  if (url.origin !== REDIRECT.origin || url.pathname !== REDIRECT.pathname || url.hash) {
    throw problem('oauth_callback_invalid', 'OpenAI 授权回调地址与当前登录不匹配。')
  }
  if (!expectedState || url.searchParams.get('state') !== expectedState) {
    throw problem('state_mismatch', 'OpenAI 授权状态与当前登录不匹配，请重新登录。')
  }
  if (url.searchParams.has('error')) {
    throw problem('oauth_authorization_denied', 'OpenAI 授权未完成，请重新登录。')
  }
  if (!url.searchParams.get('code')?.trim()) {
    throw problem('code_required', 'OpenAI 授权回调未包含授权码，请重新登录。')
  }
  return url.href
}

/** The browser is a carrier for the existing PKCE and credential commit chain. */
export class CodexBrowserLoginService {
  constructor({
    browserManager,
    getVm,
    getAccountIdentity,
    commitCredentials,
    generateAuthUrl = generateCodexAuthUrl,
    exchangeCode = exchangeCodexAuthCode,
    cancelAuthSession = cancelCodexAuthSession,
    now = Date.now,
  } = {}) {
    Object.assign(this, {
      browserManager,
      getVm,
      getAccountIdentity,
      commitCredentials,
      generateAuthUrl,
      exchangeCode,
      cancelAuthSession,
      now,
    })
    this.jobs = new Map()
  }

  resolveIdentity(vmId, vm) {
    const fallback = identityOf(vm)
    const identity = this.getAccountIdentity?.(vmId)
    return {
      accountId: String(identity?.accountId || identity?.chatgpt_account_id || fallback.accountId),
      email: String(identity?.email || fallback.email)
        .trim()
        .toLowerCase(),
    }
  }

  start(vmId) {
    const vm = this.getVm(vmId)
    if (!vm) throw problem('vm_not_found', '账号槽位不存在。')
    if (this.jobs.has(vmId)) return this.browserManager.state(vmId)
    const job = {
      vmId,
      expected: this.resolveIdentity(vmId, vm),
      abort: new AbortController(),
      completed: deferred(),
      installationId: vm.device_id || vm.codex?.installation_id,
    }
    this.jobs.set(vmId, job)
    job.promise = this.run(job)
    return this.browserManager.state(vmId)
  }

  assertCurrent(job) {
    if (job.abort.signal.aborted) throw job.abort.signal.reason
    const vm = this.getVm(job.vmId)
    if (!vm) throw problem('vm_not_found', '账号槽位已删除。')
    if (!sameIdentity(job.expected, this.resolveIdentity(job.vmId, vm))) {
      throw problem('oauth_account_changed', '槽位账号已变化，请重新打开浏览器登录。')
    }
    if (job.live) this.browserManager.assertCurrent(job.live)
    return vm
  }

  async run(job) {
    let onClosed
    try {
      job.live = await this.browserManager.acquire(job.vmId, { purpose: 'oauth', interactive: true, retain: true })
      this.assertCurrent(job)
      onClosed = () => job.abort.abort(problem('oauth_cancelled', '浏览器已关闭。'))
      job.live.closeSignal?.addEventListener('abort', onClosed, { once: true })
      if (job.live.closeSignal?.aborted) onClosed()
      this.assertCurrent(job)
      const generated = this.generateAuthUrl({
        vmId: job.vmId,
        proxyUrl: job.live.proxyUrl,
        installationId: job.installationId,
      })
      job.sessionId = generated.session_id
      const authorize = new URL(new URL(generated.auth_url).searchParams.get('authorize_url'))
      job.state = authorize.searchParams.get('state')
      job.routeMatch = (url) => url.origin === REDIRECT.origin && url.pathname === REDIRECT.pathname
      job.routeHandler = (route) => {
        const callback = this.acceptCallback(job, route)
        job.callbackPromise ||= callback
        return callback
      }
      await job.live.context.route(job.routeMatch, job.routeHandler)
      job.timer = setTimeout(
        () => {
          job.abort.abort(problem('session_expired', 'OpenAI 授权已过期，请重新登录。'))
        },
        Math.max(0, generated.expires_at - this.now()),
      )
      job.timer.unref?.()
      this.browserManager.setStatus(job.live, 'opening', '正在打开 OpenAI 授权页面…')
      await unlessCancelled(
        job.live.page.goto(generated.auth_url, { waitUntil: 'domcontentloaded', timeout: 45_000 }),
        job.abort.signal,
      )
      if (!job.saved) {
        this.browserManager.setStatus(job.live, 'oauth_waiting', '请在此窗口完成 OpenAI 登录、验证码及授权。')
      }
      await unlessCancelled(job.completed.promise, job.abort.signal)
    } catch (error) {
      if (job.saved) return
      if (job.live && error.code !== 'oauth_cancelled') {
        this.browserManager.setStatus(job.live, 'error', error.publicMessage || 'OpenAI 浏览器登录失败，请重新登录。', {
          error: error.code || 'oauth_browser_failed',
        })
      }
    } finally {
      clearTimeout(job.timer)
      if (job.sessionId) this.cancelAuthSession(job.sessionId)
      job.live?.closeSignal?.removeEventListener('abort', onClosed)
      if (job.routeMatch) await job.live.context.unroute(job.routeMatch, job.routeHandler).catch(() => {})
      // A callback can still be awaiting the shared credential commit after the
      // browser closes. Deletion must wait until it can no longer write state.
      await job.callbackPromise
      if (this.jobs.get(job.vmId) === job) this.jobs.delete(job.vmId)
    }
  }

  async acceptCallback(job, route) {
    if (job.exchanging || job.saved) {
      await route
        .fulfill({ status: 409, contentType: 'text/plain; charset=utf-8', body: '正在保存授权，请稍候。' })
        .catch(() => {})
      return
    }
    job.exchanging = true
    try {
      this.assertCurrent(job)
      const callback = parseCodexBrowserCallback(route.request().url(), job.state)
      const account = await this.exchangeCode({
        sessionId: job.sessionId,
        code: callback,
        proxyUrl: job.live.proxyUrl,
        vmId: job.vmId,
      })
      this.assertCurrent(job)
      const identity = openaiIdentityFromOauthTokens(account)
      if (!identity.email || !identity.chatgpt_account_id) {
        throw problem('oauth_identity_missing', 'OpenAI 授权没有返回完整账号身份，尚未保存凭据。')
      }
      if (
        (job.expected.accountId && job.expected.accountId !== identity.chatgpt_account_id) ||
        (job.expected.email && job.expected.email !== identity.email.toLowerCase())
      ) {
        job.live.persistable = false
        throw problem('oauth_account_mismatch', '登录账号与此槽位不一致。请关闭窗口后重登原账号；其他账号请新建槽位。')
      }
      const result = await this.commitCredentials({ vmId: job.vmId, account })
      job.saved = true
      const committedVm = this.getVm(job.vmId)
      const committedIdentity = committedVm ? this.resolveIdentity(job.vmId, committedVm) : null
      const expectedIdentity = { accountId: identity.chatgpt_account_id, email: identity.email.toLowerCase() }
      if (
        job.abort.signal.aborted ||
        job.live.closeSignal?.aborted ||
        !committedVm ||
        !sameIdentity(committedIdentity, expectedIdentity)
      ) {
        await route
          .fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '授权处理已结束，请返回面板。' })
          .catch(() => {})
        job.completed.resolve(result)
        return
      }
      let message = 'OpenAI 授权成功，凭据已保存。可继续进入 Platform，或关闭浏览器。'
      try {
        this.browserManager.assertCurrent(job.live)
        job.live.persistable = true
        await this.browserManager.bindAccount(job.live, identity.chatgpt_account_id)
        await this.browserManager.persist(job.live)
      } catch {
        message = 'OpenAI 凭据已保存；网页会话保存失败，需要时可重新登录 Platform。'
      }
      await route
        .fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>OpenAI 授权成功</title><body><h1>OpenAI 授权成功</h1><p>凭据已保存，可以在面板继续进入 Platform 或关闭浏览器。</p></body></html>',
        })
        .catch(() => {})
      if (!job.live.closeSignal?.aborted) {
        this.browserManager.setStatus(job.live, 'oauth_complete', message, { result })
      }
      job.completed.resolve(result)
    } catch (error) {
      await route
        .fulfill({
          status: 400,
          contentType: 'text/plain; charset=utf-8',
          body: error.publicMessage || 'OpenAI 授权处理失败，请返回面板重新登录。',
        })
        .catch(() => {})
      job.completed.reject(error)
    }
  }

  async cancel(vmId) {
    const job = this.jobs.get(vmId)
    if (!job) return
    job.abort.abort(problem('oauth_cancelled', 'OpenAI 登录已取消。'))
    if (!job.live) await this.browserManager.cancel(vmId)
    await job.promise
  }

  async stop() {
    await Promise.all([...this.jobs.keys()].map((vmId) => this.cancel(vmId)))
  }
}
