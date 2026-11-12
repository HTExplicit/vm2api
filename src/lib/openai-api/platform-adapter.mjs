const PLATFORM_ORIGIN = 'https://platform.openai.com'
const KEYS_URL = `${PLATFORM_ORIGIN}/api-keys`
const BILLING_URL = `${PLATFORM_ORIGIN}/settings/organization/billing/overview`
export const BILLING_CREDIT_GRANTS_URL = 'https://api.openai.com/v1/dashboard/billing/credit_grants'
const BILLING_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'openai-organization',
  'origin',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'user-agent',
])
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ORGANIZATION_ID = /^org[-_][a-z\d_-]+$/i
const PROJECT_ID = /^proj[-_][a-z\d_-]+$/i
const SECRET_KEY = /^sk-[a-z\d_-]{16,}$/i
const EXPIRATION_LABEL = /^(?:expiration|expiry|有效期(?:限)?|到期时间|过期时间|有効期限)\s*[:：]?/i
const NEVER = /^(?:never|no expiration|永不过期|永不|无期限|無期限|期限なし|なし)$/i
const KEY_INPUT_MESSAGE = '请手动选择期限并创建密钥，创建后会自动保存；不要关闭完整密钥弹窗。'

function problem(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status })
}

function expectedPlatformNavigation(value, target) {
  const url = new URL(value)
  return (
    (url.origin === target.origin && url.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '')) ||
    ['https://auth.openai.com', 'https://auth0.openai.com'].includes(url.origin) ||
    (url.origin === PLATFORM_ORIGIN && /^\/(?:auth|login)(?:\/|$)/.test(url.pathname))
  )
}

/** A Chromium navigation abort is provisional only when this window actually continues. */
export async function navigatePlatformForObservation(page, url, { timeout = 30_000, signal, observed } = {}) {
  signal?.throwIfAborted()
  if (page.isClosed?.()) throw problem('platform_browser_closed', '账号浏览器已关闭')
  const initialUrl = page.url()
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    let finished = false
    let abortedNavigation = false
    let continued = false
    let observationComplete = false
    const finish = (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      page.off('framenavigated', navigated)
      page.off('close', closed)
      signal?.removeEventListener('abort', aborted)
      error === undefined ? resolve() : reject(error)
    }
    const navigated = (frame) => {
      if (frame !== page.mainFrame()) return
      if (expectedPlatformNavigation(frame.url(), target)) continued = true
      if (abortedNavigation && !observed && continued) finish()
    }
    const closed = () => finish(problem('platform_browser_closed', '账号浏览器已关闭'))
    const aborted = () => finish(signal.reason)
    const timer = setTimeout(
      () => finish(problem('platform_navigation_timeout', '等待官方页面接续导航超时，请在账号浏览器核对页面。')),
      timeout,
    )
    page.on('framenavigated', navigated)
    page.on('close', closed)
    signal?.addEventListener('abort', aborted, { once: true })
    if (observed) {
      observed.then(
        () => {
          observationComplete = true
          if (abortedNavigation) finish()
        },
        (error) => finish(error),
      )
    }
    Promise.resolve()
      .then(() => {
        if (!finished) return page.goto(url, { waitUntil: 'domcontentloaded', timeout })
      })
      .then(
        () => finish(),
        (error) => {
          if (finished) return
          if (!/net::ERR_ABORTED/.test(error?.message || '')) return finish(error)
          abortedNavigation = true
          if (
            observed
              ? observationComplete
              : continued || (page.url() !== initialUrl && expectedPlatformNavigation(page.url(), target))
          )
            finish()
        },
      )
  })
}

async function withinBillingRead(page, signal, read) {
  signal?.throwIfAborted()
  if (page.isClosed?.()) throw problem('platform_browser_closed', '账号浏览器已关闭')
  const controller = new AbortController()
  const deadline = Date.now() + 30_000
  const abort = () => controller.abort(signal.reason)
  const closed = () => controller.abort(problem('platform_browser_closed', '账号浏览器已关闭'))
  const timer = setTimeout(
    () =>
      controller.abort(
        problem('platform_balance_unavailable', '等待当前组织的官方 Billing 余额超时，请在登录窗口核对页面。'),
      ),
    30_000,
  )
  page.on('close', closed)
  signal?.addEventListener('abort', abort, { once: true })
  let cancelled
  const cancellation = new Promise((resolve, reject) => {
    cancelled = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', cancelled, { once: true })
  })
  try {
    return await Promise.race([
      read({ signal: controller.signal, remaining: () => Math.max(1, deadline - Date.now()) }),
      cancellation,
    ])
  } finally {
    clearTimeout(timer)
    page.off('close', closed)
    signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', cancelled)
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function items(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : []
}

function entity(value, pattern) {
  if (!value || typeof value !== 'object' || !pattern.test(text(value.id))) return null
  return { id: value.id, name: text(value.title || value.name || value.display_name) || value.id }
}

function projectEntity(value) {
  const project = entity(value, PROJECT_ID)
  if (!project) return null
  if (value.is_default === true) project.is_default = true
  if (value.is_initial === true) project.is_initial = true
  return project
}

/** Keep identity metadata only; session tokens and response bodies are never retained. */
export function platformIdentityObservation(url, payload, organizationHeader = '') {
  const path = new URL(url).pathname
  const self = /\/(?:me|user|profile|onboarding|session)(?:\/|$)/i.test(path)
  const candidates = self ? [payload?.user, payload?.profile, payload?.data?.user, payload?.data, payload] : []
  const email = candidates.map((value) => text(value?.email)).find((value) => EMAIL.test(value)) || null
  const organizations = []
  const projects = []
  const projectOrganizationIds = new Set()
  const add = (list, row) => {
    if (row && !list.some((value) => value.id === row.id)) list.push(row)
  }
  if (self || /\/(?:organizations|orgs)(?:\/|$)/i.test(path)) {
    for (const value of [
      payload?.user?.orgs,
      payload?.user?.organizations,
      payload?.organizations,
      payload?.orgs,
      payload?.data?.organizations,
      payload?.data?.orgs,
    ]) {
      for (const row of items(value)) {
        const organization = entity(row, ORGANIZATION_ID)
        add(organizations, organization)
        if (!organization || ![row.projects, row.projects?.data].some(Array.isArray)) continue
        projectOrganizationIds.add(organization.id)
        for (const value of items(row.projects)) {
          const project = projectEntity(value)
          if (project) add(projects, { ...project, organizationId: organization.id })
        }
      }
    }
    if (/\/(?:organizations|orgs)(?:\/|$)/i.test(path)) {
      for (const row of items(payload)) add(organizations, entity(row, ORGANIZATION_ID))
      add(organizations, entity(payload, ORGANIZATION_ID))
    }
  }
  if (/\/projects\/?$/i.test(path)) {
    for (const row of items(payload?.projects || payload)) add(projects, projectEntity(row))
    add(projects, projectEntity(payload?.project || payload))
  }
  const pathOrganization = path.match(/\/organizations\/(org[-_][a-z\d_-]+)(?:\/|$)/i)?.[1]
  const currentOrganization =
    text(organizationHeader) || text(payload?.organization_id || payload?.org_id) || text(pathOrganization)
  const organizationId = ORGANIZATION_ID.test(currentOrganization) ? currentOrganization : null
  if (
    organizationId &&
    /\/projects\/?$/i.test(path) &&
    [payload, payload?.data, payload?.projects, payload?.projects?.data].some(Array.isArray)
  )
    projectOrganizationIds.add(organizationId)
  return {
    email,
    organizations,
    projects: projects.map((project) => ({ ...project, organizationId: project.organizationId || organizationId })),
    projectOrganizationIds: [...projectOrganizationIds],
    organizationId,
  }
}

const MONEY_FIELDS = new Set(['total_available', 'total_paid_available', 'grant_amount', 'used_amount'])

function decimal(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i)
  if (!match) return null
  const fraction = match[3] || ''
  const scale = fraction.length - Number(match[4] || 0)
  let units = BigInt(match[2] + fraction) * (match[1] ? -1n : 1n)
  if (scale < 0) units *= 10n ** BigInt(-scale)
  return { units, scale: Math.max(0, scale) }
}

function decimalText({ units, scale }) {
  const negative = units < 0n
  let digits = (negative ? -units : units).toString().padStart(scale + 1, '0')
  if (scale) digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '')
  return `${negative && units !== 0n ? '-' : ''}${digits}`
}

function combineDecimals(a, b, subtract = false) {
  const scale = Math.max(a.scale, b.scale)
  return {
    units: a.units * 10n ** BigInt(scale - a.scale) + b.units * 10n ** BigInt(scale - b.scale) * (subtract ? -1n : 1n),
    scale,
  }
}

function grantTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** Read monetary JSON tokens before JavaScript can round them to binary floats. */
export function parsePlatformCreditSummary(raw, now = Date.now()) {
  const payload = JSON.parse(raw, (key, value, context) =>
    MONEY_FIELDS.has(key) && typeof value === 'number' ? context.source : value,
  )
  const balance = decimal(payload?.total_available)
  const paid = decimal(payload?.total_paid_available)
  const grants = []
  for (const row of items(payload?.grants)) {
    const granted = decimal(row.grant_amount)
    const used = decimal(row.used_amount)
    const effectiveAt = grantTime(row.effective_at)
    const expiresAt = row.expires_at === null ? null : grantTime(row.expires_at)
    if (
      !granted ||
      !used ||
      granted.units < 0n ||
      used.units < 0n ||
      !effectiveAt ||
      (row.expires_at !== null && !expiresAt) ||
      row.is_scheduled ||
      row.is_held_for_prepaid_transition ||
      Date.parse(effectiveAt) > now ||
      (expiresAt && Date.parse(expiresAt) <= now)
    )
      continue
    const remaining = combineDecimals(granted, used, true)
    if (remaining.units <= 0n) continue
    grants.push({
      id: text(row.id),
      name: text(row.name || row.title) || 'API credit',
      granted: decimalText(granted),
      remaining: decimalText(remaining),
      effective_at: effectiveAt,
      expires_at: expiresAt,
    })
  }
  const nextExpiry =
    grants
      .map((grant) => grant.expires_at)
      .filter(Boolean)
      .sort()[0] || null
  const expiring = nextExpiry
    ? grants
        .filter((grant) => grant.expires_at === nextExpiry)
        .reduce((total, grant) => combineDecimals(total, decimal(grant.remaining)), { units: 0n, scale: 0 })
    : null
  return {
    balance: balance ? decimalText(balance) : null,
    paid_balance: paid ? decimalText(paid) : null,
    grants,
    next_expiring_amount: expiring ? decimalText(expiring) : null,
    next_expiring_at: nextExpiry,
  }
}

/** Accept only an unmasked secret returned by the key-creation request. */
export function createdPlatformKey(url, method, payload) {
  if (method !== 'POST' || !/(?:api[-_]?keys|\/keys)(?:\/|$)/i.test(new URL(url).pathname)) return null
  const rows = [payload?.api_key, payload?.key, payload?.data?.api_key, payload?.data, payload]
  for (const row of rows) {
    if (typeof row === 'string' && SECRET_KEY.test(row)) return { apiKey: row, remoteKeyId: null }
    if (!row || typeof row !== 'object') continue
    const secret = [row.secret, row.secret_key, row.api_key, row.key, row.value, row.sensitive_id].find(
      (value) => typeof value === 'string' && SECRET_KEY.test(value),
    )
    if (secret) return { apiKey: secret, remoteKeyId: text(row.id) || null }
  }
  return null
}

function escaped(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function visibleOne(locator) {
  const count = await locator.count()
  const visible = []
  for (let i = 0; i < count; i++) {
    const item = locator.nth(i)
    if (await item.isVisible()) visible.push(item)
  }
  return visible.length === 1 ? visible[0] : null
}

async function button(scope, name, message, timeout = 15_000) {
  const locator = scope.getByRole('button', { name }).filter({ visible: true })
  try {
    await locator.first().waitFor({ state: 'visible', timeout })
  } catch {
    throw problem('platform_page_changed', message)
  }
  const found = await visibleOne(locator)
  if (!found) throw problem('platform_page_changed', '官方页面的操作入口不唯一，请核对后重试配置')
  return found
}

export class PlatformAdapter {
  constructor({ page, context, email, organizationId = '', onKey = null, now = Date.now }) {
    this.page = page
    this.context = context
    this.email = text(email).toLowerCase()
    this.organizationId = organizationId
    this.onKey = onKey
    this.now = now
    this.identity = { email: null, organizations: [], projects: [], organizationId: null }
    this.projectLists = new Set()
    this.creditSummaries = new Map()
    this.billingSessions = new Map()
    this.creditSequences = new Map()
    this.creditSequence = 0
    this.creditRequests = new WeakMap()
    this.createdKey = null
    this.keySave = null
    this.keyCallback = null
    this.keySetup = null
    this.pending = new Set()
    this.responseHandler = (response) => {
      const pending = this.observe(response).catch(() => {})
      this.pending.add(pending)
      pending.finally(() => this.pending.delete(pending))
    }
    page.on('response', this.responseHandler)
    this.requestHandler = (request) => {
      try {
        if (request.url().split('?')[0] === BILLING_CREDIT_GRANTS_URL && request.method() === 'GET')
          this.creditRequests.set(request, ++this.creditSequence)
        this.observeKeyRequest(request)
      } catch (error) {
        this.keySetup?.reject(error)
      }
    }
    page.on('request', this.requestHandler)
  }

  dispose() {
    if (this.keySetup) {
      this.keySetup.reject(problem('platform_browser_closed', '账号浏览器已关闭'))
      this.endKeySetup(this.keySetup)
    }
    this.page.off('response', this.responseHandler)
    this.page.off('request', this.requestHandler)
    this.billingSessions.clear()
  }

  billingSessionFor(organizationId) {
    if (!this.email || this.identity.email !== this.email) return null
    const session = this.billingSessions.get(organizationId)
    return session ? structuredClone(session) : null
  }

  async observe(response) {
    const url = new URL(response.url())
    if (!['platform.openai.com', 'api.openai.com'].includes(url.hostname) || !response.ok()) return
    if (!(response.headers()['content-type'] || '').includes('json')) return
    const request = response.request()
    const headers = request.headers()
    const keySetup = this.keySetup
    const matchingKey = !!keySetup && keySetup.request === request
    if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/dashboard/billing/credit_grants') {
      const organizationId = headers['openai-organization']
      if (request.method() !== 'GET' || !ORGANIZATION_ID.test(text(organizationId))) return
      const sequence = this.creditRequests.get(request)
      // A response to a request started before this adapter attached is not a new sample.
      if (!sequence) return
      const summary = parsePlatformCreditSummary(await response.text(), this.now())
      const allHeaders = request.allHeaders ? await request.allHeaders() : headers
      if (sequence > (this.creditSequences.get(organizationId) || 0)) {
        this.creditSummaries.set(organizationId, summary)
        this.creditSequences.set(organizationId, sequence)
        if (summary.balance != null && allHeaders.authorization && allHeaders['user-agent']) {
          this.billingSessions.set(organizationId, {
            organization_id: organizationId,
            headers: Object.fromEntries(Object.entries(allHeaders).filter(([name]) => BILLING_HEADERS.has(name))),
            captured_at: new Date(this.now()).toISOString(),
            recovery_attempted: false,
          })
        }
      }
      return
    }
    let payload
    try {
      payload = await response.json()
    } catch (error) {
      if (!matchingKey) throw error
    }
    if (matchingKey && keySetup && this.keySetup === keySetup) keySetup.responseConfirmed = true
    const observed = platformIdentityObservation(url.href, payload, headers['openai-organization'])
    if (observed.email) this.identity.email = observed.email.toLowerCase()
    if (observed.organizationId) this.identity.organizationId = observed.organizationId
    for (const organizationId of observed.projectOrganizationIds) this.projectLists.add(organizationId)
    for (const name of ['organizations', 'projects']) {
      for (const value of observed[name]) {
        const prior = this.identity[name].find((row) => row.id === value.id)
        if (prior) Object.assign(prior, value)
        else this.identity[name].push(value)
      }
    }
    const created = createdPlatformKey(url.href, request.method(), payload)
    if (created && matchingKey && !this.createdKey && keySetup && this.keySetup === keySetup) {
      await this.saveCreatedKey(created, keySetup)
    }
  }

  assertKeySetup(setup) {
    setup.signal?.throwIfAborted()
    setup.assertCurrent?.()
    if (this.keySetup !== setup) throw problem('api_task_replaced', 'API 配置任务已结束')
    if (this.identity.email !== this.email)
      throw problem('platform_account_mismatch', '当前 Platform 登录邮箱与这个账号不一致，请退出后使用对应账号登录。')
    if (this.identity.organizationId !== setup.organizationId)
      throw problem('platform_organization_unconfirmed', '当前 Platform 组织已变化，请核对后重新配置。')
  }

  observeKeyRequest(request) {
    const setup = this.keySetup
    if (!setup || request.method() !== 'POST') return false
    const url = new URL(request.url())
    if (
      url.protocol !== 'https:' ||
      !['platform.openai.com', 'api.openai.com'].includes(url.hostname) ||
      !/(?:api[-_]?keys|\/keys)\/?$/i.test(url.pathname)
    )
      return false
    const pathScope = url.pathname.match(
      /^\/dashboard\/organizations\/(org[-_][a-z\d_-]+)\/projects\/(proj[-_][a-z\d_-]+)\/api_keys\/?$/i,
    )
    if (/^\/dashboard\/organizations(?:\/|$)/i.test(url.pathname) && !pathScope) {
      setup.domTainted = true
      setup.allowDom = false
      return false
    }
    if (setup.request) {
      if (setup.request !== request) {
        setup.domTainted = true
        setup.allowDom = false
      }
      return setup.request === request
    }
    let body
    try {
      body = request.postDataJSON()
    } catch {
      setup.domTainted = true
      return false
    }
    const headers = request.headers()
    const name = text(body?.name)
    const projects = [
      pathScope?.[2],
      body?.project_id,
      body?.project?.id,
      typeof body?.project === 'string' ? body.project : undefined,
      headers['openai-project'],
    ].filter((value) => value != null)
    const organizations = [
      pathScope?.[1],
      headers['openai-organization'],
      body?.organization_id,
      body?.organization?.id,
      typeof body?.organization === 'string' ? body.organization : undefined,
    ].filter((value) => value != null)
    if (
      name !== setup.keyName ||
      !projects.length ||
      !organizations.length ||
      projects.some((value) => value !== setup.projectId) ||
      organizations.some((value) => value !== setup.organizationId)
    ) {
      setup.domTainted = true
      return false
    }
    this.assertKeySetup(setup)
    setup.request = request
    setup.allowDom = !setup.domTainted
    return true
  }

  beginKeySetup(options) {
    const setup = { ...options, request: null, responseConfirmed: false, allowDom: false, saving: false }
    setup.result = new Promise((resolve, reject) => {
      setup.resolve = resolve
      setup.reject = reject
    })
    setup.result.catch(() => {})
    this.keySetup = setup
    this.createdKey = null
    this.keySave = null
    this.keyCallback = (created) =>
      options.onKey?.({
        ...created,
        organizationId: setup.organizationId,
        organizationName: setup.organizationName,
        projectId: setup.projectId,
      })
    setup.aborted = () => setup.reject(setup.signal.reason)
    setup.closed = () => setup.reject(problem('platform_browser_closed', '账号浏览器已关闭'))
    setup.signal?.addEventListener('abort', setup.aborted, { once: true })
    this.page.on('close', setup.closed)
    setup.poll = setInterval(() => {
      void this.checkKeySetup().catch(setup.reject)
    }, 300)
    return setup
  }

  setKeyState(setup, status, message) {
    this.assertKeySetup(setup)
    if (setup.status === status) return
    setup.status = status
    setup.onState?.(status, message)
  }

  saveCreatedKey(created, setup) {
    this.assertKeySetup(setup)
    if (setup.saving) return this.keySave
    this.createdKey ||= created
    setup.saving = true
    setup.saveFailed = false
    this.keySave = Promise.resolve()
      .then(async () => {
        this.assertKeySetup(setup)
        await this.keyCallback(this.createdKey)
        this.assertKeySetup(setup)
        setup.saved = true
        this.setKeyState(setup, 'configuring', '密钥已保存，正在继续配置账号 API…')
        setup.resolve({
          ...this.createdKey,
          organizationId: setup.organizationId,
          organizationName: setup.organizationName,
          projectId: setup.projectId,
        })
      })
      .catch((error) => {
        try {
          this.assertKeySetup(setup)
          setup.saveFailed = true
          this.setKeyState(setup, 'key_save_failed', '完整密钥尚未完成本地保存，请保留当前窗口并点击“重试保存”。')
          if (!setup.onState) setup.reject(error)
        } catch (invalid) {
          setup.reject(invalid)
        }
        throw error
      })
      .finally(() => {
        setup.saving = false
      })
    this.keySave.catch(() => {})
    return this.keySave
  }

  async checkKeySetup({ retrySave = false } = {}) {
    const setup = this.keySetup
    if (!setup || setup.saved) return
    this.assertKeySetup(setup)
    if (setup.checking) return setup.checking
    setup.checking = (async () => {
      if (this.createdKey) {
        if (retrySave && setup.saveFailed && !setup.saving) {
          await this.saveCreatedKey(this.createdKey, setup).catch(() => {})
        }
        return
      }
      if (!setup.responseConfirmed || !setup.allowDom) return
      const revealed = await this.page.getByRole('dialog').evaluateAll((dialogs) => {
        const secrets = []
        for (const dialog of dialogs) {
          if (!dialog.getClientRects().length || getComputedStyle(dialog).visibility === 'hidden') continue
          for (const element of dialog.querySelectorAll('input, textarea, code, pre')) {
            const value = String(element.value || element.textContent || '').trim()
            if (/^sk-[a-z\d_-]{16,}$/i.test(value)) secrets.push(value)
          }
        }
        return [...new Set(secrets)]
      })
      this.assertKeySetup(setup)
      if (revealed.length === 1 && !this.createdKey && setup.allowDom) {
        await this.saveCreatedKey({ apiKey: revealed[0], remoteKeyId: null }, setup).catch(() => {})
      }
    })().finally(() => {
      setup.checking = null
    })
    return setup.checking
  }

  continueKeySetup() {
    return this.checkKeySetup({ retrySave: true })
  }

  endKeySetup(setup) {
    clearInterval(setup.poll)
    clearTimeout(setup.timeout)
    setup.signal?.removeEventListener('abort', setup.aborted)
    this.page.off('close', setup.closed)
    if (this.keySetup === setup) {
      this.keySetup = null
      this.keyCallback = null
      this.createdKey = null
      this.keySave = null
    }
  }

  async settled() {
    await Promise.all([...this.pending])
  }

  async goto(url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await this.page.locator('body').waitFor({ state: 'visible', timeout: 15_000 })
    await this.settled()
  }

  isGeneralOrganizationPage() {
    const url = new URL(this.page.url())
    return url.origin === PLATFORM_ORIGIN && /^\/settings\/organization\/general\/?$/.test(url.pathname)
  }

  async readGeneralOrganization() {
    if (this.identity.email !== this.email || !this.isGeneralOrganizationPage()) return null
    const input = await visibleOne(this.page.getByRole('textbox', { name: /^Organization ID$/i }))
    if (!input || !(await input.evaluate((element) => element.tagName === 'INPUT' && element.readOnly === true)))
      return null
    const id = text(await input.inputValue())
    if (
      this.identity.email !== this.email ||
      !this.isGeneralOrganizationPage() ||
      !ORGANIZATION_ID.test(id) ||
      !this.identity.organizations.some((organization) => organization.id === id)
    )
      return null
    return id
  }

  async waitForGeneralOrganization(id, { signal, timeout = 10_000 } = {}) {
    signal?.throwIfAborted()
    if (!this.isGeneralOrganizationPage()) return false
    return new Promise((resolve, reject) => {
      let finished = false
      let poll
      const finish = (matched, error) => {
        if (finished) return
        finished = true
        clearTimeout(poll)
        clearTimeout(deadline)
        this.page.off('close', closed)
        signal?.removeEventListener('abort', aborted)
        error === undefined ? resolve(matched) : reject(error)
      }
      const closed = () => finish(false, problem('platform_browser_closed', '账号浏览器已关闭'))
      const aborted = () => finish(false, signal.reason)
      const check = async () => {
        try {
          const state = await this.inspect({ signal })
          if (finished) return
          if (!state.authenticated)
            throw problem('platform_login_required', '请先在账号专用浏览器中完成 OpenAI Platform 登录。')
          if (state.organizationId === id) return finish(true)
          if (!this.isGeneralOrganizationPage()) return finish(false)
          poll = setTimeout(check, 100)
        } catch (error) {
          finish(false, error)
        }
      }
      const deadline = setTimeout(() => finish(false), timeout)
      this.page.on('close', closed)
      signal?.addEventListener('abort', aborted, { once: true })
      void check()
    })
  }

  async inspect({ timeout = 0, signal } = {}) {
    signal?.throwIfAborted()
    if (timeout > 0) {
      return new Promise((resolve, reject) => {
        let finished = false
        let inspecting = false
        let changed = false
        const finish = (state, error) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          this.page.off('response', check)
          this.page.off('framenavigated', check)
          this.page.off('close', closed)
          signal?.removeEventListener('abort', aborted)
          error === undefined ? resolve(state) : reject(error)
        }
        const check = async () => {
          changed = true
          if (inspecting) return
          inspecting = true
          while (changed && !finished) {
            changed = false
            try {
              const state = await this.inspect({ signal })
              const url = new URL(this.page.url())
              const login =
                ['auth.openai.com', 'auth0.openai.com'].includes(url.hostname) ||
                (url.hostname === 'platform.openai.com' && /^\/(?:auth|login)(?:\/|$)/.test(url.pathname))
              if (state.authenticated || login) finish(state)
            } catch (error) {
              finish(null, error)
            }
          }
          inspecting = false
        }
        const closed = () => finish(null, problem('platform_browser_closed', '账号浏览器已关闭'))
        const aborted = () => finish(null, signal.reason)
        const timer = setTimeout(
          () =>
            finish(
              null,
              problem(
                'platform_identity_unavailable',
                '等待官方账号信息超时，请稍后重试余额刷新或在账号浏览器核对页面。',
              ),
            ),
          timeout,
        )
        this.page.on('response', check)
        this.page.on('framenavigated', check)
        this.page.on('close', closed)
        signal?.addEventListener('abort', aborted, { once: true })
        void check()
      })
    }
    await this.settled()
    signal?.throwIfAborted()
    const url = new URL(this.page.url())
    if (url.hostname !== 'platform.openai.com' || /^\/(?:auth|login)(?:\/|$)/.test(url.pathname)) {
      return { authenticated: false, email: null, organizations: [] }
    }
    // Profile pages expose an explicitly labelled email input. Never infer the
    // logged-in user from email addresses in a members or usage table.
    const emailInput = await visibleOne(this.page.getByRole('textbox', { name: /^email(?: address)?$/i }))
    if (emailInput && !this.identity.email) {
      const actual = text(await emailInput.inputValue()).toLowerCase()
      if (EMAIL.test(actual) && /\/(?:profile|account)(?:\/|$)/.test(url.pathname)) this.identity.email = actual
    }
    if (this.identity.email && this.identity.email !== this.email) {
      throw problem('platform_account_mismatch', '当前 Platform 登录邮箱与这个账号不一致，请退出后使用对应账号登录。')
    }
    const organizationId = await this.readGeneralOrganization()
    signal?.throwIfAborted()
    if (organizationId) this.identity.organizationId = organizationId
    return {
      authenticated: this.identity.email === this.email,
      email: this.identity.email,
      organizations: [...this.identity.organizations],
      organizationId: this.identity.organizationId,
    }
  }

  async requireLogin({ signal } = {}) {
    const state = await this.inspect({ signal })
    if (!state.authenticated) {
      throw problem('platform_login_required', '请先在账号专用浏览器中完成 OpenAI Platform 登录。')
    }
    return state
  }

  async selectOrganization(id, { signal } = {}) {
    await this.requireLogin({ signal })
    if (!ORGANIZATION_ID.test(text(id))) throw problem('platform_organization_required', '请选择接收额度的 API 组织。')
    if (this.identity.organizationId === id) return
    if (await this.waitForGeneralOrganization(id, { signal })) return
    signal?.throwIfAborted()
    const target = this.identity.organizations.find((row) => row.id === id)
    if (!target) throw problem('platform_organization_unavailable', '当前 Platform 登录未发现这个 API 组织。')
    const current = this.identity.organizations.find((row) => row.id === this.identity.organizationId)
    const names = current ? new RegExp(`organization|${escaped(current.name)}`, 'i') : /organization/i
    const switcher =
      (await visibleOne(this.page.getByRole('combobox', { name: /organization/i }))) ||
      (await visibleOne(this.page.getByRole('button', { name: names })))
    if (!switcher) throw problem('platform_organization_selection_required', '请在登录窗口选择目标 API 组织后继续。')
    await switcher.click()
    const option =
      (await visibleOne(this.page.getByRole('option', { name: target.name, exact: true }))) ||
      (await visibleOne(this.page.getByRole('menuitem', { name: target.name, exact: true })))
    if (!option) throw problem('platform_organization_selection_required', '请在登录窗口选择目标 API 组织后继续。')
    await option.click()
    // A subsequent first-party request must confirm the chosen organization.
    await this.goto(KEYS_URL)
    if (this.identity.organizationId !== id) {
      throw problem('platform_organization_unconfirmed', '尚未确认 Platform 已切换到目标 API 组织，请核对后继续。')
    }
  }

  async ensureProject() {
    await this.settled()
    if (!this.projectLists.has(this.identity.organizationId)) {
      throw problem('platform_projects_unavailable', '尚未取得当前组织的官方项目列表，请在登录窗口核对项目页面。')
    }
    const projects = this.identity.projects.filter((row) => row.organizationId === this.identity.organizationId)
    const marked = projects.filter((row) => row.is_default === true || row.is_initial === true)
    const defaults = marked.length ? marked : projects.filter((row) => /^default project$/i.test(row.name))
    if (!defaults.length) {
      throw problem(
        'platform_default_project_unavailable',
        '未找到当前组织的 Default project，请在登录窗口核对项目权限。',
      )
    }
    if (defaults.length > 1) {
      throw problem('platform_project_ambiguous', '当前组织的默认项目标识不唯一，请在登录窗口核对。')
    }
    return defaults[0]
  }

  async selectProject(dialog, project) {
    const label = await visibleOne(dialog.locator('label').filter({ hasText: /^project$/i }))
    const select = label && (await visibleOne(label.locator('..').locator('select, [role="button"]')))
    if (!select) throw problem('platform_project_selection_required', '请在官方创建 key 对话框中选择 Default project。')
    const native = await select.evaluate((element) => element.tagName === 'SELECT')
    if (native) {
      await select.selectOption({ label: project.name })
      return
    }
    if (text(await select.innerText()).toLowerCase() === project.name.toLowerCase()) return
    await select.click()
    const option = await visibleOne(this.page.getByRole('option', { name: project.name, exact: true }))
    if (!option)
      throw problem('platform_project_selection_required', '未找到 Default project 选项，请在登录窗口选择后继续。')
    await option.click()
  }

  async selectExpiration(dialog) {
    const unique = async (locator) => {
      const visible = locator.filter({ visible: true })
      const count = await visible.count()
      if (count > 1)
        throw problem('platform_expiration_required', '官方 key 期限控件不唯一，请手动选择期限并创建密钥。')
      return count === 1 ? visible.nth(0) : null
    }
    let expiration = dialog.getByLabel ? await unique(dialog.getByLabel(EXPIRATION_LABEL)) : null
    if (
      expiration &&
      !(await expiration.evaluate(
        (element) =>
          ['SELECT', 'BUTTON'].includes(element.tagName) ||
          ['combobox', 'button'].includes(element.getAttribute('role')),
      ))
    )
      expiration = null
    if (!expiration) {
      const label = await unique(dialog.locator('label').filter({ hasText: EXPIRATION_LABEL }))
      if (label)
        expiration = await unique(label.locator('..').locator('select, [role="combobox"], button, [role="button"]'))
    }
    if (!expiration) expiration = await unique(dialog.getByRole('combobox', { name: EXPIRATION_LABEL }))
    if (!expiration) expiration = await unique(dialog.getByRole('button', { name: EXPIRATION_LABEL }))
    if (!expiration)
      throw problem('platform_expiration_required', '未找到官方 key 到期时间选择框，请手动选择期限并创建密钥。')
    const native = await expiration.evaluate((element) => element.tagName === 'SELECT')
    const selected = async () =>
      text(
        native
          ? await expiration.evaluate((element) => element.selectedOptions[0]?.textContent || '')
          : await expiration.innerText(),
      )
        .replace(EXPIRATION_LABEL, '')
        .trim()
    if (NEVER.test(await selected())) return
    if (native) {
      const option = expiration.getByRole('option', { name: NEVER })
      if ((await option.count()) !== 1)
        throw problem('platform_expiration_required', '官方页面未提供唯一的 Never 期限，请手动选择期限并创建密钥。')
      await expiration.selectOption({ label: text(await option.innerText()) })
    } else {
      await expiration.click()
      const options = this.page.getByRole('option', { name: NEVER }).filter({ visible: true })
      await options.first().waitFor({ state: 'visible', timeout: 3_000 })
      const option = await unique(options)
      if (!option) throw problem('platform_expiration_required', '未找到官方 Never 期限，请手动选择期限并创建密钥。')
      await option.click()
    }
    if (!NEVER.test(await selected()))
      throw problem('platform_expiration_required', '尚未确认官方 key 的期限，请手动选择期限并创建密钥。')
  }

  async configure({
    organizationId = this.organizationId,
    keyName,
    onKey = this.onKey,
    signal,
    assertCurrent,
    onState,
  }) {
    signal?.throwIfAborted()
    assertCurrent?.()
    await this.requireLogin({ signal })
    await this.selectOrganization(organizationId, { signal })
    const organizationName =
      this.identity.organizations.find((row) => row.id === organizationId)?.name || organizationId
    await this.goto(KEYS_URL)
    const name = text(keyName)
    if (!name) throw problem('platform_key_name_required', '缺少账号专用 key 名称。')
    const create = await button(
      this.page,
      /^(?:create (?:new )?secret key|create (?:new )?api key|创建(?:新的)?密钥)$/i,
      '等待官方创建 API key 入口超时，可在当前窗口重试配置',
      30_000,
    )
    await create.click()
    const dialogs = this.page.getByRole('dialog')
    try {
      await dialogs.first().waitFor({ state: 'visible', timeout: 15_000 })
    } catch {
      throw problem('platform_page_changed', '未找到官方创建 API key 对话框。')
    }
    const dialog = await visibleOne(dialogs)
    if (!dialog) throw problem('platform_page_changed', '未找到官方创建 API key 对话框。')
    await dialog.getByText(/^Loading projects(?:\.{3}|…)?$/i).waitFor({ state: 'hidden', timeout: 20_000 })
    await this.settled()
    const project = await this.ensureProject()
    const nameLabel = await visibleOne(dialog.locator('label').filter({ hasText: /^Name(?:\s*\(?Optional\)?)?$/i }))
    const nameInput = nameLabel && (await visibleOne(nameLabel.locator('..').locator('input[type="text"]')))
    if (!nameInput) throw problem('platform_page_changed', '未找到官方 key 名称输入框。')
    await nameInput.fill(name)
    await this.selectProject(dialog, project)
    const setup = this.beginKeySetup({
      organizationId,
      organizationName,
      projectId: project.id,
      keyName: name,
      onKey,
      signal,
      assertCurrent,
      onState,
    })
    try {
      try {
        await this.selectExpiration(dialog)
        this.assertKeySetup(setup)
        const submit = await button(
          dialog,
          /^(?:create secret key|create key|创建密钥)$/i,
          '未找到官方创建 key 提交按钮。',
        )
        if (!setup.request && !this.createdKey) await submit.click()
      } catch (error) {
        this.assertKeySetup(setup)
        if (!onState) throw error
        if (!this.createdKey) this.setKeyState(setup, 'awaiting_key_input', KEY_INPUT_MESSAGE)
      }
      setup.timeout = setTimeout(() => {
        if (setup.saved || setup.saveFailed) return
        try {
          if (onState)
            this.setKeyState(
              setup,
              'awaiting_key_input',
              '尚未取得完整密钥，请核对官方创建结果；不要重复创建，保留完整密钥弹窗后点击“检查创建结果”。',
            )
          else
            setup.reject(
              problem(
                'platform_key_unconfirmed',
                '尚未取得官方新 key 的完整 secret，请核对创建结果后继续，不会自动重复创建。',
              ),
            )
        } catch (error) {
          setup.reject(error)
        }
      }, 9_000)
      return await setup.result
    } finally {
      this.endKeySetup(setup)
    }
  }

  async readBalance({ organizationId = this.organizationId, signal } = {}) {
    return withinBillingRead(this.page, signal, async ({ signal: readSignal, remaining }) => {
      await this.requireLogin({ signal: readSignal })
      // Onboarding can identify the user before the selected organization is observed.
      // Only a GET started during this read can confirm the exact Billing organization.
      if (this.identity.organizationId && this.identity.organizationId !== organizationId)
        await this.selectOrganization(organizationId, { signal: readSignal })
      readSignal.throwIfAborted()
      const requestFloor = this.creditSequence
      this.creditSummaries.delete(organizationId)
      this.billingSessions.delete(organizationId)
      let responseListener
      let aborted
      const unavailable = () =>
        problem('platform_balance_unavailable', '尚未取得当前组织的官方 Billing 余额，请在登录窗口核对页面。')
      const observed = new Promise((resolve, reject) => {
        responseListener = async (response) => {
          const request = response.request()
          if (
            response.url().split('?')[0] !== BILLING_CREDIT_GRANTS_URL ||
            !response.ok() ||
            request.method() !== 'GET' ||
            request.headers()['openai-organization'] !== organizationId ||
            !(this.creditRequests.get(request) > requestFloor)
          )
            return
          try {
            await this.settled()
            readSignal.throwIfAborted()
            if (
              !(this.creditSequences.get(organizationId) > requestFloor) ||
              this.creditSummaries.get(organizationId)?.balance == null
            )
              throw unavailable()
            resolve()
          } catch (error) {
            reject(error)
          }
        }
        aborted = () => reject(readSignal.reason)
        this.page.on('response', responseListener)
        readSignal.addEventListener('abort', aborted, { once: true })
      })
      // Register before navigation; the Billing request can finish before DOMContentLoaded.
      observed.catch(() => {})
      try {
        await navigatePlatformForObservation(this.page, BILLING_URL, {
          timeout: remaining(),
          signal: readSignal,
          observed,
        })
        await observed
        await this.settled()
        const state = await this.requireLogin({ signal: readSignal })
        if (state.organizationId && state.organizationId !== organizationId)
          throw problem('platform_organization_unconfirmed', '当前 Platform 组织已变化，请核对后重试余额刷新。')
        readSignal.throwIfAborted()
        return {
          ...this.creditSummaries.get(organizationId),
          displayName: state.organizations.find((row) => row.id === organizationId)?.name || organizationId,
        }
      } finally {
        this.page.off('response', responseListener)
        readSignal.removeEventListener('abort', aborted)
      }
    })
  }
}
