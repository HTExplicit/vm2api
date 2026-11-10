import crypto from 'node:crypto'
import path from 'node:path'
import { cancelAuthUrlSession, exchangeAuthCode, generateAuthUrl } from './oauth-auth-url.mjs'
import {
  completeClaudeAuthLogin,
  startClaudeAuthLoginSession,
  stopClaudeAuthLoginSession,
} from './claude-auth-login.mjs'
import { extractOAuthCodeFromRedirect } from './cookie-auth.mjs'
import { finishOAuthImport, prepareSlotOAuth } from './guest-oauth-helper.mjs'
import { applyOauthIdentity, flattenOauthIdentity } from './oauth-identity.mjs'
import { expiresAtToMs, readSlotCredentialIdentity } from './oauth-credentials.mjs'
import { runSlotOauth, runSlotProcess } from '../transport/slot-oauth.mjs'
import { patchVmRecord, persistVmRuntime, setScheduleHold } from '../vm/vm-registry.mjs'
import { slotExec, stopSlot } from '../vm/slot-runtime.mjs'
import { slotExecArgv, slotExecContainer } from '../vm/slot-exec.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { inspectContainerOrNull } from '../cluster/docker-remote.mjs'
import { applyClearHold, HOLD_MAINTENANCE } from '../pool/schedule-state.mjs'

function problem(code, message) {
  return Object.assign(new Error(message), { code, publicMessage: message })
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

async function unlessCancelled(operation, signal) {
  signal.throwIfAborted()
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

function identityOf(identity = {}) {
  return {
    accountId: String(identity.accountId || identity.account_uuid || ''),
    email: String(identity.email || '')
      .trim()
      .toLowerCase(),
  }
}

function sameIdentity(expected, actual) {
  if (expected.accountId) return expected.accountId === actual.accountId
  return expected.email === actual.email
}

async function runtimeState(vm) {
  const host = slotHost(vm)
  if (host.inspect) return host.inspect(vm)
  const info = await inspectContainerOrNull(host.dockerApi(), slotExecContainer(vm))
  return { running: info?.State?.Running === true }
}

export function parseClaudeBrowserCallback(raw, redirect) {
  const url = new URL(raw)
  const target = new URL(redirect)
  if (url.origin !== target.origin || url.pathname !== target.pathname || url.hash) {
    throw problem('oauth_callback_invalid', 'Claude 授权回调地址与当前登录不匹配。')
  }
  if (url.searchParams.has('error')) {
    throw problem('oauth_authorization_denied', 'Claude 授权未完成，请重新登录。')
  }
  const parsed = extractOAuthCodeFromRedirect(url.href)
  if (!parsed?.code?.trim()) throw problem('code_required', 'Claude 授权回调未包含授权码，请重新登录。')
  // Claude's returned state is the exchange state, not necessarily the authorize nonce.
  return parsed.state ? `${parsed.code}#${parsed.state}` : parsed.code
}

/** Verify a provisional grant inside its slot, without replacing the live credential. */
export async function probeClaudeBrowserIdentity(
  { vm, oauth, jobId, signal },
  { runDocker = runSlotProcess, slotOauth = runSlotOauth } = {},
) {
  const host = slotHost(vm)
  const user = host.execUser(vm)
  const directory = `/home/kincli/.cache/oauth-browser-profile/${jobId}`
  const command = async (argv, options = {}) => {
    const result = await runDocker(slotExecArgv(vm, argv, { user, interactive: true }), {
      env: host.dockerEnv(),
      timeoutMs: 15_000,
      ...options,
    })
    if (result.code !== 0 || result.timed_out || result.output_limit) {
      throw problem('oauth_profile_failed', '无法在槽位内核实本次 Claude 授权账号，尚未保存凭据。')
    }
    return result.stdout
  }
  signal?.throwIfAborted()
  const config = JSON.parse(await command(['cat', '/run/kin/worker.json']))
  config.credential_path = `${directory}/credentials.json`
  const credential = {
    type: 'oauth',
    claudeAiOauth: {
      accessToken: oauth.access_token,
      refreshToken: oauth.refresh_token,
      expiresAt: expiresAtToMs(oauth.expires_at),
      scopes:
        oauth.scopes ||
        String(oauth.scope || '')
          .split(/\s+/)
          .filter(Boolean),
    },
  }
  try {
    await command(
      [
        'sh',
        '-c',
        'set -eu\numask 077\nmkdir -p "$1"\nIFS= read -r config\nprintf "%s\\n" "$config" > "$1/worker.json"\ncat > "$1/credentials.json"',
        'oauth-profile',
        directory,
      ],
      { stdin: JSON.stringify(config) + '\n' + JSON.stringify(credential) + '\n' },
    )
    signal?.throwIfAborted()
    const profile = await slotOauth({ vmId: vm.id, vm }, 'profile', { configPath: `${directory}/worker.json` })
    signal?.throwIfAborted()
    if (!profile?.ok) {
      throw problem('oauth_profile_failed', '未能核实本次 Claude 授权账号，尚未保存凭据。')
    }
    const identity = flattenOauthIdentity(profile.body)
    if (!identity.account_uuid || !identity.email) {
      throw problem('oauth_identity_missing', 'Claude 授权没有返回完整账号身份，尚未保存凭据。')
    }
    // Profile may refresh an expiring provisional grant. Commit that final grant.
    const final = JSON.parse(await command(['cat', `${directory}/credentials.json`])).claudeAiOauth
    return applyOauthIdentity(
      {
        ...oauth,
        access_token: final.accessToken,
        refresh_token: final.refreshToken,
        expires_at: Math.floor(expiresAtToMs(final.expiresAt) / 1000),
      },
      identity,
    )
  } finally {
    await command(['sh', '-c', 'rm -rf -- "$1"', 'oauth-profile-cleanup', directory])
  }
}

/** Claude OAuth uses the shared browser; token exchange and installation keep their existing owners. */
export class ClaudeBrowserLoginService {
  constructor({
    browserManager,
    projectRoot,
    getVm,
    getRouting = () => ({}),
    getAccountIdentity,
    commitCredentials,
    generateAuthUrl: generate = generateAuthUrl,
    exchangeCode = exchangeAuthCode,
    cancelAuthSession = cancelAuthUrlSession,
    startCliLogin = startClaudeAuthLoginSession,
    completeCliLogin = completeClaudeAuthLogin,
    stopCliLogin = stopClaudeAuthLoginSession,
    prepareOAuth = prepareSlotOAuth,
    probeIdentity = probeClaudeBrowserIdentity,
    stopRuntime = stopSlot,
    getRuntimeState = runtimeState,
    persistRuntime = (id, runtime) => persistVmRuntime(projectRoot, id, runtime),
    setHold = (id, detail) => setScheduleHold(projectRoot, id, HOLD_MAINTENANCE, detail),
    clearHold = (id, tag) =>
      patchVmRecord(projectRoot, id, (vm) => {
        const status = vm.status
        applyClearHold(vm, HOLD_MAINTENANCE, { tag })
        vm.status = status
      }),
    now = Date.now,
  } = {}) {
    Object.assign(this, {
      browserManager,
      projectRoot,
      getVm,
      getRouting,
      getAccountIdentity,
      commitCredentials,
      generateAuthUrl: generate,
      exchangeCode,
      cancelAuthSession,
      startCliLogin,
      completeCliLogin,
      stopCliLogin,
      prepareOAuth,
      probeIdentity,
      stopRuntime,
      getRuntimeState,
      persistRuntime,
      setHold,
      clearHold,
      now,
    })
    this.jobs = new Map()
  }

  resolveIdentity(vmId, vm) {
    const actual = this.getAccountIdentity
      ? this.getAccountIdentity(vmId, vm)
      : readSlotCredentialIdentity(path.join(this.projectRoot, 'vms', vmId, 'cli-home'))
    return identityOf({
      accountId: actual?.accountId || actual?.account_uuid || vm?.claude?.account_uuid,
      email: actual?.email || vm?.claude?.email,
    })
  }

  async start(vmId, { flavor = 'cai' } = {}) {
    if (!['cai', 'claude_code'].includes(flavor)) {
      throw problem('invalid_oauth_flavor', '请选择标准 OAuth 或官方 Claude Code 登录。')
    }
    const previous = this.jobs.get(vmId)
    if (previous?.flavor === flavor) return this.browserManager.state(vmId)
    if (previous) await this.cancel(vmId)
    const vm = this.getVm(vmId)
    if (!vm) throw problem('vm_not_found', '账号槽位不存在。')
    const job = {
      vmId,
      flavor,
      id: crypto.randomBytes(16).toString('hex'),
      expected: this.resolveIdentity(vmId, vm),
      abort: new AbortController(),
      completed: deferred(),
    }
    this.jobs.set(vmId, job)
    job.promise = this.run(job)
    job.promise.catch(() => {})
    return this.browserManager.state(vmId)
  }

  assertCurrent(job) {
    job.abort.signal.throwIfAborted()
    const vm = this.getVm(job.vmId)
    if (!vm) throw problem('vm_not_found', '账号槽位已删除。')
    if (!sameIdentity(job.expected, this.resolveIdentity(job.vmId, vm))) {
      throw problem('oauth_account_changed', '槽位账号已变化，请重新打开浏览器登录。')
    }
    if (job.live) this.browserManager.assertCurrent(job.live)
    return vm
  }

  async run(job) {
    let failure
    const onClosed = () => job.abort.abort(problem('oauth_cancelled', '浏览器已关闭。'))
    try {
      job.live = await this.browserManager.acquire(job.vmId, { purpose: 'oauth', interactive: true, retain: true })
      job.live.persistable = false
      let vm = this.assertCurrent(job)
      job.live.closeSignal?.addEventListener('abort', onClosed, { once: true })
      if (job.live.closeSignal?.aborted) onClosed()
      const actualRuntime = await this.getRuntimeState(vm)
      job.wasStopped = actualRuntime.running !== true
      this.assertCurrent(job)
      if (job.wasStopped && !vm.schedule_hold) {
        job.holdTag = `oauth-browser:${job.id}`
        await this.setHold(job.vmId, { tag: job.holdTag })
      }
      job.runtimePrepared = true
      let generated
      if (job.flavor === 'claude_code') {
        job.cliStarted = true
        generated = await this.startCliLogin({
          vm,
          projectRoot: this.projectRoot,
          routing: this.getRouting(),
          isolated: true,
          preservePowerIntent: true,
          signal: job.abort.signal,
        })
      } else {
        await this.prepareOAuth({
          exec: slotExec(this.projectRoot, vm),
          projectRoot: this.projectRoot,
          routing: this.getRouting(),
          preservePowerIntent: true,
        })
        vm = this.assertCurrent(job)
        generated = this.generateAuthUrl({ vmId: vm.id, proxyUrl: job.live.proxyUrl, flavor: 'cai' })
      }
      job.sessionId = generated.session_id
      this.assertCurrent(job)
      const redirect = new URL(generated.auth_url).searchParams.get('redirect_uri')
      job.redirect = new URL(redirect).href
      const target = new URL(job.redirect)
      job.routeMatch = (url) => url.origin === target.origin && url.pathname === target.pathname
      job.routeHandler = (route) => {
        const callback = this.acceptCallback(job, route)
        job.callbackPromise ||= callback
        return callback
      }
      await job.live.context.route(job.routeMatch, job.routeHandler)
      job.timer = setTimeout(
        () => job.abort.abort(problem('session_expired', 'Claude 授权已过期，请重新登录。')),
        Math.max(0, generated.expires_at - this.now()),
      )
      job.timer.unref?.()
      job.canReturnToAuthorization = () =>
        this.jobs.get(job.vmId) === job &&
        !job.abort.signal.aborted &&
        !job.live.closeSignal?.aborted &&
        !job.exchanging &&
        !job.saved &&
        this.now() < generated.expires_at
      job.returnToAuthorization = async () => {
        this.assertCurrent(job)
        if (!job.canReturnToAuthorization())
          throw problem('oauth_return_unavailable', '当前 Claude 授权已结束，无法返回授权页。')
        await unlessCancelled(
          job.live.page.goto(generated.auth_url, { waitUntil: 'domcontentloaded', timeout: 45_000 }),
          job.abort.signal,
        )
      }
      job.live.returnToAuthorization = job.returnToAuthorization
      job.live.canReturnToAuthorization = job.canReturnToAuthorization
      job.authorizationInProgress = () => job.exchanging === true && !job.abort.signal.aborted
      job.live.authorizationInProgress = job.authorizationInProgress
      job.live.stream?.sendNavigation()
      this.browserManager.setStatus(job.live, 'opening', '正在打开 Claude 授权页面…')
      try {
        await unlessCancelled(
          job.live.page.goto(generated.auth_url, { waitUntil: 'domcontentloaded', timeout: 45_000 }),
          job.abort.signal,
        )
      } catch (error) {
        if (!job.exchanging || job.abort.signal.aborted) throw error
        await unlessCancelled(job.completed.promise, job.abort.signal)
      }
      if (!job.saved)
        this.browserManager.setStatus(job.live, 'oauth_waiting', '请在此窗口完成 Claude 登录、验证码及授权。')
      await unlessCancelled(job.completed.promise, job.abort.signal)
    } catch (error) {
      failure = error
    } finally {
      clearTimeout(job.timer)
      let navigationChanged = false
      if (job.returnToAuthorization && job.live?.returnToAuthorization === job.returnToAuthorization) {
        delete job.live.returnToAuthorization
        delete job.live.canReturnToAuthorization
        navigationChanged = true
      }
      if (job.authorizationInProgress && job.live?.authorizationInProgress === job.authorizationInProgress) {
        delete job.live.authorizationInProgress
        navigationChanged = true
      }
      if (navigationChanged) job.live.stream?.sendNavigation()
      await job.callbackPromise
      if (job.routeMatch) await job.live.context.unroute(job.routeMatch, job.routeHandler).catch(() => {})
      job.live?.closeSignal?.removeEventListener('abort', onClosed)
      try {
        await this.cleanup(job)
      } catch (error) {
        job.cleanupError = error
        this.reportError(job, error)
        throw error
      }
    }
    if (job.saved && !job.abort.signal.aborted && !job.live.closeSignal?.aborted) {
      const current = this.getVm(job.vmId)
      if (!current || !sameIdentity(job.expected, this.resolveIdentity(job.vmId, current))) {
        if (this.jobs.get(job.vmId) === job) this.jobs.delete(job.vmId)
        return
      }
      const result = job.result
      if (result.vm)
        result.vm = {
          ...result.vm,
          status: current.status,
          runtime: { ...result.vm.runtime, stopped: current.runtime?.stopped },
        }
      let message = 'Claude 授权成功，凭据已保存，已恢复原启停与调度设置；请按面板提示完成。'
      try {
        this.browserManager.assertCurrent(job.live)
        job.live.persistable = true
        await this.browserManager.bindAccount(job.live, job.expected.accountId)
        await this.browserManager.persist(job.live)
      } catch {
        message += ' 网页会话保存失败，下次可能需要重新登录。'
      }
      this.browserManager.setStatus(job.live, 'oauth_complete', message, { result })
    } else if (failure && failure.code !== 'oauth_cancelled') {
      this.reportError(job, failure)
    }
    if (this.jobs.get(job.vmId) === job) this.jobs.delete(job.vmId)
  }

  reportError(job, error) {
    if (job.live)
      this.browserManager.setStatus(job.live, 'error', error.publicMessage || 'Claude 浏览器登录失败，请重新登录。', {
        error: error.code || 'oauth_browser_failed',
      })
  }

  async acceptCallback(job, route) {
    if (job.exchanging || job.saved) {
      await route
        .fulfill({ status: 409, contentType: 'text/plain; charset=utf-8', body: '正在保存授权，请稍候。' })
        .catch(() => {})
      return
    }
    job.exchanging = true
    job.live.stream?.sendNavigation()
    try {
      let vm = this.assertCurrent(job)
      const code = parseClaudeBrowserCallback(route.request().url(), job.redirect)
      let oauth =
        job.flavor === 'claude_code'
          ? await this.completeCliLogin({
              projectRoot: this.projectRoot,
              vmId: job.vmId,
              sessionId: job.sessionId,
              code,
              signal: job.abort.signal,
            })
          : await this.exchangeCode({
              sessionId: job.sessionId,
              code,
              vmId: job.vmId,
              proxyUrl: job.live.proxyUrl,
              exec: slotExec(this.projectRoot, vm),
              projectRoot: this.projectRoot,
              routing: this.getRouting(),
              preservePowerIntent: true,
            })
      job.oauth = oauth
      vm = this.assertCurrent(job)
      let identity = flattenOauthIdentity(oauth)
      if (!identity.account_uuid || !identity.email) {
        oauth = await this.probeIdentity({ vm, oauth, jobId: job.id, signal: job.abort.signal })
        this.assertCurrent(job)
        identity = flattenOauthIdentity(oauth)
      }
      if (!identity.account_uuid || !identity.email) {
        throw problem('oauth_identity_missing', 'Claude 授权没有返回完整账号身份，尚未保存凭据。')
      }
      const incoming = identityOf(identity)
      if ((job.expected.accountId || job.expected.email) && !sameIdentity(job.expected, incoming)) {
        job.live.persistable = false
        throw problem('oauth_account_mismatch', '登录账号与此槽位不一致。请关闭窗口后重登原账号；其他账号请新建槽位。')
      }
      const result = await this.commitCredentials({
        vmId: job.vmId,
        oauth,
        prepareRuntime: false,
        preservePowerIntent: true,
        skipOfficialCc: true,
      })
      if (result?.ok === false) {
        throw problem(
          result.error?.code || 'credential_import_failed',
          result.error?.message || 'Claude 凭据未能保存，请重新登录。',
        )
      }
      job.saved = true
      job.expected = incoming
      job.result = result
      await route
        .fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Claude 授权成功</title><body><h1>Claude 授权成功</h1><p>凭据已保存，正在完成登录收尾，请返回面板。</p></body></html>',
        })
        .catch(() => {})
      job.completed.resolve(result)
    } catch (error) {
      await route
        .fulfill({
          status: 400,
          contentType: 'text/plain; charset=utf-8',
          body: error.publicMessage || 'Claude 授权处理失败，请返回面板重新登录。',
        })
        .catch(() => {})
      job.completed.reject(error)
    }
  }

  async cleanup(job) {
    const observerError = await finishOAuthImport(job.oauth, false)
    if (observerError && job.result) job.result.telemetry_error = observerError
    if (job.flavor === 'cai' && job.sessionId) this.cancelAuthSession(job.sessionId)
    if (job.cliStarted && !job.cliStopped) {
      await this.stopCliLogin(this.projectRoot, job.vmId, { sessionId: job.sessionId })
      job.cliStopped = true
    }
    if (job.wasStopped && job.runtimePrepared && !job.runtimeRestored) {
      const current = this.getVm(job.vmId)
      if (current) {
        const stopped = await this.stopRuntime(current)
        if (!stopped.ok)
          throw problem('oauth_runtime_stop_failed', 'Claude 登录已结束，但临时槽位未能关机，请重试关闭。')
        await this.persistRuntime(job.vmId, stopped.runtime || current.runtime)
      }
      job.runtimeRestored = true
    }
    if (job.holdTag) {
      await this.clearHold(job.vmId, job.holdTag)
      job.holdTag = null
    }
  }

  async cancel(vmId) {
    const job = this.jobs.get(vmId)
    if (!job) return
    job.abort.abort(problem('oauth_cancelled', 'Claude 登录已取消。'))
    if (!job.live) await this.browserManager.cancel(vmId)
    try {
      await job.promise
    } catch (error) {
      if (!job.cleanupError) throw error
      await this.cleanup(job)
      if (this.jobs.get(vmId) === job) this.jobs.delete(vmId)
    }
  }

  async stop() {
    await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)))
  }
}
