import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'
import { getVm as readVm } from '../vm/vm-registry.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { hasBoundExit } from '../vm/egress.mjs'
import { createPlatformBrowserSession } from '../openai-api/platform-browser.mjs'
import { BrowserStream } from './browser-stream.mjs'

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
    .replace(/sk-[A-Za-z0-9_-]+/g, '[key]')
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
    getVm = (id) => readVm(cfg.paths.project, id),
    getAccountIdentity = (_id, vm) => vm.codex?.chatgpt_account_id || '',
    resolveProxy = hostProxyUrlForVm,
    createSession = createPlatformBrowserSession,
    Stream = BrowserStream,
    now = Date.now,
  } = {}) {
    Object.assign(this, { cfg, profileRepo, getVm, getAccountIdentity, resolveProxy, createSession, Stream, now })
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
        ...live.statusDetails,
      }
    return this.states.get(vmId) || { vm_id: vmId, active: false, status: 'closed', purpose: null, message: null }
  }

  setStatus(live, status, message = null, details = {}) {
    if (live.closeSignal.aborted) return
    live.status = status
    live.message = message
    live.statusDetails = details
    this.send(live, { type: 'status', status, purpose: live.purpose, ...(message ? { message } : {}), ...details })
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
      if (this.jobs.get(vmId) === live) void this.close(vmId, { reason: 'cancelled' })
    })
  }

  async drain() {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length && !this.stopped) {
        const live = this.queue.shift()
        if (live.closeSignal.aborted) continue
        this.active = live
        live.starting = this.startSession(live)
        try {
          await live.starting
        } catch (error) {
          if (!live.closeSignal.aborted) {
            this.setStatus(live, 'error', safeMessage(error))
            await this.finishClose(live, 'error', error)
          }
        }
        if (!live.closeSignal.aborted) await live.closed
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
    const { vm } = this.assertCurrent(live)
    const profile = this.profileRepo.get(live.vmId)
    this.setStatus(live, 'starting', '正在启动槽位浏览器')
    const browser = await this.createSession({
      fingerprint: profile?.fingerprint,
      storageState: profile?.storage_state,
      proxyUrl: live.proxyUrl,
      locale: vm.locale,
      signal: live.closeSignal,
      onFingerprint: (fingerprint) => {
        this.assertCurrent(live)
        this.profileRepo.upsert(live.vmId, { fingerprint })
      },
    })
    if (live.closeSignal.aborted) {
      await browser.close()
      return
    }
    live.browser = browser
    live.page = browser.page
    live.context = browser.context
    await browser.context.route?.('**/*', async (route) => {
      try {
        this.assertCurrent(live)
        await route.continue()
      } catch {
        await route.abort().catch(() => {})
        void this.close(live.vmId, { reason: 'identity_changed' })
      }
    })
    live.stream = new this.Stream({
      page: live.page,
      assertCurrent: () => this.assertCurrent(live),
      onInput: (input) => {
        live.touchedAt = this.now()
        return !live.inputLocked || input.type === 'close' || input.type === 'continue'
      },
      onClose: () => this.close(live.vmId),
      onContinue: () => live.checkLogin?.(),
      now: this.now,
    })
    for (const ws of live.clients) live.stream.attach(ws)
    this.setStatus(live, 'ready', '浏览器已就绪')
    live.resolveReady(live)
    live.watchdog = setInterval(() => {
      try {
        this.assertCurrent(live)
        if (this.now() - live.touchedAt > IDLE_TIMEOUT) void this.close(live.vmId, { reason: 'idle' })
      } catch {
        void this.close(live.vmId, { reason: 'identity_changed' })
      }
    }, 2_000)
    live.watchdog.unref?.()
  }

  async persist(live) {
    if (!live.browser || live.closeSignal.aborted || live.persistable === false) return
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

  async close(vmId, { reason = 'closed', forget = false } = {}) {
    const live = this.jobs.get(vmId)
    if (!live) {
      if (forget) {
        this.profileRepo.remove(vmId)
        this.states.delete(vmId)
      }
      return
    }
    if (live.closing) return live.closing
    live.closing = (async () => {
      if (!forget) await this.persist(live).catch(() => {})
      live.controller.abort(reason)
      live.cancel?.()
      if (live.starting) await live.starting.catch(() => {})
      await this.finishClose(live, reason)
      if (forget) {
        this.profileRepo.remove(vmId)
        this.states.delete(vmId)
      }
    })()
    return live.closing
  }

  async finishClose(live, reason, error = null) {
    live.controller.abort(reason)
    clearInterval(live.watchdog)
    const status = reason === 'error' ? 'error' : 'closed'
    const message = error ? safeMessage(error) : null
    this.send(live, { type: 'status', status, purpose: live.purpose, ...(message ? { message } : {}) })
    live.stream?.close()
    await live.browser?.close().catch(() => {})
    for (const ws of live.clients) ws.close()
    live.clients.clear()
    if (this.jobs.get(live.vmId) === live) this.jobs.delete(live.vmId)
    this.queue = this.queue.filter((item) => item !== live)
    for (const [ticket, grant] of this.tickets) if (grant.liveId === live.id) this.tickets.delete(ticket)
    this.states.set(live.vmId, { vm_id: live.vmId, active: false, status, purpose: live.purpose, message })
    live.rejectReady(error || problem('browser_closed', '浏览器已关闭'))
    live.resolveClosed({ reason })
    void this.drain()
  }

  cancel(vmId, options) {
    return this.close(vmId, options)
  }

  browserTicket(vmId, { purpose = 'oauth' } = {}) {
    this.currentVm(vmId)
    if (!this.jobs.has(vmId)) this.open(vmId, { purpose, interactive: true })
    const live = this.jobs.get(vmId)
    if (!live || live.closeSignal.aborted) throw problem('browser_closed', '浏览器正在关闭，请重新打开')
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
          if (JSON.parse(String(raw)).type === 'close') void this.close(vmId)
        } catch {}
      })
      live.stream?.attach(ws)
      ws.send(
        JSON.stringify({
          type: 'status',
          status: live.status,
          purpose: live.purpose,
          message: live.message,
          ...live.statusDetails,
        }),
      )
    })
    return true
  }

  async stop() {
    this.stopped = true
    await Promise.all([...this.jobs.keys()].map((id) => this.close(id, { reason: 'shutdown' })))
    this.tickets.clear()
  }

  start() {
    this.stopped = false
  }
}
