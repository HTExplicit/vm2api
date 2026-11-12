import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { getVm as readVm } from '../vm/vm-registry.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { hasBoundExit } from '../vm/egress.mjs'
import { createPlatformBrowserSession } from '../openai-api/platform-browser.mjs'
import { BrowserStream } from './browser-stream.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'

const BROWSER_PATH = /^\/api\/panel\/vms\/([^/]+)\/(?:openai-api\/)?browser$/
const IDLE_TIMEOUT = 15 * 60_000

function problem(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status })
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  // Opening from the HTTP route intentionally returns before the browser starts.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function safeMessage(error) {
  return String(error?.message || '浏览器启动失败')
    .replace(/(?:sk-|cb_)[A-Za-z0-9_-]+/g, '[key]')
    .slice(0, 300)
}

async function abortable(promise, signal, onAbort = null) {
  if (signal?.aborted) {
    onAbort?.()
    signal.throwIfAborted()
  }
  if (!signal) return promise
  let aborted
  const stopped = new Promise((_, reject) => {
    aborted = () => {
      onAbort?.()
      reject(signal.reason || problem('browser_cancelled', '浏览器任务已取消'))
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
  try {
    return await Promise.race([promise, stopped])
  } finally {
    signal.removeEventListener('abort', aborted)
  }
}

/** One live browser, persistent identities per slot, and a priority queue for
 * background work. OAuth and Platform own their business logic on this session. */
export class SlotBrowserManager {
  constructor({
    cfg,
    profileRepo,
    runtime = null,
    getVm = (id) => readVm(cfg.paths.project, id),
    getAccountIdentity = (_id, vm) => vm.codex?.chatgpt_account_id || '',
    resolveProxy = hostProxyUrlForVm,
    createSession = createPlatformBrowserSession,
    Stream = BrowserStream,
    now = Date.now,
  } = {}) {
    Object.assign(this, {
      cfg,
      profileRepo,
      runtime,
      getVm,
      getAccountIdentity,
      resolveProxy,
      createSession,
      Stream,
      now,
    })
    this.jobs = new Map()
    this.states = new Map()
    this.queue = []
    this.tickets = new Map()
    this.stopped = false
    this.active = null
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 })
  }

  currentVm(vmId) {
    const vm = this.getVm(vmId)
    if (!vm) throw problem('vm_not_found', '账号槽位不存在', 404)
    const proxyUrl = this.resolveProxy(vm)
    if (!hasBoundExit(vm.proxy) || !proxyUrl) throw problem('proxy_required', '槽位未绑定可用代理', 400)
    return { vm, proxyUrl, accountId: this.getAccountIdentity(vmId, vm) || '' }
  }

  state(vmId) {
    const live = this.jobs.get(vmId)
    if (live)
      return {
        vm_id: vmId,
        active: true,
        status: live.status,
        purpose: live.purpose,
        message: live.message,
        ...(live.warning ? { warning: live.warning } : {}),
        ...live.statusDetails,
      }
    return this.states.get(vmId) || { vm_id: vmId, active: false, status: 'closed', purpose: null, message: null }
  }

  setStatus(live, status, message = null, details = {}) {
    if (live.closeSignal.aborted) return
    live.status = status
    live.message = message
    live.statusDetails = details
    this.send(live, {
      type: 'status',
      status,
      purpose: live.purpose,
      ...(message ? { message } : {}),
      ...(live.warning ? { warning: live.warning } : {}),
      ...details,
    })
    live.stream?.sendNavigation?.()
  }

  send(live, message) {
    for (const ws of live.clients) if (ws.readyState === 1) ws.send(JSON.stringify(message))
  }

  open(vmId, { purpose = 'oauth', interactive = true } = {}) {
    void this.acquire(vmId, { purpose, interactive, retain: interactive }).catch(() => {})
    return this.state(vmId)
  }

  async acquire(vmId, { purpose = 'platform', interactive = false, retain = interactive, signal } = {}) {
    signal?.throwIfAborted()
    if (this.stopped) throw problem('browser_stopped', '浏览器服务正在关闭')
    const current = this.currentVm(vmId)
    let live = this.jobs.get(vmId)
    if (live && (live.closing || live.closeSignal.aborted)) {
      if (interactive) throw problem('browser_close_failed', live.message || '浏览器清理尚未完成，请重试关闭')
      await abortable(live.closed, signal)
      signal?.throwIfAborted()
      return this.acquire(vmId, { purpose, interactive, retain, signal })
    }
    if (live && !live.closeSignal.aborted) {
      // A balance refresh must not navigate away from an administrator's login.
      if (!interactive && live.retained) {
        await abortable(live.closed, signal)
        signal?.throwIfAborted()
        return this.acquire(vmId, { purpose, interactive, retain, signal })
      }
      this.assertCurrent(live)
      live.retained ||= retain
      if (interactive) {
        live.purpose = purpose
        live.interactive = true
        const index = this.queue.indexOf(live)
        if (index > -1) {
          this.queue.splice(index, 1)
          this.queue.unshift(live)
        }
      }
      return abortable(live.ready, signal)
    }
    const ready = deferred()
    const closed = deferred()
    const controller = new AbortController()
    live = {
      id: crypto.randomBytes(16).toString('hex'),
      vmId,
      purpose,
      interactive,
      retained: retain,
      proxyUrl: current.proxyUrl,
      accountId: this.profileRepo.get(vmId)?.account_id || current.accountId,
      status: 'queued',
      message: '浏览器任务已排队',
      clients: new Set(),
      touchedAt: this.now(),
      closeSignal: controller.signal,
      controller,
      ready: ready.promise,
      closed: closed.promise,
      resolveReady: ready.resolve,
      rejectReady: ready.reject,
      resolveClosed: closed.resolve,
    }
    this.jobs.set(vmId, live)
    if (interactive) this.queue.unshift(live)
    else this.queue.push(live)
    void this.drain()
    return abortable(live.ready, signal, () => {
      if (this.jobs.get(vmId) === live) void this.close(vmId, { reason: 'cancelled' }).catch(() => {})
    })
  }

  async drain() {
    if (this.draining || this.runtime?.isInstalling) return
    this.draining = true
    try {
      while (this.queue.length && !this.stopped && !this.runtime?.isInstalling) {
        const live = this.queue.shift()
        if (live.closeSignal.aborted) continue
        this.active = live
        live.starting = this.startSession(live)
        try {
          await live.starting
        } catch (error) {
          if (live.closing) await live.closing.catch(() => {})
          else if (!live.closeSignal.aborted) {
            this.setStatus(live, 'error', safeMessage(error), { error: error.code || 'browser_start_failed' })
            await this.finishClose(live, 'error', error).catch(() => {})
          }
        }
        // Aborting input does not prove that the browser or its files exited.
        // A failed close keeps this slot occupied until a successful retry.
        await live.closed
        if (this.active === live) this.active = null
      }
    } finally {
      this.draining = false
    }
  }

  assertCurrent(live) {
    if (live.closeSignal.aborted || this.jobs.get(live.vmId) !== live) throw problem('browser_closed', '浏览器已关闭')
    const current = this.currentVm(live.vmId)
    if (current.proxyUrl !== live.proxyUrl) throw problem('api_proxy_changed', '槽位代理已更换，请重新打开浏览器')
    const expected = live.accountId
    const actual = current.accountId
    if (expected && actual && expected !== actual)
      throw problem('api_account_changed', '槽位账号已变更，请重新打开浏览器')
    return current
  }

  async startSession(live) {
    this.assertCurrent(live)
    const profile = this.profileRepo.get(live.vmId)
    this.setStatus(live, 'starting', '正在启动槽位浏览器')
    let browser
    try {
      const launchConfig = this.runtime ? await this.runtime.launchConfig() : {}
      this.assertCurrent(live)
      if (!profile) this.profileRepo.upsert(live.vmId, { account_id: live.accountId || '' })
      browser = await this.createSession({
        ...launchConfig,
        profileDir: this.profileDirectory(live.vmId),
        storageState: profile?.storage_state,
        proxyUrl: live.proxyUrl,
        signal: live.closeSignal,
      })
    } catch (error) {
      if (error.pendingSession) {
        live.browser = error.pendingSession
        live.pendingCloseError = error
      }
      throw error
    }
    live.browser = browser
    live.warning = browser.warning || null
    if (live.closeSignal.aborted) return
    live.page = browser.page
    live.context = browser.context
    if (profile?.storage_state?.cookies_pending) await this.persist(live)
    await browser.context.route?.('**/*', async (route) => {
      try {
        this.assertCurrent(live)
        await route.continue()
      } catch {
        await route.abort().catch(() => {})
        void this.close(live.vmId, { reason: 'identity_changed' }).catch(() => {})
      }
    })
    const navigationLocked = () =>
      live.inputLocked === true ||
      live.closeSignal.aborted ||
      live.authorizationInProgress?.() === true ||
      live.status === 'opening' ||
      (live.purpose === 'oauth' && ['ready', 'starting'].includes(live.status))
    live.stream = new this.Stream({
      page: live.page,
      assertCurrent: () => this.assertCurrent(live),
      onInput: (input) => {
        if (live.status === 'closing' || live.status === 'close_failed') return false
        live.touchedAt = this.now()
        return !live.inputLocked || input.type === 'close' || input.type === 'continue'
      },
      onClose: () => this.close(live.vmId),
      onContinue: () => live.checkLogin?.(),
      onReturnToAuthorization: () => {
        this.assertCurrent(live)
        if (!live.canReturnToAuthorization?.()) {
          throw problem('oauth_return_unavailable', '当前授权会话不可返回，请重新登录。')
        }
        return live.returnToAuthorization()
      },
      canReturnToAuthorization: () => !navigationLocked() && live.canReturnToAuthorization?.() === true,
      isInputLocked: navigationLocked,
      isAuthorizationCompleting: () => live.authorizationInProgress?.() === true || live.status === 'oauth_complete',
      now: this.now,
    })
    for (const ws of live.clients) live.stream.attach(ws)
    this.setStatus(live, 'ready', '浏览器已就绪')
    live.resolveReady(live)
    live.watchdog = setInterval(() => {
      try {
        this.assertCurrent(live)
        if (this.now() - live.touchedAt > IDLE_TIMEOUT) void this.close(live.vmId, { reason: 'idle' }).catch(() => {})
      } catch {
        void this.close(live.vmId, { reason: 'identity_changed' }).catch(() => {})
      }
    }, 2_000)
    live.watchdog.unref?.()
  }

  async persist(live) {
    if (!live.browser?.storageState || live.closeSignal.aborted || live.persistable === false) return
    this.assertCurrent(live)
    this.profileRepo.upsert(live.vmId, {
      storage_state: await live.browser.storageState(),
      ...(live.accountId ? { account_id: live.accountId } : {}),
    })
  }

  bindAccount(live, accountId) {
    const current = this.assertCurrent(live)
    if (current.accountId && current.accountId !== accountId)
      throw problem('api_account_changed', '槽位账号已变更，请重新打开浏览器')
    live.accountId = accountId
    this.profileRepo.upsert(live.vmId, { account_id: accountId })
  }

  async release(live) {
    if (!live.retained && this.jobs.get(live.vmId) === live) await this.close(live.vmId)
  }

  profileDirectory(vmId) {
    if (!isValidVmId(vmId)) throw problem('invalid_vm_id', '非法槽位 ID', 400)
    return path.join(this.cfg.paths.project, 'vms', vmId, 'browser-profile')
  }

  forgetProfile(vmId) {
    fs.rmSync(this.profileDirectory(vmId), { recursive: true, force: true })
    this.profileRepo.remove(vmId)
  }

  async close(vmId, { reason = 'closed', forget = false } = {}) {
    const live = this.jobs.get(vmId)
    if (!live) {
      if (forget) {
        this.forgetProfile(vmId)
        this.states.delete(vmId)
      }
      return this.state(vmId)
    }
    if (live.closing) return live.closing
    live.forget ||= forget
    this.beginClose(live)
    live.closing = (async () => {
      if (!live.forget && !live.persistAttempted) {
        live.persistAttempted = true
        try {
          await this.persist(live)
        } catch {
          live.warning = [live.warning, '本次浏览器会话保存失败，可能需要重新登录。'].filter(Boolean).join(' ')
        }
      }
      live.controller.abort(reason)
      live.cancel?.()
      if (live.starting) await live.starting.catch(() => {})
      await this.finishClose(live, reason)
      if (live.forget) {
        this.states.delete(vmId)
      }
      return this.state(vmId)
    })()
    try {
      return await live.closing
    } finally {
      // A failed close must remain retryable rather than caching a rejected promise.
      live.closing = null
    }
  }

  beginClose(live) {
    live.inputLocked = true
    live.stream?.sendNavigation?.()
    clearInterval(live.watchdog)
    for (const [ticket, grant] of this.tickets) if (grant.liveId === live.id) this.tickets.delete(ticket)
    if (live.status !== 'closing') {
      live.status = 'closing'
      live.message = '正在关闭浏览器…'
      live.statusDetails = {}
      this.send(live, {
        type: 'status',
        status: 'closing',
        purpose: live.purpose,
        message: live.message,
        ...(live.warning ? { warning: live.warning } : {}),
      })
    }
    live.stream?.close()
  }

  async finishClose(live, reason, error = null) {
    live.controller.abort(reason)
    this.beginClose(live)
    try {
      if (live.pendingCloseError) {
        const failure = live.pendingCloseError
        live.pendingCloseError = null
        throw failure
      }
      await live.browser?.close()
      if (live.forget) this.forgetProfile(live.vmId)
      if (live.browser?.warning && !live.warning?.includes(live.browser.warning))
        live.warning = [live.warning, live.browser.warning].filter(Boolean).join(' ')
    } catch (closeError) {
      live.status = 'close_failed'
      live.message = safeMessage(closeError)
      this.send(live, {
        type: 'status',
        status: 'close_failed',
        purpose: live.purpose,
        message: live.message,
        ...(live.warning ? { warning: live.warning } : {}),
      })
      const failure = problem(closeError.code || 'browser_close_failed', live.message, 502)
      live.rejectReady(failure)
      throw failure
    }
    const status = reason === 'error' ? 'error' : 'closed'
    const message = error ? safeMessage(error) : null
    this.send(live, {
      type: 'status',
      status,
      purpose: live.purpose,
      ...(message ? { message } : {}),
      ...(error ? { error: error.code || 'browser_start_failed' } : {}),
      ...(live.warning ? { warning: live.warning } : {}),
    })
    for (const ws of live.clients) ws.close()
    live.clients.clear()
    if (this.jobs.get(live.vmId) === live) this.jobs.delete(live.vmId)
    this.queue = this.queue.filter((item) => item !== live)
    for (const [ticket, grant] of this.tickets) if (grant.liveId === live.id) this.tickets.delete(ticket)
    this.states.set(live.vmId, {
      vm_id: live.vmId,
      active: false,
      status,
      purpose: live.purpose,
      message,
      ...(error ? { error: error.code || 'browser_start_failed' } : {}),
      ...(live.warning ? { warning: live.warning } : {}),
    })
    live.rejectReady(error || problem('browser_closed', '浏览器已关闭'))
    live.resolveClosed({ reason })
    void this.drain()
  }

  cancel(vmId, options) {
    return this.close(vmId, options)
  }

  browserTicket(vmId, { purpose = 'oauth' } = {}) {
    this.currentVm(vmId)
    if (!this.runtime?.isInstalling) this.runtime?.launchConfig()
    if (!this.jobs.has(vmId)) this.open(vmId, { purpose, interactive: true })
    const live = this.jobs.get(vmId)
    if (live?.status === 'close_failed')
      throw problem('browser_close_failed', live.message || '浏览器清理未完成，请重试关闭')
    if (live?.closing || live?.status === 'closing') throw problem('browser_closed', '浏览器正在关闭，请稍后重试')
    if (!live || live.closeSignal.aborted) throw problem('browser_closed', '浏览器正在关闭，请稍后重试')
    live.retained = true
    const ticket = crypto.randomBytes(24).toString('hex')
    for (const [key, grant] of this.tickets) if (grant.expires < this.now()) this.tickets.delete(key)
    this.tickets.set(ticket, { vmId, liveId: live.id, expires: this.now() + 30_000 })
    return { ticket, url: `/api/panel/vms/${encodeURIComponent(vmId)}/browser?ticket=${ticket}` }
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const match = url.pathname.match(BROWSER_PATH)
    if (!match) return false
    let vmId
    try {
      vmId = decodeURIComponent(match[1])
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return true
    }
    const ticket = url.searchParams.get('ticket')
    const grant = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    const live = this.jobs.get(vmId)
    let current = false
    try {
      if (live) {
        this.assertCurrent(live)
        current = true
      }
    } catch {}
    if (!grant || grant.vmId !== vmId || grant.liveId !== live?.id || grant.expires < this.now() || !current) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return true
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      live.clients.add(ws)
      live.touchedAt = this.now()
      ws.once('close', () => live.clients.delete(ws))
      ws.on('error', () => {})
      ws.on('message', (raw) => {
        if (live.stream) return
        try {
          if (JSON.parse(String(raw)).type === 'close') void this.close(vmId).catch(() => {})
        } catch {}
      })
      live.stream?.attach(ws)
      ws.send(
        JSON.stringify({
          type: 'status',
          status: live.status,
          purpose: live.purpose,
          message: live.message,
          ...(live.warning ? { warning: live.warning } : {}),
          ...live.statusDetails,
        }),
      )
    })
    return true
  }

  async stop() {
    this.stopped = true
    const results = await Promise.allSettled([...this.jobs.keys()].map((id) => this.close(id, { reason: 'shutdown' })))
    this.tickets.clear()
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw Object.assign(
        new AggregateError(
          failures.map((result) => result.reason),
          '部分浏览器清理未完成',
        ),
        {
          code: 'browser_close_failed',
        },
      )
  }

  start() {
    this.stopped = false
  }
}
