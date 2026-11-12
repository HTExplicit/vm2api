import crypto from 'node:crypto'
import { SlotBrowserManager } from '../browser/slot-browser-manager.mjs'
import { SlotBrowserRepo } from '../db/repos/slot-browser-repo.mjs'
import { withTransaction } from '../db/database.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { hasBoundExit } from '../vm/egress.mjs'
import { createPlatformBrowserSession } from './platform-browser.mjs'
import { PlatformAdapter, navigatePlatformForObservation } from './platform-adapter.mjs'
import { fetchBillingBalance } from './billing-client.mjs'
import { balanceRefreshIntervalMinutes } from './config.mjs'
import { accountApiKeyState, QUOTA_BLOCK } from './key-state.mjs'

const IDLE_TIMEOUT = 15 * 60_000

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

async function waitForJob(promise, signal) {
  signal.throwIfAborted()
  let abort
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([promise, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
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
    fetchBalance = fetchBillingBalance,
    getRouting = () => cfg?.routing || {},
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
      fetchBalance,
      getRouting,
      now,
    })
    this.queue = []
    this.jobs = new Map()
    this.sessions = new Map()
    this.balanceFailedAt = new Map()
    this.balanceTail = Promise.resolve()
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
    this.profileRepo = this.browserManager.profileRepo
  }

  view(vm) {
    const view = this.credits.view(vm)
    if (!view) return null
    let context
    try {
      context = this.credits.accountForVm(vm.id)
    } catch {}
    const record = context?.record
    const key = this.repo.getKey(record?.key_id)
    const endpoint = key ? this.apiEndpointStore.getRaw(key.endpoint_id) : null
    const state = accountApiKeyState({ vm, accountId: context?.accountId, record, key, endpoint, now: this.now() })
    const refresh = this.balanceRefreshView(vm.id, context?.accountId, record, view)
    return {
      ...view,
      vm_id: vm.id,
      account_id: context?.accountId || null,
      email: context?.account?.email || '',
      key_id: view.has_key ? key?.id : null,
      endpoint_id: view.has_key ? key?.endpoint_id : null,
      project_id: record?.organization_id ? this.repo.getOrg(record.organization_id)?.project_id || null : null,
      call_status: state.status,
      call_reason: state.reason,
      call_error: record?.call_error || null,
      cooldown_until: key?.cooldown_until || null,
      browser_active: !!this.browserManager.state(vm.id).active,
      balance_refresh_interval_minutes: balanceRefreshIntervalMinutes(this.getRouting()),
      balance_refresh_status: refresh.status,
      balance_refresh_message: refresh.message,
      quota_blocked: key?.cooldown_until === QUOTA_BLOCK,
    }
  }

  balanceRefreshView(vmId, accountId, record, view) {
    const job = this.jobs.get(vmId)
    if (job && job.accountId === accountId && !job.abort.signal.aborted)
      return { status: job.phase || 'queued', message: job.phaseMessage || '余额刷新已排队' }
    const error = view.balance_error || (record?.setup_status === 'error' ? record.last_error : null)
    if (record?.setup_status === 'needs_login')
      return { status: 'needs_login', message: record.last_error || 'Platform 会话需要补充登录，请连接 Platform' }
    if (error) return { status: 'error', message: error }
    const profile = this.profileRepo.get(vmId)
    const session = profile?.billing_session
    if (
      profile?.account_id === accountId &&
      session?.organization_id === record?.organization_id &&
      session?.recovery_attempted &&
      !session.headers
    )
      return { status: 'error', message: 'Billing 会话恢复尚未完成，请手动刷新或连接 Platform' }
    return { status: 'idle', message: null }
  }

  assertAccountIdentity(vmId, expectedAccountId) {
    const context = this.credits.accountForVm(vmId)
    if (expectedAccountId != null && expectedAccountId !== context.accountId)
      throw problem('api_account_changed', '槽位账号已更换，请刷新后重试', 409)
    return context
  }

  resume(vmId, { account_id } = {}) {
    const { vm, accountId, record } = this.assertAccountIdentity(vmId, account_id)
    const key = this.repo.getKey(record?.key_id)
    if (!key || key.source_vm_id !== vmId || key.source_account_id !== accountId)
      throw problem('api_key_required', '账号尚未配置对应的 API key', 409)
    if (key.cooldown_until === QUOTA_BLOCK) {
      this.apiEndpointStore.setKeyCooldown(key.id, null)
      if (['credit_balance_exhausted', 'insufficient_quota'].includes(record.call_error?.code))
        this.repo.upsertAccount(accountId, { call_error: null })
      this.reload()
    }
    return this.view(vm)
  }

  resolveAccountKey(key) {
    try {
      const { vm, account, accountId, record } = this.credits.accountForVm(key.source_vm_id)
      const storedKey = this.repo.getKey(record?.key_id)
      if (!storedKey || storedKey.id !== key.id) return null
      const endpoint = this.apiEndpointStore.getRaw(storedKey.endpoint_id)
      const state = accountApiKeyState({ vm, accountId, record, key: storedKey, endpoint, now: this.now() })
      if (state.status === 'binding_error' || state.status === 'proxy_missing') return null
      const proxyUrl = hostProxyUrlForVm(vm)
      return {
        accountId,
        enabled: state.status === 'ready',
        proxyUrl,
        email: account.email || '',
        call_status: state.status,
        key: storedKey,
      }
    } catch {
      return null
    }
  }

  setEnabled(vmId, enabled, { account_id } = {}) {
    const { vm, accountId } = this.boundKey(vmId, account_id)
    this.repo.upsertAccount(accountId, { enabled: !!enabled })
    this.reload()
    return this.view(vm)
  }

  recordKeyError(key, error) {
    let context
    try {
      context = this.credits.accountForVm(key.source_vm_id)
    } catch {
      return
    }
    if (context.accountId !== key.source_account_id || context.record?.key_id !== key.id) return
    if (this.repo.getKey(key.id)?.api_key !== key.api_key) return
    this.repo.upsertAccount(context.accountId, {
      call_error: {
        code: error.code || 'api_error',
        message: safeMessage(error),
        at: new Date(this.now()).toISOString(),
      },
    })
  }

  boundKey(vmId, accountId) {
    const context = this.assertAccountIdentity(vmId, accountId)
    const key = this.repo.getKey(context.record?.key_id)
    if (!key || key.source_vm_id !== vmId || key.source_account_id !== context.accountId)
      throw problem('api_key_required', '账号尚未配置对应的 API key', 409)
    return { ...context, key }
  }

  revealKey(vmId, { account_id } = {}) {
    const { key } = this.boundKey(vmId, account_id)
    return { api_key: key.api_key }
  }

  bindKey(vmId, { account_id, api_key } = {}) {
    const context = this.assertAccountIdentity(vmId, account_id)
    if (!['claimed', 'pending'].includes(context.record?.claim_status))
      throw problem('api_promo_link_required', '请先查询并领取 API 赠额')
    if (this.jobs.has(vmId)) throw problem('api_task_busy', '账号正在执行 API 配置或余额任务，请完成后重试', 409)
    const secret = String(api_key || '').trim()
    if (secret.length < 4) throw problem('invalid_api_key', '请输入完整的官方 API key')
    const organizationId = context.record.organization_id
    if (!organizationId) throw problem('api_org_required', '账号尚未关联接收赠额的 API 组织', 409)
    this.saveBoundKey(context, { apiKey: secret, organizationId }, { replace: true })
    this.reload()
    return this.view(context.vm)
  }

  async removeKey(vmId, { account_id } = {}) {
    const context = this.assertAccountIdentity(vmId, account_id)
    if (this.jobs.has(vmId)) await this.cancel(vmId)
    const current = this.assertAccountIdentity(vmId, context.accountId)
    const key = this.repo.getKey(current.record?.key_id)
    if (key && (key.source_vm_id !== vmId || key.source_account_id !== context.accountId))
      throw problem('api_key_account_mismatch', '已保存的 API key 与当前账号不匹配', 409)
    this.repo.detachKey(context.accountId, current.record?.key_id)
    this.reload()
    return this.view(current.vm)
  }

  saveBoundKey(context, created, { replace = false, assertCurrent = () => {} } = {}) {
    return withTransaction(this.repo.db, () => {
      assertCurrent()
      const currentContext = this.assertAccountIdentity(context.vm.id, context.accountId)
      const current = currentContext.record
      if (current?.organization_id && current.organization_id !== created.organizationId)
        throw problem('platform_key_save_conflict', '账号的 API 组织已改变，请核对当前配置', 409)
      const sourceKeys = this.repo.db
        .prepare('SELECT id FROM api_endpoint_keys WHERE source_vm_id = ? AND source_account_id = ?')
        .all(context.vm.id, context.accountId)
        .map((row) => this.repo.getKey(row.id))
      const referenced = this.repo.getKey(current?.key_id)
      if (
        sourceKeys.length > 1 ||
        (referenced &&
          (referenced.source_vm_id !== context.vm.id || referenced.source_account_id !== context.accountId))
      )
        throw problem('platform_key_save_conflict', '账号 API key 关联不一致，请核对当前配置', 409)
      let key = referenced || sourceKeys[0]
      const existing = !!key
      const changed = existing && key.api_key !== created.apiKey
      if (changed && !replace)
        throw problem('platform_key_save_conflict', '账号已保存其他 API key，请核对当前配置，不会覆盖已有密钥', 409)
      if (!key) {
        const endpoint = this.apiEndpointStore.create({ kind: 'openai', name: `OpenAI API · ${context.account.email}` })
        key = this.apiEndpointStore.addKey(endpoint.id, {
          api_key: created.apiKey,
          source_vm_id: context.vm.id,
          source_account_id: context.accountId,
        })
      } else if (changed) {
        this.apiEndpointStore.updateKey(key.id, { api_key: created.apiKey, disabled: false, cooldown_until: null })
      }
      if (created.organizationName || created.projectId)
        this.repo.upsertOrg(created.organizationId, {
          ...(created.organizationName ? { display_name: created.organizationName } : {}),
          ...(created.projectId ? { project_id: created.projectId } : {}),
        })
      this.repo.upsertAccount(context.accountId, {
        vm_id: context.vm.id,
        organization_id: created.organizationId,
        key_id: key.id,
        enabled: current?.key_id === key.id ? !!current.enabled : true,
        ...(!existing || changed ? { setup_status: 'ready', last_error: null, call_error: null } : {}),
      })
      return this.repo.getKey(key.id)
    })
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
      if (interactive && (!existing.interactive || (kind === 'setup' && existing.kind === 'balance'))) {
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
      phase: 'queued',
      phaseMessage: kind === 'setup' ? 'API 配置任务已排队' : '余额刷新已排队',
      ready: new Promise((resolve) => {
        ready = resolve
      }),
      resolveReady: (value) => ready(value),
    }
    if (kind === 'setup' || interactive)
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
      this.balanceFailedAt.delete(job.accountId)
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
        this.balanceFailedAt.set(job.accountId, this.now())
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
      let terminal
      try {
        if (live?.job === job) {
          await this.persistSession(live)
          const status = this.repo.getAccount(job.accountId)?.setup_status || 'error'
          terminal = {
            status: status === 'ready' ? 'api_ready' : status,
            message: this.repo.getAccount(job.accountId)?.last_error,
          }
          live.adapter?.dispose?.()
          live.inputLocked = false
          live.cancel = null
          live.checkLogin = null
          await this.browserManager.release(live)
        }
      } catch (error) {
        terminal = null
        // Business work is finished; the shared browser manager retains failed
        // cleanup ownership and exposes its retryable close_failed state.
        console.warn('[openai-api] browser release failed', error.code || 'browser_cleanup_failed')
      } finally {
        if (live?.job === job && this.sessions.get(job.vmId) === live) this.sessions.delete(job.vmId)
        job.resolveReady(null)
        if (this.jobs.get(job.vmId) === job) this.jobs.delete(job.vmId)
        job.resolveFinished()
        this.running = this.jobs.size > 0
      }
      // A retry offered by this status must find the finished job removed.
      if (terminal) this.browserManager.setStatus(live, terminal.status, terminal.message)
    }
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
    if (job.kind === 'balance') return this.runBalance(job)
    return this.runBrowser(job)
  }

  async runBalance(job) {
    const ownBrowser = this.browserManager.jobs.get(job.vmId)
    if (job.interactive && ownBrowser?.retained && ownBrowser.purpose === 'platform') return this.runBrowser(job)
    // HTTP jobs share one queue without reserving or launching a browser.
    const previous = this.balanceTail
    let release
    const finished = new Promise((resolve) => {
      release = resolve
    })
    this.balanceTail = previous.then(() => finished)
    try {
      job.phase = 'queued'
      job.phaseMessage = '等待前序余额刷新任务完成'
      await waitForJob(previous, job.abort.signal)
      while (true) {
        const manual = [...this.browserManager.jobs.values()].find((live) => live.retained)
        if (!manual) break
        job.phaseMessage = '等待正在操作的账号浏览器关闭'
        await waitForJob(manual.closed, job.abort.signal)
      }
      if (!job.interactive && !balanceRefreshIntervalMinutes(this.getRouting())) return
      const context = this.assertCurrent(job)
      job.proxyUrl = hostProxyUrlForVm(context.vm)
      const record = context.record
      const key = this.repo.getKey(record?.key_id)
      if (!key || key.source_vm_id !== job.vmId || key.source_account_id !== job.accountId)
        throw problem('api_key_account_mismatch', '已保存的 API key 与当前账号不匹配', 409)
      const profile = this.profileRepo.get(job.vmId)
      if (profile?.account_id && profile.account_id !== job.accountId)
        throw problem('platform_account_mismatch', '保存的 Platform 会话与当前账号不一致', 409)
      const session = profile?.billing_session
      const matching = session?.organization_id === record.organization_id
      let authenticationError
      if (matching && session.headers) {
        try {
          job.phase = 'refreshing'
          job.phaseMessage = '正在通过 Billing 会话刷新余额'
          const { summary, cookies } = await this.fetchBalance({
            session,
            storageState: profile.storage_state,
            proxyUrl: job.proxyUrl,
            organizationId: record.organization_id,
            signal: job.abort.signal,
          })
          this.assertCurrent(job)
          if (this.browserManager.jobs.get(job.vmId)?.retained)
            throw problem('platform_browser_busy', '账号浏览器正在操作，请关闭后刷新余额', 409)
          const currentProfile = this.profileRepo.get(job.vmId)
          this.profileRepo.upsert(job.vmId, {
            storage_state: { ...currentProfile.storage_state, cookies, cookies_pending: true },
          })
          this.saveBalance(job, record.organization_id, summary)
          this.repo.upsertAccount(job.accountId, { setup_status: 'ready', last_error: null })
          return
        } catch (error) {
          if (error.code !== 'platform_login_required') throw error
          authenticationError = error
        }
      }
      this.assertCurrent(job)
      if (!job.interactive && !balanceRefreshIntervalMinutes(this.getRouting())) {
        if (authenticationError) throw authenticationError
        return
      }
      if (!job.interactive && matching && session.recovery_attempted)
        throw problem('platform_recovery_required', 'Billing 会话自动恢复未完成，请连接 Platform 或手动重试', 409)
      this.profileRepo.upsert(job.vmId, {
        account_id: job.accountId,
        billing_session: {
          ...(matching ? session : {}),
          organization_id: record.organization_id,
          headers: null,
          recovery_attempted: true,
        },
      })
      return await this.runBrowser(job)
    } finally {
      release()
    }
  }

  async runBrowser(job) {
    const context = this.assertCurrent(job)
    job.proxyUrl = hostProxyUrlForVm(context.vm)
    job.phase = 'queued'
    job.phaseMessage = '等待账号浏览器就绪'
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
    job.phase = 'refreshing'
    job.phaseMessage = '正在连接 Platform 以更新余额'
    this.browserManager.setStatus(live, 'opening', '正在打开 OpenAI Platform')
    const adapter = new this.Adapter({
      page: browser.page,
      context: browser.context,
      email: context.account.email,
      organizationId: context.record?.organization_id,
    })
    live.adapter = adapter
    const browserSignal = AbortSignal.any([job.abort.signal, live.closeSignal])
    await navigatePlatformForObservation(browser.page, 'https://platform.openai.com/settings/organization/general', {
      timeout: 45_000,
      signal: browserSignal,
    })
    let identity = await adapter.inspect({ timeout: 30_000, signal: browserSignal })
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
    this.browserManager.setStatus(
      live,
      'configuring',
      job.kind === 'balance' ? '正在刷新 API 余额' : '正在配置账号 API，请保留此窗口…',
    )
    await this.persistSession(live)
    let record = this.repo.getAccount(job.accountId)
    let organizationId = record.organization_id || identity.organizationId
    // A sole owned organization can be chosen for an external claim only after real Platform login.
    if (!organizationId && identity.organizations?.length === 1) organizationId = identity.organizations[0].id
    if (!organizationId) throw problem('api_org_required', '请在 Platform 中选择接收赠额的组织')
    const existingKey = record.key_id ? this.repo.getKey(record.key_id) : null
    if (existingKey && (existingKey.source_vm_id !== job.vmId || existingKey.source_account_id !== job.accountId))
      throw problem('api_key_account_mismatch', '已保存的 API key 与当前账号不匹配', 409)
    if (!existingKey && job.kind === 'balance') throw problem('api_key_required', '账号 API key 已移除', 409)
    if (!existingKey) {
      const keyName = (job.keyName ||=
        'vm2api-' +
        crypto.createHash('sha256').update(job.accountId).digest('hex').slice(0, 12) +
        '-' +
        crypto.randomBytes(4).toString('hex'))
      const saveKey = async (created) => {
        assertSetupCurrent()
        if (!created.apiKey || !created.projectId) throw problem('platform_key_missing', 'Platform 未返回完整项目 key')
        const selectedOrganizationId = created.organizationId || organizationId
        if (selectedOrganizationId !== organizationId)
          throw problem('platform_key_save_conflict', '新 key 的组织与当前配置不一致，请核对当前账号配置', 409)
        const organizationName =
          created.organizationName || identity.organizations?.find((x) => x.id === organizationId)?.name || 'OpenAI'
        this.saveBoundKey(
          context,
          {
            apiKey: created.apiKey,
            organizationId,
            organizationName,
            projectId: created.projectId,
          },
          { assertCurrent: assertSetupCurrent },
        )
        this.reload()
      }
      const previousCheckLogin = live.checkLogin
      const setupSignal = AbortSignal.any([job.abort.signal, live.closeSignal])
      const assertSetupCurrent = () => {
        setupSignal.throwIfAborted()
        return this.assertCurrent(job)
      }
      live.checkLogin = () => {
        assertSetupCurrent()
        return adapter.continueKeySetup?.()
      }
      try {
        const created = await adapter.configure({
          organizationId,
          keyName,
          onKey: saveKey,
          signal: setupSignal,
          assertCurrent: assertSetupCurrent,
          onState: (status, message) => {
            assertSetupCurrent()
            const waiting = status === 'awaiting_key_input' || status === 'key_save_failed'
            live.waiting = waiting
            live.inputLocked = !waiting
            this.browserManager.setStatus(live, status, message)
          },
        })
        if (!this.repo.getAccount(job.accountId).key_id && created?.apiKey) await saveKey(created)
      } finally {
        live.checkLogin = previousCheckLogin
        live.waiting = false
        live.inputLocked = true
      }
    }
    record = this.repo.getAccount(job.accountId)
    if (!record.key_id) throw problem('platform_key_missing', '项目 key 尚未完成保存')
    if (job.kind === 'setup' && this.repo.getKey(record.key_id)?.disabled)
      throw problem('invalid_api_key', '已保存的项目 API key 已失效，请在 Platform 核对密钥')
    try {
      await this.updateBalance(live, organizationId)
    } catch (error) {
      this.assertCurrent(job)
      if (job.kind === 'balance' || error.code === 'platform_login_required') throw error
      this.repo.upsertOrg(organizationId, { balance_error: safeMessage(error) })
    }
    this.assertCurrent(job)
    this.repo.upsertAccount(job.accountId, { setup_status: 'ready', last_error: null })
    this.reload()
    this.browserManager.setStatus(live, 'api_ready', 'API 配置已完成')
  }

  async updateBalance(live, organizationId) {
    this.assertCurrent(live.job)
    live.job.phase = 'refreshing'
    live.job.phaseMessage = '正在读取当前组织的官方 Billing 余额'
    const signal = AbortSignal.any([live.job.abort.signal, live.closeSignal])
    const result = await live.adapter.readBalance({ organizationId, signal })
    const billingSession = live.adapter.billingSessionFor(organizationId)
    if (!billingSession)
      throw problem('platform_billing_session_missing', '官方 Billing 尚未返回可复用会话，请重试连接 Platform', 409)
    const storage = await live.browser.storageState()
    this.assertCurrent(live.job)
    this.profileRepo.upsert(live.vmId, {
      account_id: live.job.accountId,
      billing_session: billingSession,
      storage_state: storage,
    })
    this.saveBalance(live.job, organizationId, result)
  }

  saveBalance(job, organizationId, result) {
    this.assertCurrent(job)
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
  }

  async persistSession(live) {
    if (live.persistable === false) return
    try {
      await this.browserManager.persist(live)
    } catch {}
  }

  async waitForLogin(live) {
    live.waiting = true
    live.job.phase = 'needs_login'
    live.job.phaseMessage = '请在账号浏览器中完成 Platform 登录'
    return new Promise((resolve, reject) => {
      let inspecting = false
      const finish = (value, error) => {
        clearInterval(timer)
        live.closeSignal.removeEventListener('abort', live.cancel)
        live.waiting = false
        live.checkLogin = null
        live.cancel = null
        if (!error) {
          live.job.phase = 'refreshing'
          live.job.phaseMessage = '正在核对 Platform 登录及组织'
        }
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
    if (!this.jobs.has(vmId) || this.jobs.get(vmId).kind === 'balance') this.setup(vmId)
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
      const interval = balanceRefreshIntervalMinutes(this.getRouting()) * 60_000
      const dueOrgs = new Set()
      const accounts = this.repo
        .listAccounts()
        .sort((a, b) => Number(a.setup_status === 'needs_login') - Number(b.setup_status === 'needs_login'))
      for (const account of accounts) {
        let context
        try {
          context = this.credits.accountForVm(account.vm_id)
        } catch {
          continue
        }
        if (context.accountId !== account.account_id) continue
        if (account.claim_status === 'pending' && account.operation_id)
          await this.credits.refreshClaim(account.vm_id).catch(() => {})
        if (!interval) continue
        if (!account.enabled || !account.key_id || !account.organization_id || dueOrgs.has(account.organization_id))
          continue
        const profile = this.profileRepo.get(account.vm_id)
        const session = profile?.billing_session
        if (
          profile?.account_id === account.account_id &&
          session?.organization_id === account.organization_id &&
          session.recovery_attempted &&
          !session.headers
        )
          continue
        const org = this.repo.getOrg(account.organization_id)
        if (this.now() - Date.parse(org?.balance_checked_at || org?.updated_at || 0) < interval) continue
        if (this.now() - (this.balanceFailedAt.get(account.account_id) ?? -Infinity) < interval) continue
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
