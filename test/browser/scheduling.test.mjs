import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '../..')
const webRequire = createRequire(path.join(root, 'web/package.json'))
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')))
const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')))
const { default: tailwindcss } = await import(pathToFileURL(webRequire.resolve('@tailwindcss/vite')))
const fixture = fileURLToPath(new URL('./scheduling-fixture.tsx', import.meta.url)).replaceAll('\\', '/')

test('official VM list preserves sorting, live counts, responsive access and detail permissions', {
  timeout: 90_000,
}, async (t) => {
  assert.ok(process.env.UI_BROWSER_EXE, 'UI_BROWSER_EXE must point to an installed test Chromium')
  const vite = await createServer({
    configFile: false,
    root: path.join(root, 'web'),
    cacheDir: path.join(root, 'web/node_modules/.vite-scheduling-fixture'),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'offline-scheduling-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (new URL(req.url, 'http://fixture').pathname !== '/offline-ui') return next()
            const html = await server.transformIndexHtml(
              '/offline-ui',
              `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Offline scheduling</title></head><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
            )
            res.setHeader('content-type', 'text/html')
            res.end(html)
          })
        },
      },
    ],
    resolve: {
      alias: { '@': path.join(root, 'web/src') },
      dedupe: ['react', 'react-dom', '@tanstack/react-query', '@tanstack/react-router'],
    },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    optimizeDeps: { entries: [fixture] },
  })
  let browser
  t.after(async () => {
    await browser?.close()
    await vite.close()
  })
  await vite.listen()
  const origin = vite.resolvedUrls.local[0].replace(/\/$/, '')
  browser = await chromium.launch({
    executablePath: process.env.UI_BROWSER_EXE,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const rejectedOrigins = []
  const errors = []
  const switchWrites = []
  const healthRequests = []
  let rejectHealth = false
  let role = 'admin'
  const resetIn = (hours) => new Date(Date.now() + hours * 3600_000).toISOString()
  const vm = {
    id: 'offline-slot',
    name: '测试槽',
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: false,
    schedule_state: 'off',
    inflight: 3,
    session_active: 2,
    session_max: 8,
    schedule_level: 6,
    schedule_level_mode: 'auto',
    has_token: true,
    credential_mode: 'oauth',
    auth_scheme: 'authorization_bearer',
    email: 'offline@example.test',
    plan_type: 'plus',
    today_requests: 12,
    today_cost: 0.24,
    today_tokens: 426200,
    window_7d_requests: 550,
    window_7d_success: 528,
    window_7d_errors: 22,
    window_7d_tokens: 57_100_000,
    window_7d_cost: 71.72,
    total_cost: 71.72,
    reset_5h: resetIn(3),
    reset_7d: resetIn(67),
    utilization_5h: 0.42,
    utilization_7d: 0.18,
    codex_usage: {
      pending_refresh: true,
      last_success_at: '2026-11-16T07:00:00Z',
    },
    codex_credits: { status: 'available', balance: 12.5 },
    openai_api: {
      has_key: true,
      balance: '25.50',
      balance_refresh_interval_minutes: 0,
    },
    health_24h: Array.from({ length: 48 }, (_, i) => {
      if (i === 35) return [9, 1]
      return i >= 30 && i % 2 === 0 ? [10, 0] : [0, 0]
    }),
  }
  const visualRows = [
    {
      id: 'offline-auto1',
      name: '自动 1',
      schedule_level: 1,
      schedule_level_mode: 'auto',
      inflight: 0,
      today_requests: 48,
      today_cost: 1.04,
      window_7d_requests: 130,
      window_7d_success: 126,
      window_7d_errors: 4,
      window_7d_cost: 7.13,
      total_cost: 15.42,
      utilization_5h: 0.13,
      utilization_7d: 0.11,
    },
    {
      id: 'offline-manual6',
      name: '手动 6',
      schedule_level: 6,
      schedule_level_mode: 'manual',
      inflight: 0,
      today_requests: 0,
      today_cost: 0,
      window_7d_requests: 62,
      window_7d_success: 62,
      window_7d_errors: 0,
      window_7d_cost: 2.94,
      total_cost: 8.1,
      utilization_5h: 0,
      utilization_7d: 0.04,
    },
    {
      id: 'offline-manual10',
      name: '手动 10',
      schedule_level: 10,
      schedule_level_mode: 'manual',
      inflight: 0,
      today_requests: 7,
      today_cost: 0.18,
      window_7d_requests: 240,
      window_7d_success: 236,
      window_7d_errors: 4,
      window_7d_cost: 25.08,
      total_cost: 42.4,
      utilization_5h: 0.52,
      utilization_7d: 0.66,
    },
  ].map((row) => ({
    ...vm,
    ...row,
    email: `${row.id}@example.test`,
    schedulable: true,
    schedule_state: 'on',
    health_24h: row.id === 'offline-manual6' ? null : row.id === 'offline-manual10' ? undefined : vm.health_24h,
  }))
  const liveRows = [
    {
      ...vm,
      id: 'offline-available-codex',
      name: '可用 Codex',
      schedulable: true,
      schedule_state: 'on',
      today_requests: 209,
      today_cost: 4.01,
      window_7d_requests: 861,
      window_7d_success: 848,
      window_7d_errors: 13,
      window_7d_cost: 124.15,
      total_cost: 238.63,
      utilization_5h: 0.33,
      utilization_7d: 0.81,
      availability: { key: 'ok', text: '可用', usable: true },
      proxy: {
        id: 'offline-proxy',
        host: '192.0.2.1',
        port: 1080,
        status: 'ok',
        latency_ms: 12,
      },
    },
    {
      ...vm,
      id: 'offline-claude-seats',
      name: 'Claude 席位',
      platform: 'anthropic',
      family: 'claude',
      account_tier: 'max',
      account_tier_source: 'profile',
      schedulable: true,
      schedule_state: 'on',
      availability: { key: 'ok', text: '可用', usable: true },
      inflight: 0,
      seats_max: 5,
      seats_used: 2,
      queue_depth: 1,
      usage_has_fable: true,
      utilization_7d_oi: 0.37,
      reset_7d_oi: resetIn(30),
    },
  ]
  const longId = 'offline-long-account-0123456789-abcdefghijklmnopqrstuvwxyz'
  const longRow = {
    ...vm,
    id: longId,
    name: longId,
    email: 'long-account@example.test',
    schedulable: true,
    schedule_state: 'on',
    inflight: 1,
    plan_type: 'pro',
    codex_plan: 'pro',
    codex_plan_type: 'pro',
    chatgpt_plan_type: 'pro',
    codex: { plan_type: 'pro', subscription: { plan_type: 'pro', rate_limit_multiplier: 20 } },
    utilization_5h: 1,
    utilization_7d: 1,
    window_7d_tokens: 1_000_000_000,
    reset_5h: resetIn(4),
    reset_7d: resetIn(140),
  }
  const allRows = [vm, ...visualRows, ...liveRows, longRow]
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) {
      rejectedOrigins.push(url.origin)
      return route.abort()
    }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname === '/api/panel/me')
      return route.fulfill({
        json: { ok: true, data: { user: 'offline', role } },
      })
    if (url.pathname === '/api/panel/vms' && request.method() === 'GET') {
      return route.fulfill({
        json: { ok: true, data: { items: allRows } },
      })
    }
    if (url.pathname.endsWith('/health')) {
      assert.equal(request.method(), 'GET')
      const range = url.searchParams.get('range')
      assert.ok(range === '24h' || range === '7d')
      healthRequests.push({ role, path: url.pathname, range })
      if (rejectHealth) {
        rejectHealth = false
        return route.fulfill({
          status: 503,
          json: { ok: false, error: { message: '离线健康查询失败' } },
        })
      }
      const sample = allRows.find((item) => url.pathname === `/api/panel/vms/${item.id}/health`)
      return route.fulfill({
        json: {
          ok: true,
          data: {
            range,
            slot_min: range === '7d' ? 120 : 30,
            start: '2026-11-15T08:00:00Z',
            buckets: sample.health_24h,
            top_errors: sample.health_24h
              ? [
                  {
                    code: 'offline_error',
                    status: 502,
                    count: 1,
                    last_at: '2026-11-16T07:00:00Z',
                  },
                ]
              : [],
          },
        },
      })
    }
    if (url.pathname === '/api/panel/vms/offline-slot/schedulable') {
      assert.equal(request.method(), 'POST')
      const body = request.postDataJSON()
      assert.deepEqual(Object.keys(body), ['schedulable'])
      switchWrites.push(body)
      vm.schedulable = body.schedulable
      vm.schedule_state = body.schedulable ? 'on' : 'off'
      return route.fulfill({ json: { ok: true, data: { vm } } })
    }
    assert.fail(`unexpected fixture API request: ${request.method()} ${url.pathname}`)
  })
  await context.addInitScript(() => {
    localStorage.setItem('kin_console_token', 'offline-scheduling-token')
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/offline-ui`)
  const rowOf = (id) => page.locator(`[data-vm-row][aria-label^="${id}，"]`)
  const row = rowOf('offline-slot')
  const table = page.getByRole('table', { name: '槽位列表', exact: true })
  await row.waitFor()
  const headers = await table.getByRole('columnheader').allTextContents()
  assert.deepEqual(
    headers.map((label) => label.trim()),
    [
      '详情页',
      '槽位',
      '调度 · 优先级',
      '健康 · 24h',
      '5H',
      '7D',
      'Fable',
      '今日请求数',
      '席位/会话',
      '排队',
      '请求中',
      '7 天窗口花费',
      'Token',
      '$/请求',
      '总费用',
      '操作',
    ],
  )
  const cell = (slot, label) => slot.getByRole('cell').nth(headers.findIndex((header) => header.trim() === label))
  assert.equal(await cell(row, '槽位').getByText('测试槽', { exact: true }).count(), 1)
  assert.equal(await cell(row, '调度 · 优先级').getByText('P6', { exact: true }).count(), 1)
  assert.equal(await cell(row, '今日请求数').innerText(), '12')
  assert.equal(await cell(row, '7 天窗口花费').innerText(), '$71.72')
  assert.equal(await cell(rowOf('offline-claude-seats'), '席位/会话').innerText(), '2/5')
  const sessions = cell(row, '席位/会话')
  assert.equal(await sessions.innerText(), '2/8')
  assert.equal(await cell(rowOf('offline-claude-seats'), '排队').innerText(), '1')
  assert.equal(await rowOf('offline-manual6').getByText('24h 无请求', { exact: true }).count(), 1)
  assert.equal(await rowOf('offline-manual10').getByText('24h 未知', { exact: true }).count(), 1)
  await page.getByLabel('全局汇总', { exact: true }).waitFor()

  const requests = cell(row, '请求中')
  assert.equal(await requests.innerText(), '3')
  const refresh = page.getByRole('button', { name: '刷新离线数据', exact: true })
  vm.session_active = 0
  await refresh.click()
  await sessions.getByText('0/8', { exact: true }).waitFor()
  assert.equal(await requests.innerText(), '3')
  for (const inflight of [0, 2, 3]) {
    vm.inflight = inflight
    await refresh.click()
    await requests.getByText(String(inflight), { exact: true }).waitFor()
  }

  const order = () =>
    page.locator('[data-vm-row]').evaluateAll((rows) => rows.map((el) => el.getAttribute('aria-label')))
  const initialOrder = await order()
  const queueSort = table.getByRole('button', { name: '排队', exact: true })
  await queueSort.focus()
  await page.keyboard.press('Enter')
  assert.ok((await order())[0].startsWith('offline-claude-seats，'))
  assert.equal(await queueSort.locator('..').getAttribute('aria-sort'), 'descending')
  assert.equal(await queueSort.evaluate((el) => el === document.activeElement), true)
  await queueSort.click()
  assert.equal(await queueSort.locator('..').getAttribute('aria-sort'), 'ascending')
  await queueSort.click()
  assert.deepEqual(await order(), initialOrder)

  const grouping = page.getByRole('button', { name: '按状态分组', exact: true })
  const secondary = page.getByRole('button', { name: '次要信息常显', exact: true })
  await grouping.click()
  await row.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: /关闭调用/ }).click()
  await row.waitFor()
  await grouping.click()
  const scrollPane = page.locator('[data-vm-table]')
  await secondary.click()
  assert.equal(await scrollPane.getAttribute('data-pin'), 'true')
  await secondary.click()
  assert.deepEqual(healthRequests, [])

  const scheduleSwitch = row.getByRole('switch')
  await scheduleSwitch.click()
  await row.getByRole('switch', { checked: true }).waitFor()
  await scheduleSwitch.click()
  await row.getByRole('switch', { checked: false }).waitFor()
  assert.deepEqual(switchWrites, [{ schedulable: true }, { schedulable: false }])

  const expand = row.getByRole('button', { name: '展开 offline-slot 明细', exact: true })
  const detail = page.getByRole('region', { name: 'offline-slot 明细', exact: true })
  await row.focus()
  await page.keyboard.press('Enter')
  await detail.getByText('99.0%', { exact: true }).waitFor()
  await detail.getByLabel(/额度待刷新，最近测量/).waitFor()
  await detail.getByRole('button', { name: '刷新额度和积分', exact: true }).waitFor()
  assert.equal(await detail.getByRole('button', { name: 'API配置', exact: true }).count(), 0)
  const cost = detail.getByRole('region', { name: '成本拆分', exact: true })
  assert.match(await cost.innerText(), /57\.1M/)
  assert.match(await cost.innerText(), /\$0\.130/)

  rejectHealth = true
  await detail.getByRole('button', { name: '近 7 天', exact: true }).click()
  await detail.getByText('加载失败：离线健康查询失败', { exact: true }).waitFor()
  await detail.getByRole('button', { name: '24h', exact: true }).click()
  await detail.getByText('99.0%', { exact: true }).waitFor()
  assert.deepEqual(
    healthRequests.map(({ range }) => range),
    ['24h', '7d'],
  )

  await row.focus()
  await page.keyboard.press('Space')
  await detail.waitFor({ state: 'hidden' })
  await row.getByRole('button', { name: '打开 offline-slot 详情页', exact: true }).click()
  await row.focus()
  await page.keyboard.press('Shift+Enter')
  assert.equal(await page.getByRole('status', { name: '详情打开次数' }).innerText(), '2')
  await expand.click()
  await detail.getByRole('button', { name: '打开完整详情 →' }).click()
  assert.equal(await page.getByRole('status', { name: '详情打开次数' }).innerText(), '3')
  await row.getByRole('button', { name: '收起 offline-slot 明细' }).click()

  const account = cell(row, '槽位')
  await account.getByText('测试槽', { exact: true }).evaluate((el) => {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await row.dispatchEvent('click')
  assert.equal(await detail.count(), 0)
  await page.evaluate(() => window.getSelection().removeAllRanges())
  await requests.click()
  await detail.waitFor()
  await row.focus()
  await page.keyboard.press('Escape')
  await detail.waitFor({ state: 'hidden' })

  const screenshotDirectory = process.env.VM_LIST_SCREENSHOT_DIR
  if (screenshotDirectory) {
    await page.screenshot({ path: path.join(screenshotDirectory, 'vm-list-desktop.png'), fullPage: true })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(
    await scrollPane.evaluate((el) => {
      const viewport = document.documentElement
      return el.scrollWidth > el.clientWidth && viewport.scrollWidth <= viewport.clientWidth + 1
    }),
  )
  await scrollPane.evaluate((el) => (el.scrollLeft = el.scrollWidth))
  assert.ok(await scrollPane.evaluate((el) => el.scrollLeft > 0))
  assert.equal(await account.evaluate((el) => getComputedStyle(el).position), 'sticky')
  const name = await account.getByText('测试槽', { exact: true }).boundingBox()
  assert.ok(name && name.x >= 0 && name.x + name.width <= 390)
  if (screenshotDirectory) {
    await scrollPane.evaluate((el) => (el.scrollLeft = 0))
    await page.screenshot({ path: path.join(screenshotDirectory, 'vm-list-mobile.png') })
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  for (role of ['user', 'super']) {
    await page.reload()
    await row.waitFor()
    const beforeHealth = healthRequests.length
    await expand.click()
    await detail.getByText('健康明细仅管理员可查看', { exact: true }).waitFor()
    assert.equal(healthRequests.length, beforeHealth)
    assert.equal(await detail.getByRole('button', { name: '刷新额度和积分', exact: true }).count(), 0)
  }
  assert.deepEqual(rejectedOrigins, [])
  assert.deepEqual(errors, [])
})
