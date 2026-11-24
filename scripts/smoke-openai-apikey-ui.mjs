import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { createServer } from '../web/node_modules/vite/dist/node/index.js'

// Exercise the real management page with local-only panel fixtures. This does
// not open an account browser, contact OpenAI, or create an upstream API key.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(root, 'web')
const fixtureVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim()
const output = process.env.UI_SMOKE_DIR || path.join(root, '.private', 'openai-apikey-ui-smoke')
const executablePath =
  process.env.UI_BROWSER_EXE ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find((candidate) => fs.existsSync(candidate))
assert.ok(executablePath, 'set UI_BROWSER_EXE to an installed Chromium executable')
fs.mkdirSync(output, { recursive: true })

const fixtureTime = new Date().toISOString()
const fixtureSecret = 'sk-proj-abcd-offline-ui-only-not-a-real-api-key-1234'
const base = {
  pro_eligible: true,
  claim_status: 'claimed',
  has_key: true,
  setup_status: 'ready',
  balance_checked_at: fixtureTime,
  balance_refresh_interval_minutes: 10,
  balance_refresh_status: 'idle',
  balance_refresh_message: null,
  last_used_at: fixtureTime,
  unpriced_requests: 0,
  organization_id: 'org-offline',
  organization_name: 'Offline organization',
  paid_balance: '10.000',
  next_expiring_amount: '21.781779775',
  next_expiring_at: '2030-12-01T12:00:00Z',
  proxy: {
    id: 'proxy-fixture-internal',
    name: '东京账号出口',
    host: '192.0.2.10',
    port: 1080,
    kind: 'socks5',
    available: true,
  },
}
let items = [
  {
    ...base,
    vm_id: 'vm-01',
    account_id: 'account-one',
    email: 'one@example.test',
    slot_name: '账号一',
    key_id: 'ek-one',
    endpoint_id: 'ep-one',
    key_suffix: '1234',
    key_prefix: 'sk-proj-abcd',
    enabled: true,
    call_status: 'ready',
    balance: '31.781779775',
    today_requests: 12,
    today_cost: 0.0345,
  },
  {
    ...base,
    vm_id: 'slot-two',
    account_id: 'account-two',
    email: 'two@example.test',
    slot_name: '账号二',
    key_id: 'ek-two',
    endpoint_id: 'ep-two',
    key_suffix: '5678',
    key_prefix: 'sk-proj-efgh',
    proxy: { ...base.proxy, name: '本地出口', host: null, port: null, kind: 'local' },
    enabled: false,
    call_status: 'quota_blocked',
    balance: '-1.239',
    today_requests: 8,
    today_cost: null,
    unpriced_requests: 1,
    quota_blocked: true,
    call_error: {
      code: 'insufficient_quota',
      message: 'Offline quota rejection',
      at: fixtureTime,
    },
  },
  {
    ...base,
    vm_id: 'slot-three',
    account_id: 'account-three',
    email: 'three@example.test',
    slot_name: '账号三',
    key_id: 'ek-three',
    endpoint_id: 'ep-three',
    key_suffix: '9012',
    key_prefix: null,
    proxy: { ...base.proxy, name: null, host: '192.0.2.11', port: 3128 },
    enabled: true,
    call_status: 'invalid_key',
    balance: null,
    today_requests: 1,
    today_cost: 0,
    last_used_at: null,
  },
]
const candidate = {
  ...base,
  vm_id: 'slot-four',
  account_id: 'account-four',
  email: 'four@example.test',
  slot_name: '账号四',
  claim_status: 'unknown',
  has_key: false,
  enabled: false,
  setup_status: 'idle',
  key_id: null,
  endpoint_id: null,
  call_status: null,
  organization_id: null,
  organization_name: null,
  paid_balance: null,
  balance: null,
  today_requests: 0,
  today_cost: 0,
  last_used_at: null,
}
items.push(candidate)

function sampleVm(id, platform, plan, fiveHour, week, extra = {}) {
  const n = Number(id.slice(-2))
  const use = 7 - n
  const future = (hours) => new Date(Date.now() + hours * 3600_000).toISOString()
  return {
    id,
    platform,
    name: id,
    email: `${platform === 'openai' ? 'gpt' : 'claude'}-${id.slice(-2)}@example.com`,
    account_tier: plan,
    subscription_type: plan,
    plan_type: plan,
    status: 'running',
    runtime_type: 'docker',
    family: platform === 'openai' ? 'codex' : 'claude',
    has_token: true,
    has_refresh: true,
    credential_mode: 'oauth',
    schedule_state: 'on',
    schedulable: true,
    schedule_level: 4 + (n % 4),
    schedule_level_mode: n % 2 ? 'auto' : 'manual',
    availability: { key: 'ok', usable: true, text: '可用' },
    proxy_configured: true,
    proxy_id: `demo-${n}`,
    proxy: { id: `demo-${n}`, kind: 'socks5', status: 'ok', enabled: true, latency_ms: 40 + n * 9 },
    utilization_5h: fiveHour,
    utilization_7d: week,
    utilization_7d_oi: platform === 'anthropic' ? week - 5 : undefined,
    reset_5h: future(2.5 - n * 0.22),
    reset_7d: future(41 + n * 10),
    reset_7d_oi: future(42 + n * 10),
    chatgpt_subscription_active_until: platform === 'openai' ? future(240 + n * 24) : undefined,
    today_cost: 4.12 * use,
    today_requests: 21 * use,
    today_tokens: 1_817_600 * use,
    total_cost: 38.52 * use,
    total_tokens: 13_210_000 * use,
    cache_hit_rate: 0.63 + n * 0.037,
    window_5h_cost: 2.19 * use,
    window_5h_tokens: 810_000 * use,
    window_7d_cost: 12.31 * use,
    window_7d_tokens: 4_681_000 * use,
    window_7d_requests: 98 * use,
    window_7d_success: 96 * use,
    window_7d_errors: 2 * use,
    health_24h: Array.from({ length: 48 }, (_, i) => {
      const requests = (i * 7 + n * 3) % 16
      return [requests, requests && i % 13 === n ? 1 : 0]
    }),
    max_concurrency: 5,
    max_rpm: 30,
    inflight: n % 3,
    ...extra,
  }
}

const sampleVms = [
  sampleVm('vm-01', 'openai', 'pro', 24, 48, {
    active: true,
    session_active: 3,
    session_max: 12,
    openai_api: { account_id: 'account-one', has_key: true, pro_eligible: true },
  }),
  sampleVm('vm-02', 'anthropic', 'max', 37, 56, { runtime_type: 'kvm', seats_used: 2, seats_max: 10 }),
  sampleVm('vm-03', 'openai', 'plus', 12, 22, { session_active: 1, session_max: 8 }),
  sampleVm('vm-04', 'anthropic', 'pro', 91, 73, {
    schedule_state: 'restricted',
    schedulable: false,
    restriction_reason: 'quota_5h',
    restriction_text: '接近 5 小时额度上限',
    availability: { key: 'quota', usable: false, text: '额度受限' },
  }),
  {
    id: 'vm-05',
    name: 'vm-05',
    platform: 'openai',
    status: 'stopped',
    runtime_type: 'docker',
    has_token: false,
    schedulable: false,
    schedule_state: 'off',
    availability: { key: 'none', usable: false, text: '未导入' },
  },
]
const gemini = {
  id: 'demo-gemini',
  name: 'Gemini 示例',
  proxy_id: 'demo-6',
  auth_state: 'authorized',
  runtime_ready: true,
  billing_ready: true,
  proxy_ready: true,
  auth_method: 'oauth',
  kernel_version: '0.3.0',
  created_at: fixtureTime,
  updated_at: fixtureTime,
  models: ['gemini-3-pro'],
  models_discovered: true,
  account: {
    state: 'ok',
    checked_at: fixtureTime,
    email: 'gemini-01@example.com',
    plan: 'Pro',
    quotas: [],
    credits: [],
  },
}

const requests = []
const errors = []
const externalRequests = []
const unknownApiRequests = []
let role = 'admin'
let empty = false
let balanceMode = null
let client, vite

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

async function until(predicate, message) {
  const deadline = Date.now() + 7000
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message)
    await sleep(25)
  }
}

try {
  vite = await createServer({
    root: web,
    configFile: path.join(web, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'offline-openai-apikey-smoke',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = new URL(req.url, 'http://127.0.0.1')
            if (!url.pathname.startsWith('/api/')) return next()
            void (async () => {
              const body = await readBody(req)
              requests.push({
                method: req.method,
                path: url.pathname,
                query: url.search,
                body,
              })
              if (url.pathname === '/api/panel/me') {
                return json(res, 200, {
                  ok: true,
                  data: {
                    user: 'offline-admin',
                    role,
                    views: role === 'admin' ? undefined : ['openai-apikey'],
                    version: fixtureVersion,
                  },
                })
              }
              if (url.pathname === '/api/panel/vms') {
                return json(res, 200, {
                  ok: true,
                  data: { items: sampleVms, pool_queue: { global_queue_depth: 0, queue_max: 32 } },
                })
              }
              if (url.pathname === '/api/panel/vms/vm-01/health') {
                return json(res, 200, {
                  ok: true,
                  data: { buckets: sampleVms[0].health_24h, slot_min: 30, start: fixtureTime, top_errors: [] },
                })
              }
              if (url.pathname === '/api/panel/usage') return json(res, 200, { ok: true, data: { items: [] } })
              if (url.pathname === '/api/panel/proxies' && req.method === 'GET') {
                return json(res, 200, { ok: true, data: { items: [] } })
              }
              if (url.pathname === '/api/panel/gemini') {
                return json(res, 200, {
                  ok: true,
                  data: {
                    available: true,
                    payload_state: 'installed',
                    release_activated: true,
                    environments: [gemini],
                  },
                })
              }
              if (url.pathname === '/api/panel/pool/stream') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
                res.write(': offline\n\n')
                return
              }
              if (url.pathname === '/api/panel/openai-apikey' && req.method === 'GET') {
                return json(res, 200, {
                  ok: true,
                  data: {
                    items: empty
                      ? []
                      : items.map((item) =>
                          item.vm_id === 'vm-01' && balanceMode ? { ...item, ...balanceMode } : item,
                        ),
                  },
                })
              }
              if (url.pathname === '/api/panel/openai-apikey/batch') {
                const results = body.items.map((target) => {
                  if (body.action === 'refresh_balance')
                    return {
                      ...target,
                      status: target.vm_id === 'slot-two' ? 'error' : 'queued',
                      ...(target.vm_id === 'slot-two'
                        ? {
                            error: {
                              code: 'offline_proxy',
                              message: 'Offline proxy unavailable',
                            },
                          }
                        : {}),
                    }
                  if (body.action === 'delete') items = items.filter((item) => item.vm_id !== target.vm_id)
                  return { ...target, status: 'done' }
                })
                return json(res, 200, { ok: true, data: { results } })
              }
              const accountAction = url.pathname.match(
                /^\/api\/panel\/vms\/([^/]+)\/openai-api\/(key|enabled|resume|refresh|preview|claim)$/,
              )
              if (accountAction) {
                const [, vmId, action] = accountAction
                if (action === 'key' && req.method === 'GET') {
                  assert.equal(url.searchParams.get('account_id'), 'account-one')
                  return json(res, 200, {
                    ok: true,
                    data: { api_key: fixtureSecret },
                  })
                }
                if (action === 'preview' || action === 'claim') {
                  assert.equal(vmId, candidate.vm_id)
                  assert.equal(body.account_id, candidate.account_id)
                  if (action === 'claim') assert.equal(body.destination_account_id, 'org-offline')
                  const updated = {
                    ...candidate,
                    claim_status: action === 'preview' ? 'eligible' : 'pending',
                    destinations: [{ destination_account_id: 'org-offline', display_name: 'Offline organization' }],
                    organization_id: action === 'claim' ? 'org-offline' : null,
                    organization_name: action === 'claim' ? 'Offline organization' : null,
                  }
                  items = items.map((item) => (item.vm_id === vmId ? updated : item))
                  return json(res, 200, { ok: true, data: updated })
                }
                if (action === 'key' && req.method === 'PUT') {
                  assert.equal(vmId, candidate.vm_id)
                  assert.equal(body.account_id, candidate.account_id)
                  assert.equal(body.api_key, 'sk-offline-manual-bind')
                  const updated = {
                    ...base,
                    ...items.find((item) => item.vm_id === vmId),
                    key_id: 'ek-four',
                    endpoint_id: 'ep-four',
                    key_suffix: 'bind',
                    key_prefix: 'sk-offline-m',
                    enabled: true,
                    has_key: true,
                    call_status: 'ready',
                    balance: null,
                    today_requests: 0,
                    today_cost: 0,
                    last_used_at: null,
                  }
                  items = items.map((item) => (item.vm_id === vmId ? updated : item))
                }
                return json(res, 200, { ok: true, data: {} })
              }
              unknownApiRequests.push(url.pathname)
              json(res, 404, {
                ok: false,
                error: { message: 'Unexpected offline fixture API request' },
              })
            })().catch((error) => {
              errors.push(error.message)
              json(res, 500, {
                ok: false,
                error: { message: 'Offline fixture handler failed' },
              })
            })
          })
        },
      },
    ],
  })
  await vite.listen()
  client = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-proxy-server'],
  })
  const context = await client.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1') return route.continue()
    if (url.href === 'https://api.github.com/repos/HTExplicit/vm2api/releases/latest') {
      return route.fulfill({
        headers: { 'Access-Control-Allow-Origin': '*' },
        json: {
          tag_name: `v${fixtureVersion}`,
          html_url: `https://github.com/HTExplicit/vm2api/releases/tag/v${fixtureVersion}`,
        },
      })
    }
    externalRequests.push(url.hostname)
    return route.abort()
  })
  await context.addInitScript(() => {
    localStorage.setItem('kin_console_token', 'offline-ui-smoke')
    const now = new Date()
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    localStorage.setItem('vm2api_star_hint_day', date)
    window.__clipboardWrites = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => window.__clipboardWrites.push(value) },
    })
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  const url = 'http://127.0.0.1:' + vite.httpServer.address().port + '/'
  await page.goto(url + '#/openai-apikey')
  await page.getByRole('button', { name: 'one@example.test', exact: true }).waitFor()
  assert.equal(
    requests.filter((request) => request.path.endsWith('/key')).length,
    0,
    'opening the page does not fetch a secret',
  )
  assert.equal((await page.locator('body').innerText()).includes(fixtureSecret), false)
  await page.getByRole('heading', { name: 'OpenAi_api', exact: true }).waitFor()
  const firstRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'one@example.test', exact: true }) })
  assert.equal((await firstRow.innerText()).includes('sk-proj-abcd'), false)
  assert.equal((await firstRow.innerText()).includes('东京账号出口'), false)
  await page.getByRole('button', { name: 'four@example.test', exact: true }).waitFor()
  assert.equal(await page.getByRole('checkbox', { name: '选择 four@example.test' }).count(), 0)
  assert.ok((await page.locator('body').innerText()).includes('$31.78'))
  assert.ok((await page.locator('body').innerText()).includes('$-1.23'))
  await page.screenshot({
    path: path.join(output, 'desktop-1440.png'),
    fullPage: true,
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: path.join(output, 'mobile-390.png'),
    fullPage: true,
  })
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'the mobile page confines table overflow to its scroller',
  )
  await page.setViewportSize({ width: 1440, height: 1000 })

  const search = page.getByRole('searchbox', { name: '搜索 OpenAI 账号' })
  await search.fill('two@example.test')
  assert.equal(await page.getByRole('button', { name: 'one@example.test', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'two@example.test', exact: true }).waitFor()
  await search.fill('no-such-account')
  await page.getByText('没有符合筛选条件的账号', { exact: true }).waitFor()
  await search.fill('')
  await page.getByRole('combobox', { name: '筛选配置状态' }).click()
  await page.getByRole('option', { name: '待查资格', exact: true }).click()
  await page.getByRole('button', { name: 'four@example.test', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'one@example.test', exact: true }).count(), 0)
  await page.getByRole('combobox', { name: '筛选配置状态' }).click()
  await page.getByRole('option', { name: '全部配置状态', exact: true }).click()
  await page.getByRole('combobox', { name: '筛选调用状态' }).click()
  await page.getByRole('option', { name: 'key 无效', exact: true }).click()
  await page.getByRole('button', { name: 'three@example.test', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'one@example.test', exact: true }).count(), 0)
  await page.getByRole('combobox', { name: '筛选调用状态' }).click()
  await page.getByRole('option', { name: '全部调用状态', exact: true }).click()

  await page.getByRole('button', { name: 'one@example.test', exact: true }).click()
  const detail = page.getByRole('dialog', {
    name: '账号 API Key',
    exact: true,
  })
  await detail.waitFor()
  assert.ok(page.url().endsWith('#/openai-apikey?vm_id=vm-01'))
  assert.ok(await detail.getByRole('button', { name: '复制', exact: true }).isDisabled())
  const desktopDetailBounds = await detail.boundingBox()
  assert.ok(desktopDetailBounds && desktopDetailBounds.x > 40 && desktopDetailBounds.width < 1300)
  assert.ok(
    Math.abs(desktopDetailBounds.x + desktopDetailBounds.width / 2 - 720) < 3,
    'details are centered rather than attached to the right edge',
  )
  assert.ok(
    desktopDetailBounds.y >= 0 && desktopDetailBounds.y + desktopDetailBounds.height <= 1001,
    'desktop details fit within the viewport',
  )
  assert.ok((await detail.innerText()).includes('192.0.2.10:1080'), 'details show the safe proxy address')
  assert.ok((await detail.innerText()).includes('东京账号出口'), 'details show the proxy name')
  assert.equal(await detail.getByLabel('官方 key 内容').innerText(), 'sk-proj-abcd…')
  await page.screenshot({ path: path.join(output, 'desktop-detail-1440.png'), fullPage: true, animations: 'disabled' })
  assert.equal(requests.filter((request) => request.path.endsWith('/key')).length, 0)
  await detail.getByRole('button', { name: '查看', exact: true }).click()
  await until(
    async () => (await detail.getByLabel('官方 key 内容').innerText()) === fixtureSecret,
    'the explicit reveal shows the saved secret',
  )
  const reveals = () => requests.filter((request) => request.path.endsWith('/key') && request.method === 'GET').length
  assert.equal(reveals(), 1)
  await detail.getByRole('button', { name: '复制', exact: true }).click()
  await until(
    async () => (await page.evaluate(() => window.__clipboardWrites)).at(-1) === fixtureSecret,
    'copying uses the saved key',
  )
  assert.equal(reveals(), 1, 'copying an already visible key does not refetch it')
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })
  assert.equal((await page.locator('body').innerText()).includes(fixtureSecret), false)
  await page.getByRole('button', { name: 'one@example.test', exact: true }).click()
  await detail.waitFor()
  assert.equal(reveals(), 1, 'reopening the dialog does not prefetch the secret')
  assert.equal((await detail.innerText()).includes(fixtureSecret), false, 'closing clears the displayed secret')
  await detail.getByRole('button', { name: '查看', exact: true }).click()
  await until(() => reveals() === 2, 'a reopened dialog obtains the secret on demand again')
  await detail.getByRole('button', { name: '隐藏', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await until(async () => {
    const bounds = await detail.boundingBox()
    return bounds && bounds.x >= 8 && bounds.x + bounds.width <= 382
  }, 'the responsive dialog settles within the mobile viewport')
  const mobileDetailBounds = await detail.boundingBox()
  assert.ok(
    mobileDetailBounds && mobileDetailBounds.x >= 8 && mobileDetailBounds.x + mobileDetailBounds.width <= 382,
    JSON.stringify(mobileDetailBounds),
  )
  assert.ok(Math.abs(mobileDetailBounds.x + mobileDetailBounds.width / 2 - 195) < 3, 'mobile details remain centered')
  assert.ok(mobileDetailBounds.y >= 0 && mobileDetailBounds.y + mobileDetailBounds.height <= 845)
  assert.ok(
    await detail.evaluate((element) =>
      [...element.querySelectorAll('*')].some(
        (child) =>
          child.scrollHeight > child.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(child).overflowY),
      ),
    ),
    'long details scroll inside the dialog',
  )
  await page.screenshot({
    path: path.join(output, 'mobile-detail-390.png'),
    fullPage: true,
  })
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 1440, height: 1000 })

  for (const fixture of [
    { status: 'queued', message: '等待账号浏览器空闲', label: '排队中' },
    { status: 'refreshing', message: '正在读取官方余额', label: '刷新中' },
    { status: 'needs_login', message: '请补充 Platform 登录', label: '登录' },
    { status: 'error', message: 'Billing 导航未完成，请重试刷新', label: '失败' },
  ]) {
    balanceMode = {
      balance_refresh_status: fixture.status,
      balance_refresh_message: fixture.message,
      balance_error: fixture.status === 'error' ? fixture.message : null,
    }
    await page.getByRole('button', { name: '刷新列表', exact: true }).click()
    await until(
      async () => (await firstRow.innerText()).includes(fixture.label),
      'balance status explains ' + fixture.status,
    )
    assert.ok((await firstRow.innerText()).includes('$31.78'), 'refresh status keeps the last good amount')
  }
  balanceMode = {
    balance_refresh_status: 'idle',
    balance_refresh_message: null,
    balance_error: null,
    balance_checked_at: new Date(Date.now() - 11 * 60_000).toISOString(),
  }
  await page.getByRole('button', { name: '刷新列表', exact: true }).click()
  await until(
    async () => (await firstRow.innerText()).includes('等待刷新'),
    'an expired sample without an active task is waiting to refresh',
  )
  balanceMode = {
    balance_refresh_status: 'error',
    balance_refresh_message: 'Billing 导航未完成，请重试刷新',
    balance_error: 'Billing 导航未完成，请重试刷新',
    balance_refresh_interval_minutes: 0,
  }
  await page.getByRole('button', { name: '刷新列表', exact: true }).click()
  await until(
    async () => (await firstRow.innerText()).includes('刷新失败'),
    'a balance failure remains visible in the account row',
  )
  assert.ok((await firstRow.innerText()).includes('失败'))
  await page.getByRole('button', { name: 'one@example.test', exact: true }).click()
  await detail.waitFor()
  assert.ok((await detail.innerText()).includes('Billing 导航未完成，请重试刷新'))
  assert.ok((await detail.innerText()).includes('仅手动刷新'))
  await page.screenshot({
    path: path.join(output, 'balance-failure-detail.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })
  balanceMode = null
  await page.getByRole('button', { name: '刷新列表', exact: true }).click()

  await page.getByRole('checkbox', { name: '选择 one@example.test', exact: true }).check()
  await page.getByRole('checkbox', { name: '选择 two@example.test', exact: true }).check()
  await page.getByRole('button', { name: '刷新余额', exact: true }).click()
  const result = page.getByRole('status').filter({ hasText: '已完成 0 · 已排队 1 · 失败 1' })
  await result.waitFor()
  assert.ok((await result.innerText()).includes('one@example.test'))
  assert.ok((await result.innerText()).includes('Offline proxy unavailable'))
  await page.screenshot({
    path: path.join(output, 'batch-partial-result.png'),
    fullPage: true,
  })
  await page.getByRole('button', { name: '解除本地绑定', exact: true }).click()
  const deletion = page.getByRole('alertdialog')
  await deletion.waitFor()
  assert.ok((await deletion.innerText()).includes('解除 2 个账号的本地绑定'))
  assert.ok((await deletion.innerText()).includes('one@example.test'))
  assert.ok((await deletion.innerText()).includes('two@example.test'))
  await deletion.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(
    requests.some((request) => request.path.endsWith('/batch') && request.body.action === 'delete'),
    false,
  )

  await page.goto(url + '#/openai-apikey?vm_id=slot-four')
  await detail.waitFor()
  await detail.getByRole('button', { name: '查询领取资格', exact: true }).click()
  await detail.getByRole('button', { name: '领取赠额', exact: true }).click()
  await detail.getByRole('button', { name: '配置 API Key', exact: true }).waitFor()
  assert.equal(requests.filter((request) => request.path.endsWith('/browser/open')).length, 0)
  await detail.getByRole('button', { name: '绑定已有 Key', exact: true }).click()
  const binding = page.getByRole('dialog', {
    name: '绑定已有 Key',
    exact: true,
  })
  await binding.waitFor()
  assert.equal(await binding.getByRole('combobox').count(), 0)
  await binding.getByLabel('官方 API Key', { exact: true }).fill('sk-offline-manual-bind')
  await binding.getByRole('button', { name: '保存', exact: true }).click()
  await binding.waitFor({ state: 'hidden' })
  await detail.getByRole('button', { name: '连接 Platform', exact: true }).waitFor()
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })
  assert.equal(requests.filter((request) => request.method === 'PUT' && request.path.endsWith('/key')).length, 1)
  assert.equal(
    requests.some((request) => /models|responses|completions/.test(request.path)),
    false,
    'manual binding never queries models or calls inference',
  )

  await page.setViewportSize({ width: 1760, height: 1050 })
  await page.goto(url + '#/vm')
  await page.reload()
  await page.getByRole('heading', { name: '虚拟机', exact: true }).waitFor()
  await page.getByRole('button', { name: '查看 vm-01 详情', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '网格视图' }).getAttribute('aria-pressed'), 'true')
  await page.screenshot({ path: path.join(output, 'official-grid-1760.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '列表视图' }).click()
  const vmTable = page.getByRole('table', { name: '槽位列表' })
  await vmTable.waitFor()
  await page.screenshot({ path: path.join(output, 'official-list-1760.png'), animations: 'disabled' })
  await page.reload()
  await vmTable.waitFor()
  assert.equal(await page.getByRole('button', { name: '列表视图' }).getAttribute('aria-pressed'), 'true')
  const vmSearch = page.getByPlaceholder('搜索名称 / 邮箱 / 代理')
  await vmSearch.fill('vm-02')
  await vmTable.getByRole('row', { name: /^vm-02，/ }).waitFor()
  assert.equal(await vmTable.getByRole('row', { name: /^vm-01，/ }).count(), 0)
  await vmSearch.clear()
  await vmTable.getByRole('button', { name: '5H', exact: true }).click()
  assert.equal(
    await vmTable.getByRole('columnheader', { name: '5H', exact: true }).getAttribute('aria-sort'),
    'descending',
  )
  const vmRow = vmTable.getByRole('row', { name: /^vm-01，/ })
  await vmRow.focus()
  await vmRow.press('Enter')
  await vmTable.getByRole('region', { name: '请求健康', exact: true }).waitFor()
  await vmRow.press('Enter')
  assert.equal(await vmTable.getByRole('region', { name: '请求健康', exact: true }).count(), 0)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  assert.ok(
    await page.locator('[data-vm-table]').evaluate((element) => element.scrollWidth > element.clientWidth),
    'the official VM list retains its horizontal scroller on mobile',
  )
  await page.setViewportSize({ width: 1760, height: 1050 })
  await vmRow.getByRole('button', { name: '更多操作 vm-01', exact: true }).click()
  await page.getByRole('menuitem', { name: '管理 OpenAI API Key', exact: true }).click()
  await detail.waitFor()
  assert.ok(page.url().endsWith('#/openai-apikey?vm_id=vm-01'))
  assert.ok((await detail.innerText()).includes('one@example.test'))
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })

  empty = true
  await page.reload()
  await page.getByText('暂无可管理的 OpenAI 账号。', { exact: true }).waitFor()
  await page.screenshot({
    path: path.join(output, 'empty-state.png'),
    fullPage: true,
  })
  role = 'super'
  const listsBefore = requests.filter((request) => request.path === '/api/panel/openai-apikey').length
  await page.reload()
  await page.getByText('只有管理员可以管理账号 API Key。', { exact: true }).waitFor()
  await sleep(150)
  assert.equal(
    requests.filter((request) => request.path === '/api/panel/openai-apikey').length,
    listsBefore,
    'non-admin does not fetch the key list',
  )
  assert.deepEqual(unknownApiRequests, [])
  assert.deepEqual(externalRequests, [])
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      offline: true,
      real_page: true,
      screenshots: output,
      viewports: ['1440x1000', '390x844'],
      initial_secret_requests: 0,
      explicit_secret_requests: reveals(),
      search_filters: true,
      close_clears_secret: true,
      explicit_copy: true,
      centered_dialog: true,
      masked_key_prefix: true,
      named_proxy_and_safe_address: true,
      explicit_balance_states: true,
      batch_partial_result: true,
      delete_confirmation: true,
      manual_binding_without_model_query: true,
      claim_never_opens_browser: true,
      official_vm_grid_list_and_link: true,
      empty_state: true,
      administrator_only: true,
      external_requests: externalRequests.length,
      page_errors: errors.length,
    }),
  )
} finally {
  await client?.close()
  await vite?.close()
}
