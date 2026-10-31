const PLATFORM_ORIGIN = 'https://platform.openai.com'
const PROJECTS_URL = `${PLATFORM_ORIGIN}/settings/organization/projects`
const KEYS_URL = `${PLATFORM_ORIGIN}/api-keys`
const BILLING_URL = `${PLATFORM_ORIGIN}/settings/organization/billing/overview`
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ORGANIZATION_ID = /^org[-_][a-z\d_-]+$/i
const PROJECT_ID = /^proj[-_][a-z\d_-]+$/i
const SECRET_KEY = /^sk-[a-z\d_-]{16,}$/i

function problem(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status })
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function items(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : []
}

function entity(value, pattern) {
  if (!value || typeof value !== 'object' || !pattern.test(text(value.id))) return null
  return { id: value.id, name: text(value.name || value.title || value.display_name) || value.id }
}

/** Keep identity metadata only; session tokens and response bodies are never retained. */
export function platformIdentityObservation(url, payload, organizationHeader = '') {
  const path = new URL(url).pathname
  const self = /\/(?:me|user|profile|onboarding|session)(?:\/|$)/i.test(path)
  const candidates = self ? [payload?.user, payload?.profile, payload?.data?.user, payload?.data, payload] : []
  const email = candidates.map((value) => text(value?.email)).find((value) => EMAIL.test(value)) || null
  const organizations = []
  const projects = []
  const add = (list, row) => {
    if (row && !list.some((value) => value.id === row.id)) list.push(row)
  }
  if (self || /\/(?:organizations|orgs)(?:\/|$)/i.test(path)) {
    for (const value of [payload?.organizations, payload?.orgs, payload?.data?.organizations, payload?.data?.orgs]) {
      for (const row of items(value)) add(organizations, entity(row, ORGANIZATION_ID))
    }
    if (/\/(?:organizations|orgs)(?:\/|$)/i.test(path)) {
      for (const row of items(payload)) add(organizations, entity(row, ORGANIZATION_ID))
      add(organizations, entity(payload, ORGANIZATION_ID))
    }
  }
  if (/\/projects(?:\/|$)/i.test(path)) {
    for (const row of items(payload?.projects || payload)) add(projects, entity(row, PROJECT_ID))
    add(projects, entity(payload?.project || payload, PROJECT_ID))
  }
  const pathOrganization = path.match(/\/organizations\/(org[-_][a-z\d_-]+)(?:\/|$)/i)?.[1]
  const currentOrganization =
    text(organizationHeader) || text(payload?.organization_id || payload?.org_id) || text(pathOrganization)
  const organizationId = ORGANIZATION_ID.test(currentOrganization) ? currentOrganization : null
  return {
    email,
    organizations,
    projects: projects.map((project) => ({ ...project, organizationId })),
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

async function button(scope, name, message) {
  const found = await visibleOne(scope.getByRole('button', { name }))
  if (!found) throw problem('platform_page_changed', message)
  return found
}

export class PlatformAdapter {
  constructor({ page, context, email, organizationId = '', projectId = '', onKey = null, now = Date.now }) {
    this.page = page
    this.context = context
    this.email = text(email).toLowerCase()
    this.organizationId = organizationId
    this.projectId = projectId
    this.onKey = onKey
    this.now = now
    this.identity = { email: null, organizations: [], projects: [], organizationId: null }
    this.projectLists = new Set()
    this.creditSummaries = new Map()
    this.creditSequences = new Map()
    this.creditSequence = 0
    this.createdKey = null
    this.keySave = null
    this.keyCallback = null
    this.pending = new Set()
    this.responseHandler = (response) => {
      const pending = this.observe(response).catch(() => {})
      this.pending.add(pending)
      pending.finally(() => this.pending.delete(pending))
    }
    page.on('response', this.responseHandler)
  }

  dispose() {
    this.page.off('response', this.responseHandler)
  }

  async observe(response) {
    const url = new URL(response.url())
    if (!['platform.openai.com', 'api.openai.com'].includes(url.hostname) || !response.ok()) return
    if (!(response.headers()['content-type'] || '').includes('json')) return
    const request = response.request()
    const headers = request.headers()
    if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/dashboard/billing/credit_grants') {
      const organizationId = headers['openai-organization']
      if (request.method() !== 'GET' || !ORGANIZATION_ID.test(text(organizationId))) return
      const sequence = ++this.creditSequence
      const summary = parsePlatformCreditSummary(await response.text(), this.now())
      if (sequence > (this.creditSequences.get(organizationId) || 0)) {
        this.creditSummaries.set(organizationId, summary)
        this.creditSequences.set(organizationId, sequence)
      }
      return
    }
    const payload = await response.json()
    const observed = platformIdentityObservation(url.href, payload, headers['openai-organization'])
    if (observed.email) this.identity.email = observed.email.toLowerCase()
    if (observed.organizationId) this.identity.organizationId = observed.organizationId
    if (
      request.method() === 'GET' &&
      /\/projects(?:\/|$)/i.test(url.pathname) &&
      observed.organizationId &&
      [payload, payload?.data, payload?.projects, payload?.projects?.data].some(Array.isArray)
    ) {
      this.projectLists.add(observed.organizationId)
    }
    for (const name of ['organizations', 'projects']) {
      for (const value of observed[name]) {
        const prior = this.identity[name].find((row) => row.id === value.id)
        if (prior) Object.assign(prior, value)
        else this.identity[name].push(value)
      }
    }
    const created = createdPlatformKey(url.href, request.method(), payload)
    if (created && !this.createdKey && this.keyCallback) {
      this.createdKey = created
      this.keySave = Promise.resolve().then(() => this.keyCallback(created))
      // The task awaits this same promise; avoid a temporary unhandled rejection.
      this.keySave.catch(() => {})
      await this.keySave
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

  async inspect() {
    await this.settled()
    const url = new URL(this.page.url())
    if (url.hostname !== 'platform.openai.com' || /\/auth(?:\/|$)/.test(url.pathname)) {
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
    return {
      authenticated: this.identity.email === this.email,
      email: this.identity.email,
      organizations: [...this.identity.organizations],
      organizationId: this.identity.organizationId,
    }
  }

  async requireLogin() {
    const state = await this.inspect()
    if (!state.authenticated) {
      throw problem('platform_login_required', '请先在账号专用浏览器中完成 OpenAI Platform 登录。')
    }
    return state
  }

  async selectOrganization(id) {
    await this.requireLogin()
    if (!ORGANIZATION_ID.test(text(id))) throw problem('platform_organization_required', '请选择接收额度的 API 组织。')
    if (this.identity.organizationId === id) return
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
    await this.goto(PROJECTS_URL)
    if (this.identity.organizationId !== id) {
      throw problem('platform_organization_unconfirmed', '尚未确认 Platform 已切换到目标 API 组织，请核对后继续。')
    }
  }

  async ensureProject(id) {
    await this.goto(PROJECTS_URL)
    await this.settled()
    if (!this.projectLists.has(this.identity.organizationId)) {
      throw problem('platform_projects_unavailable', '尚未取得当前组织的官方项目列表，请在登录窗口核对项目页面。')
    }
    if (id) {
      const saved = this.identity.projects.find(
        (row) => row.id === id && row.organizationId === this.identity.organizationId,
      )
      if (!saved) throw problem('platform_project_unavailable', '已配置的 vm2api 项目不在当前组织中，请核对项目权限。')
      return saved
    }
    const existing = this.identity.projects.filter(
      (row) => row.name === 'vm2api' && row.organizationId === this.identity.organizationId,
    )
    if (existing.length > 1) {
      throw problem('platform_project_ambiguous', '该组织存在多个同名 vm2api 项目，请在登录窗口确认要使用的项目。')
    }
    if (existing.length === 1) return existing[0]
    const create = await button(this.page, /^(?:create (?:a |new )?project|创建项目)$/i, '未找到官方创建项目入口。')
    await create.click()
    const dialog = await visibleOne(this.page.getByRole('dialog'))
    if (!dialog) throw problem('platform_page_changed', '未找到官方创建项目对话框。')
    const name = await visibleOne(dialog.getByRole('textbox', { name: /name|名称/i }))
    if (!name) throw problem('platform_page_changed', '未找到官方项目名称输入框。')
    await name.fill('vm2api')
    const submit = await button(dialog, /^(?:create(?: project)?|创建(?:项目)?)$/i, '未找到官方创建项目按钮。')
    await submit.click()
    await this.page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 20_000 })
    await this.settled()
    const created = this.identity.projects.filter(
      (row) => row.name === 'vm2api' && row.organizationId === this.identity.organizationId,
    )
    if (created.length !== 1) {
      throw problem('platform_project_unconfirmed', '创建项目后尚未取得官方项目标识，请核对后继续。')
    }
    return created[0]
  }

  async selectProject(dialog, project) {
    const select = await visibleOne(dialog.getByLabel(/^project$/i))
    if (!select) throw problem('platform_project_selection_required', '请在官方创建 key 对话框中选择 vm2api 项目。')
    const native = await select.evaluate((element) => element.tagName === 'SELECT')
    if (native) {
      await select.selectOption({ label: project.name })
      return
    }
    await select.click()
    const option = await visibleOne(this.page.getByRole('option', { name: project.name, exact: true }))
    if (!option)
      throw problem('platform_project_selection_required', '未找到 vm2api 项目选项，请在登录窗口选择后继续。')
    await option.click()
  }

  async configure({ organizationId = this.organizationId, projectId = this.projectId, keyName, onKey = this.onKey }) {
    await this.requireLogin()
    await this.selectOrganization(organizationId)
    const project = await this.ensureProject(projectId)
    const organizationName =
      this.identity.organizations.find((row) => row.id === organizationId)?.name || organizationId
    await this.goto(KEYS_URL)
    const name = text(keyName)
    if (!name) throw problem('platform_key_name_required', '缺少账号专用 key 名称。')
    const existing = this.page.getByRole('row').filter({ hasText: new RegExp(escaped(name)) })
    if ((await existing.count()) > 0) {
      throw problem(
        'platform_key_already_exists',
        '官方已存在这个账号的专用 key，但本地没有可用 secret；请核对原配置，不会重复创建或撤销 key。',
      )
    }
    const create = await button(
      this.page,
      /^(?:create (?:new )?secret key|create (?:new )?api key|创建(?:新的)?密钥)$/i,
      '未找到官方创建 API key 入口。',
    )
    await create.click()
    const dialog = await visibleOne(this.page.getByRole('dialog'))
    if (!dialog) throw problem('platform_page_changed', '未找到官方创建 API key 对话框。')
    const nameInput = await visibleOne(dialog.getByRole('textbox', { name: /name|名称/i }))
    if (!nameInput) throw problem('platform_page_changed', '未找到官方 key 名称输入框。')
    await nameInput.fill(name)
    await this.selectProject(dialog, project)
    this.createdKey = null
    this.keySave = null
    this.keyCallback = (created) => onKey?.({ ...created, organizationId, organizationName, projectId: project.id })
    const submit = await button(dialog, /^(?:create secret key|create key|创建密钥)$/i, '未找到官方创建 key 提交按钮。')
    await submit.click()
    for (let attempt = 0; attempt < 60 && !this.createdKey; attempt++) {
      await this.settled()
      if (this.createdKey) break
      const revealed = await this.page.getByRole('dialog').evaluateAll((dialogs) => {
        const secrets = []
        for (const dialog of dialogs) {
          for (const element of dialog.querySelectorAll('input, textarea, code, pre')) {
            const value = String(element.value || element.textContent || '').trim()
            if (/^sk-[a-z\d_-]{16,}$/i.test(value)) secrets.push(value)
          }
        }
        return [...new Set(secrets)]
      })
      if (revealed.length === 1) {
        this.createdKey = { apiKey: revealed[0], remoteKeyId: null }
        this.keySave = Promise.resolve().then(() => this.keyCallback(this.createdKey))
        this.keySave.catch(() => {})
        break
      }
      await this.page.waitForTimeout(150)
    }
    if (!this.createdKey) {
      throw problem(
        'platform_key_unconfirmed',
        '尚未取得官方新 key 的完整 secret，请核对创建结果后继续，不会自动重复创建。',
      )
    }
    await this.keySave
    this.keyCallback = null
    return { organizationId, organizationName, projectId: project.id, ...this.createdKey }
  }

  async readBalance({ organizationId = this.organizationId } = {}) {
    await this.requireLogin()
    await this.selectOrganization(organizationId)
    this.creditSummaries.delete(organizationId)
    const observed = this.page.waitForResponse(
      (response) => {
        const request = response.request()
        return (
          response.url().split('?')[0] === 'https://api.openai.com/v1/dashboard/billing/credit_grants' &&
          response.ok() &&
          request.method() === 'GET' &&
          request.headers()['openai-organization'] === organizationId
        )
      },
      { timeout: 15_000 },
    )
    // Register before navigation; the Billing request can finish before DOMContentLoaded.
    observed.catch(() => {})
    await this.goto(BILLING_URL)
    await observed
    await this.settled()
    const state = await this.requireLogin()
    const summary = this.creditSummaries.get(organizationId)
    if (summary?.balance == null) {
      throw problem('platform_balance_unavailable', '尚未取得当前组织的官方 Billing 余额，请在登录窗口核对页面。')
    }
    return {
      ...summary,
      displayName: state.organizations.find((row) => row.id === organizationId)?.name || organizationId,
    }
  }
}
