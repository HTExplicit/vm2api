import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { hasBoundExit } from '../vm/egress.mjs'
import { fetchUpstreamModels } from '../admin/api-endpoints.mjs'
import { createPlatformBrowserSession } from './platform-browser.mjs'
import { PlatformAdapter } from './platform-adapter.mjs'

const BALANCE_INTERVAL = 10 * 60_000
const IDLE_TIMEOUT = 15 * 60_000
const BROWSER_PATH = /^\/api\/panel\/vms\/([^/]+)\/openai-api\/browser$/

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
    this.tickets = new Map()
    this.running = false
    this.stopped = false
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 })
  }

  view(vm) {
    const view = this.credits.view(vm)
    return view ? { ...view, browser_active: this.sessions.has(vm.id) } : null
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
    if (this.jobs.has(vmId)) return this.jobs.get(vmId)
    if (!hasBoundExit(context.vm.proxy) || !hostProxyUrlForVm(context.vm))
      throw problem('proxy_required', '账号未绑定可用代理')
    let ready
    const job = {
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
    if (!this.running) this.draining = this.drain()
    return job
  }

  async drain() {
    if (this.running || this.stopped) return
    this.running = true
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()
        try {
          await this.run(job)
        } catch (error) {
          let current
          try {
            current = this.credits.accountForVm(job.vmId)
          } catch {}
          if (current?.accountId === job.accountId) {
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
          if (live) {
            await this.persistSession(live)
            this.send(live, { type: 'status', status: this.repo.getAccount(job.accountId)?.setup_status || 'error' })
            live.adapter?.dispose?.()
            await live.browser.close().catch(() => {})
            for (const ws of live.clients) ws.close()
            this.sessions.delete(job.vmId)
          }
          job.resolveReady(null)
          this.jobs.delete(job.vmId)
        }
      }
    } finally {
      this.running = false
    }
  }

  assertCurrent(job) {
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
    const browser = await this.createSession({
      fingerprint: context.record?.fingerprint,
      storageState: context.record?.storage_state,
      proxyUrl: job.proxyUrl,
      timezone: context.vm.timezone,
      locale: context.vm.locale,
      onFingerprint: (fingerprint) => {
        this.assertCurrent(job)
        this.repo.upsertAccount(job.accountId, { fingerprint })
      },
    })
    if (this.stopped) {
      await browser.close()
      return
    }
    const live = { job, browser, page: browser.page, clients: new Set(), touchedAt: this.now(), waiting: false }
    this.sessions.set(job.vmId, live)
    job.resolveReady(live)
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
      this.send(live, { type: 'status', status: 'needs_login', message: '请在此窗口完成 OpenAI Platform 登录' })
      identity = await this.waitForLogin(live)
    }
    if (String(identity.email || '').toLowerCase() !== String(context.account.email || '').toLowerCase())
      throw problem('platform_account_mismatch', 'Platform 登录邮箱与当前账号不一致', 409)
    live.identityVerified = true
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
      this.apiEndpointStore.mergeFetchedModels(endpoint.id, fetched.models)
    }
    this.repo.upsertAccount(job.accountId, { setup_status: 'ready', last_error: null })
    this.reload()
    this.send(live, { type: 'status', status: 'ready' })
  }

  async updateBalance(live, organizationId) {
    this.assertCurrent(live.job)
    const result = await live.adapter.readBalance({ organizationId })
    if (result.balance == null || !/^-?\d+(?:\.\d+)?$/.test(String(result.balance)))
      throw problem('platform_balance_missing', '官方 Billing 尚未返回可用余额')
    this.repo.upsertOrg(organizationId, {
      balance: String(result.balance),
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
    if (!live.identityVerified) return
    try {
      this.assertCurrent(live.job)
      this.repo.upsertAccount(live.job.accountId, { storage_state: await live.browser.storageState() })
    } catch {
      // Keep the last saved session if a closed browser or a changed account cannot be sampled.
    }
  }

  async waitForLogin(live) {
    live.waiting = true
    return new Promise((resolve, reject) => {
      let inspecting = false
      const finish = (value, error) => {
        clearInterval(timer)
        live.waiting = false
        live.checkLogin = null
        live.cancel = null
        error ? reject(error) : resolve(value)
      }
      live.cancel = () => finish(null, problem('platform_login_required', '登录尚未完成，可继续配置'))
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

  async browserTicket(vmId) {
    const context = this.credits.accountForVm(vmId)
    const active = [...this.sessions.values()][0]
    if (active && active.job.vmId !== vmId)
      throw problem('platform_browser_busy', '另一账号正在登录，请完成后再打开', 409)
    if (!this.jobs.has(vmId)) this.setup(vmId)
    const job = this.jobs.get(vmId)
    const live =
      this.sessions.get(vmId) ||
      (job &&
        (await Promise.race([
          job.ready,
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 30_000)
            timer.unref?.()
          }),
        ])))
    if (!live || context.accountId !== live.job.accountId)
      throw problem('platform_browser_unavailable', '浏览器尚未就绪，请稍后重试', 409)
    const ticket = crypto.randomBytes(24).toString('hex')
    for (const [key, value] of this.tickets) if (value.expires < this.now()) this.tickets.delete(key)
    this.tickets.set(ticket, { vmId, accountId: context.accountId, expires: this.now() + 30_000 })
    return { ticket, url: `/api/panel/vms/${encodeURIComponent(vmId)}/openai-api/browser?ticket=${ticket}` }
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const match = url.pathname.match(BROWSER_PATH)
    if (!match) return false
    const ticket = url.searchParams.get('ticket')
    const grant = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    const vmId = decodeURIComponent(match[1])
    const live = this.sessions.get(vmId)
    let current = false
    try {
      if (live) {
        this.assertCurrent(live.job)
        current = true
      }
    } catch {}
    if (
      !grant ||
      grant.vmId !== vmId ||
      grant.expires < this.now() ||
      !live ||
      !current ||
      grant.accountId !== live.job.accountId
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return true
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, live))
    return true
  }

  attach(ws, live) {
    live.clients.add(ws)
    live.touchedAt = this.now()
    let capturing = false
    const capture = async () => {
      if (capturing || ws.readyState !== 1 || ws.bufferedAmount > 1024 * 1024) return
      capturing = true
      try {
        this.assertCurrent(live.job)
        const image = await live.page.screenshot({ type: 'jpeg', quality: 65 })
        const viewport = await live.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        ws.send(JSON.stringify({ type: 'frame', image: image.toString('base64'), mime: 'image/jpeg', ...viewport }))
      } catch {
        /* Page navigation can interrupt one screenshot. */
      } finally {
        capturing = false
      }
    }
    const timer = setInterval(() => void capture(), 750)
    timer.unref?.()
    void capture()
    ws.send(JSON.stringify({ type: 'status', status: this.repo.getAccount(live.job.accountId)?.setup_status }))
    ws.on('message', async (raw) => {
      try {
        const input = JSON.parse(String(raw))
        this.assertCurrent(live.job)
        live.touchedAt = this.now()
        if (input.type === 'close') {
          live.cancel?.()
          return ws.close()
        }
        if (input.type === 'continue') {
          await live.checkLogin?.()
          return
        }
        if (!live.waiting) return
        if (input.type === 'click')
          await live.page.mouse.click(Number(input.x), Number(input.y), { button: input.button || 'left' })
        else if (input.type === 'move') await live.page.mouse.move(Number(input.x), Number(input.y))
        else if (input.type === 'scroll')
          await live.page.mouse.wheel(Number(input.deltaX) || 0, Number(input.deltaY) || 0)
        else if (input.type === 'key') await live.page.keyboard.press(String(input.key))
        else if (input.type === 'text') await live.page.keyboard.insertText(String(input.text))
      } catch (error) {
        ws.send(JSON.stringify({ type: 'status', status: 'error', message: safeMessage(error) }))
      }
    })
    ws.on('close', () => {
      clearInterval(timer)
      live.clients.delete(ws)
    })
  }

  send(live, message) {
    for (const ws of live.clients) if (ws.readyState === 1) ws.send(JSON.stringify(message))
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
      this.jobs.delete(job.vmId)
    }
    this.queue.length = 0
    this.tickets.clear()
    for (const live of this.sessions.values()) {
      live.cancel?.()
      await this.persistSession(live)
      await live.browser.close().catch(() => {})
      for (const ws of live.clients) ws.close()
    }
    await this.draining
  }
}

function safeMessage(error) {
  return String(error?.message || 'API 配置失败')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[key]')
    .slice(0, 300)
}
