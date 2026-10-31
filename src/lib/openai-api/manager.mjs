import crypto from 'node:crypto'
import { SlotBrowserManager } from '../browser/slot-browser-manager.mjs'
import { SlotBrowserRepo } from '../db/repos/slot-browser-repo.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { hasBoundExit } from '../vm/egress.mjs'
import { fetchUpstreamModels } from '../admin/api-endpoints.mjs'
import { createPlatformBrowserSession } from './platform-browser.mjs'
import { PlatformAdapter } from './platform-adapter.mjs'

const BALANCE_INTERVAL = 10 * 60_000
const IDLE_TIMEOUT = 15 * 60_000

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

/** One browser task at a time. API inference itself never needs this browser. */
export class OpenaiApiManager {
  constructor({
    cfg,
    repo,
    credits,
    apiEndpointStore,
    apiScheduler,
    createSession = createPlatformBrowserSession,
    browserManager,
    Adapter = PlatformAdapter,
    fetchModels = fetchUpstreamModels,
    now = Date.now,
  } = {}) {
    Object.assign(this, {
      cfg,
      repo,
      credits,
      apiEndpointStore,
      apiScheduler,
      createSession,
      Adapter,
      fetchModels,
      now,
    })
    this.queue = []
    this.jobs = new Map()
    this.sessions = new Map()
    this.running = false
    this.stopped = false
    this.ownsBrowserManager = !browserManager
    this.browserManager =
      browserManager ||
      new SlotBrowserManager({
        cfg,
        profileRepo: new SlotBrowserRepo(repo.db),
        createSession,
        getVm: (id) => credits.accountForVm(id).vm,
        getAccountIdentity: (id) => credits.accountForVm(id).accountId,
      })
  }

  view(vm) {
    const view = this.credits.view(vm)
    return view ? { ...view, browser_active: !!this.browserManager.state(vm.id).active } : null
  }

  resolveAccountKey(key) {
    try {
      const { vm, account, accountId, record } = this.credits.accountForVm(key.source_vm_id)
      if (accountId !== key.source_account_id || record?.key_id !== key.id || !hasBoundExit(vm.proxy)) return null
      const proxyUrl = hostProxyUrlForVm(vm)
      return { accountId, enabled: !!record.enabled, proxyUrl, email: account.email || '' }
    } catch {
      return null
    }
  }

  setEnabled(vmId, enabled) {
    const { vm, accountId, record } = this.credits.accountForVm(vmId)
    if (!record?.key_id) throw problem('api_key_required', '请先完成 API 配置')
    this.repo.upsertAccount(accountId, { enabled: !!enabled })
    this.reload()
    return this.view(vm)
  }

  recordKeyError(key, error) {
    const source = this.resolveAccountKey(key)
    if (source) this.repo.upsertAccount(source.accountId, { last_error: safeMessage(error) })
  }

  setup(vmId) {
    const context = this.credits.accountForVm(vmId)
    if (!['claimed', 'pending'].includes(context.record?.claim_status))
      throw problem('api_promo_link_required', '请先查询并领取 API 赠额')
    this.enqueue(context, 'setup', true)
    return this.view(context.vm)
  }

  async refresh(vmId) {
    let context = this.credits.accountForVm(vmId)
    if (context.record?.claim_status === 'pending') await this.credits.refreshClaim(vmId)
    context = this.credits.accountForVm(vmId)
    if (context.record?.key_id) this.enqueue(context, 'balance', true)
    else if (context.record?.claim_status === 'claimed') this.enqueue(context, 'setup', true)
    return this.view(context.vm)
  }

  enqueue(context, kind, interactive) {
    const vmId = context.vm.id
    const existing = this.jobs.get(vmId)
    if (existing) {
      if (interactive && !existing.interactive) {
        if (existing.promoted) {
          if (kind === 'setup') existing.promoted.kind = 'setup'
          return existing
        }
        existing.promoted = { kind }
        // Background work can be waiting for this very manual window to close.
        // Cancel only that work, retain the window, then reuse it interactively.
        const live = this.sessions.get(vmId)
        if (live?.job === existing) live.retained = true
        existing.abort.abort()
        live?.cancel?.()
        void existing.finished.then(() => {
          const requested = existing.promoted
          existing.promoted = null
          if (!requested || this.stopped) return
          try {
            const current = this.credits.accountForVm(vmId)
            if (current.accountId === existing.accountId) this.enqueue(current, requested.kind, true)
          } catch {
            /* A deleted slot has no task to promote. */
          }
        })
      }
      return existing
    }
    if (!hasBoundExit(context.vm.proxy) || !hostProxyUrlForVm(context.vm))
      throw problem('proxy_required', '账号未绑定可用代理')
    let ready, finished
    const job = {
      abort: new AbortController(),
      finished: new Promise((resolve) => {
        finished = resolve
      }),
      resolveFinished: () => finished(),
      vmId,
      accountId: context.accountId,
      kind,
      interactive,
      ready: new Promise((resolve) => {
        ready = resolve
      }),
      resolveReady: (value) => ready(value),
    }
    this.repo.upsertAccount(context.accountId, { vm_id: vmId, setup_status: 'configuring', last_error: null })
    this.jobs.set(vmId, job)
    if (interactive) this.queue.unshift(job)
    else this.queue.push(job)
    this.drain()
    return job
  }

  drain() {
    if (this.stopped) return
    this.running = true
    while (this.queue.length) {
      const job = this.queue.shift()
      job.execution = this.runJob(job)
    }
    this.draining = Promise.allSettled([...this.jobs.values()].map((job) => job.finished))
  }

  async runJob(job) {
    try {
      await this.run(job)
    } catch (error) {
      let current
      try {
        current = this.credits.accountForVm(job.vmId)
      } catch {}
      if (error.code === 'platform_account_mismatch') {
        const live = this.sessions.get(job.vmId)
        if (live) live.persistable = false
      }
      if (current?.accountId === job.accountId && !job.abort.signal.aborted && this.jobs.get(job.vmId) === job) {
        const login = error.code === 'platform_login_required'
        this.repo.upsertAccount(job.accountId, {
          setup_status: login ? 'needs_login' : 'error',
          last_error: safeMessage(error),
        })
        if (current.record?.organization_id)
          this.repo.upsertOrg(current.record.organization_id, { balance_error: safeMessage(error) })
      }
    } finally {
      const live = this.sessions.get(job.vmId)
      if (live?.job === job) {
        await this.persistSession(live)
        const status = this.repo.getAccount(job.accountId)?.setup_status || 'error'
        this.browserManager.setStatus(
          live,
          status === 'ready' ? 'api_ready' : status,
          this.repo.getAccount(job.accountId)?.last_error,
        )
        live.adapter?.dispose?.()
        live.inputLocked = false
        live.cancel = null
        live.checkLogin = null
        await this.browserManager.release(live)
        if (this.sessions.get(job.vmId) === live) this.sessions.delete(job.vmId)
      }
      job.resolveReady(null)
      if (this.jobs.get(job.vmId) === job) this.jobs.delete(job.vmId)
      job.resolveFinished()
    }
    this.running = this.jobs.size > 0
  }

  assertCurrent(job) {
    job.abort.signal.throwIfAborted()
    if (this.jobs.get(job.vmId) !== job) throw problem('api_task_replaced', 'API 任务已取消或替换')
    const context = this.credits.accountForVm(job.vmId)
    if (context.accountId !== job.accountId) throw problem('api_account_changed', '账号已更换，请重新打开配置', 409)
    const proxyUrl = hostProxyUrlForVm(context.vm)
    if (!hasBoundExit(context.vm.proxy) || !proxyUrl) throw problem('proxy_required', '账号未绑定可用代理')
    if (job.proxyUrl && job.proxyUrl !== proxyUrl)
      throw problem('api_proxy_changed', '账号代理已更换，请重新打开配置', 409)
    return context
  }

  async run(job) {
    const context = this.assertCurrent(job)
    job.proxyUrl = hostProxyUrlForVm(context.vm)
    const live = await this.browserManager.acquire(job.vmId, {
      purpose: 'platform',
      interactive: job.interactive,
      retain: job.interactive,
      signal: job.abort.signal,
    })
    if (this.stopped || job.abort.signal.aborted) {
      await this.browserManager.close(job.vmId)
      return
    }
    this.assertCurrent(job)
    const browser = live.browser
    live.job = job
    live.waiting = false
    live.inputLocked = true
    this.sessions.set(job.vmId, live)
    job.resolveReady(live)
    this.browserManager.setStatus(live, 'opening', '正在打开 OpenAI Platform')
    const adapter = new this.Adapter({
      page: browser.page,
      context: browser.context,
      email: context.account.email,
      organizationId: context.record?.organization_id,
      projectId: context.record?.organization_id ? this.repo.getOrg(context.record.organization_id)?.project_id : null,
    })
    live.adapter = adapter
    await browser.page.goto('https://platform.openai.com/settings/organization/general', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    let identity = await adapter.inspect()
    if (!identity.authenticated) {
      if (!job.interactive) throw problem('platform_login_required', 'Platform 会话已失效，请补充登录')
      this.repo.upsertAccount(job.accountId, { setup_status: 'needs_login', last_error: null })
      live.inputLocked = false
      this.browserManager.setStatus(live, 'needs_login', '请在此窗口完成 OpenAI Platform 登录')
      identity = await this.waitForLogin(live)
    }
    if (String(identity.email || '').toLowerCase() !== String(context.account.email || '').toLowerCase())
      throw problem('platform_account_mismatch', 'Platform 登录邮箱与当前账号不一致', 409)
    live.identityVerified = true
    live.inputLocked = true
    this.browserManager.bindAccount(live, job.accountId)
    this.assertCurrent(job)
    this.repo.upsertAccount(job.accountId, { setup_status: 'configuring', last_error: null })
    await this.persistSession(live)
    let record = this.repo.getAccount(job.accountId)
    let organizationId = record.organization_id || identity.organizationId
    // A sole owned organization can be chosen for an external claim only after real Platform login.
    if (!organizationId && identity.organizations?.length === 1) organizationId = identity.organizations[0].id
    if (!organizationId) throw problem('api_org_required', '请在 Platform 中选择接收赠额的组织')
    const existingKey = record.key_id ? this.repo.getKey(record.key_id) : null
    if (existingKey && (existingKey.source_vm_id !== job.vmId || existingKey.source_account_id !== job.accountId))
      throw problem('api_key_account_mismatch', '已保存的 API key 与当前账号不匹配', 409)
    if (!existingKey) {
      const org = this.repo.getOrg(organizationId)
      const keyName = 'vm2api-' + crypto.createHash('sha256').update(job.accountId).digest('hex').slice(0, 12)
      const saveKey = async (created) => {
        this.assertCurrent(job)
        if (!created.apiKey || !created.projectId) throw problem('platform_key_missing', 'Platform 未返回完整项目 key')
        organizationId = created.organizationId || organizationId
        const organizationName =
          created.organizationName || identity.organizations?.find((x) => x.id === organizationId)?.name || 'OpenAI'
        const endpoint = this.apiEndpointStore.create({ kind: 'openai', name: `OpenAI API · ${context.account.email}` })
        this.repo.upsertOrg(organizationId, {
          display_name: organizationName,
          project_id: created.projectId,
        })
        const key = this.apiEndpointStore.addKey(endpoint.id, {
          api_key: created.apiKey,
          source_vm_id: job.vmId,
          source_account_id: job.accountId,
        })
        this.repo.upsertAccount(job.accountId, { organization_id: organizationId, key_id: key.id, enabled: true })
        this.reload()
      }
      const created = await adapter.configure({ organizationId, projectId: org?.project_id, keyName, onKey: saveKey })
      if (!this.repo.getAccount(job.accountId).key_id && created?.apiKey) await saveKey(created)
    }
    record = this.repo.getAccount(job.accountId)
    if (!record.key_id) throw problem('platform_key_missing', '项目 key 尚未完成保存')
    if (this.repo.getKey(record.key_id)?.disabled)
      throw problem('invalid_api_key', '已保存的项目 API key 已失效，请在 Platform 核对密钥')
    try {
      await this.updateBalance(live, organizationId)
    } catch (error) {
      this.assertCurrent(job)
      this.repo.upsertOrg(organizationId, { balance_error: safeMessage(error) })
    }
    const endpoint = this.apiEndpointStore.getRaw(this.repo.getKey(record.key_id).endpoint_id)
    if (endpoint && (!endpoint.models?.length || job.kind === 'setup')) {
      const current = this.assertCurrent(job)
      const key = this.repo.getKey(record.key_id)
      const fetched = await this.fetchModels({
        cfg: this.cfg,
        kind: 'openai',
        api_key: key.api_key,
        proxy_url: hostProxyUrlForVm(current.vm),
      })
      this.assertCurrent(job)
      this.apiEndpointStore.mergeFetchedModels(endpoint.id, fetched.models)
    }
    this.assertCurrent(job)
    this.repo.upsertAccount(job.accountId, { setup_status: 'ready', last_error: null })
    this.reload()
    this.browserManager.setStatus(live, 'api_ready', 'API 配置已完成')
  }

  async updateBalance(live, organizationId) {
    this.assertCurrent(live.job)
    const result = await live.adapter.readBalance({ organizationId })
    this.assertCurrent(live.job)
    if (result.balance == null || !/^-?\d+(?:\.\d+)?$/.test(String(result.balance)))
      throw problem('platform_balance_missing', '官方 Billing 尚未返回可用余额')
    this.repo.upsertOrg(organizationId, {
      balance: String(result.balance),
      paid_balance: result.paid_balance ?? null,
      grants: result.grants || [],
      next_expiring_amount: result.next_expiring_amount ?? null,
      next_expiring_at: result.next_expiring_at ?? null,
      balance_checked_at: new Date(this.now()).toISOString(),
      balance_error: null,
    })
    if (Number(result.balance) > 0) {
      for (const account of this.repo.listAccounts()) {
        if (account.organization_id !== organizationId || !account.key_id) continue
        const key = this.repo.getKey(account.key_id)
        if (key?.cooldown_until === '9999-12-31T23:59:59.999Z') this.apiEndpointStore.setKeyCooldown(key.id, null)
      }
    }
  }

  async persistSession(live) {
    if (live.persistable === false) return
    try {
      await this.browserManager.persist(live)
    } catch {}
  }

  async waitForLogin(live) {
    live.waiting = true
    return new Promise((resolve, reject) => {
      let inspecting = false
      const finish = (value, error) => {
        clearInterval(timer)
        live.closeSignal.removeEventListener('abort', live.cancel)
        live.waiting = false
        live.checkLogin = null
        live.cancel = null
        error ? reject(error) : resolve(value)
      }
      live.cancel = () => finish(null, problem('platform_login_required', '登录尚未完成，可继续配置'))
      live.closeSignal.addEventListener('abort', live.cancel, { once: true })
      live.checkLogin = async () => {
        if (inspecting) return
        inspecting = true
        try {
          this.assertCurrent(live.job)
          if (this.now() - live.touchedAt > IDLE_TIMEOUT) return live.cancel()
          const identity = await live.adapter.inspect()
          if (identity.authenticated) finish(identity)
        } catch (error) {
          finish(null, error)
        } finally {
          inspecting = false
        }
      }
      const timer = setInterval(() => void live.checkLogin?.(), 3_000)
      timer.unref?.()
    })
  }

  browserTicket(vmId) {
    this.credits.accountForVm(vmId)
    if (!this.jobs.has(vmId)) this.setup(vmId)
    return this.browserManager.browserTicket(vmId, { purpose: 'platform' })
  }

  handleUpgrade(req, socket, head) {
    return this.browserManager.handleUpgrade(req, socket, head)
  }

  send(live, message) {
    this.browserManager.send(live, message)
  }

  async cancel(vmId, { forget = false, closeBrowser = true } = {}) {
    const active = this.sessions.get(vmId)
    if (!closeBrowser && active && !active.waiting)
      throw problem('platform_browser_busy', 'API 配置正在执行，请完成后再开始 OAuth 登录', 409)
    const currentJob = this.jobs.get(vmId)
    if (currentJob) {
      currentJob.promoted = null
      currentJob.abort.abort()
    }
    const queued = this.queue.filter((job) => job.vmId === vmId)
    this.queue = this.queue.filter((job) => job.vmId !== vmId)
    for (const job of queued) {
      job.resolveReady(null)
      job.resolveFinished()
      this.jobs.delete(vmId)
    }
    this.sessions.get(vmId)?.cancel?.()
    if (closeBrowser) await this.browserManager.close(vmId, { forget })
    const job = this.jobs.get(vmId)
    if (job) await job.finished
  }

  reload() {
    this.apiScheduler.reload(this.apiEndpointStore.listRaw())
  }

  async tick() {
    if (this.ticking || this.stopped) return
    this.ticking = true
    try {
      const dueOrgs = new Set()
      for (const account of this.repo.listAccounts()) {
        let context
        try {
          context = this.credits.accountForVm(account.vm_id)
        } catch {
          continue
        }
        if (context.accountId !== account.account_id) continue
        if (account.claim_status === 'pending' && account.operation_id)
          await this.credits.refreshClaim(account.vm_id).catch(() => {})
        if (!account.enabled || !account.key_id || !account.organization_id || dueOrgs.has(account.organization_id))
          continue
        const org = this.repo.getOrg(account.organization_id)
        if (this.now() - Date.parse(org?.balance_checked_at || org?.updated_at || 0) < BALANCE_INTERVAL) continue
        if (account.setup_status === 'needs_login') continue
        try {
          this.enqueue(context, 'balance', false)
          dueOrgs.add(account.organization_id)
        } catch {
          /* The next cycle can use a restored proxy. */
        }
      }
    } finally {
      this.ticking = false
    }
  }

  start() {
    this.stopped = false
    this.browserManager.start()
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 30_000)
    this.timer.unref?.()
  }

  async stop() {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = null
    for (const job of this.queue) {
      job.resolveReady(null)
      job.resolveFinished()
      this.jobs.delete(job.vmId)
    }
    this.queue.length = 0
    for (const job of this.jobs.values()) job.abort.abort()
    if (this.ownsBrowserManager) await this.browserManager.stop()
    else for (const vmId of this.jobs.keys()) await this.browserManager.close(vmId)
    await this.draining
  }
}

function safeMessage(error) {
  return String(error?.message || 'API 配置失败')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[key]')
    .slice(0, 300)
}
