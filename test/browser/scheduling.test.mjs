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

test('seven-column VM list preserves sorting, live counts, responsive access and detail permissions', {
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
  const priorityWrites = []
  let rejectPriority = false
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
    if (request.method() === 'PATCH' && url.pathname === '/api/panel/vms/offline-slot') {
      assert.equal(role, 'admin')
      const body = request.postDataJSON()
      assert.deepEqual(Object.keys(body), ['schedule_level'])
      priorityWrites.push(body.schedule_level)
      if (rejectPriority) {
        return route.fulfill({
          status: 409,
          json: { ok: false, error: { message: '测试保存失败' } },
        })
      }
      vm.schedule_level_mode = body.schedule_level === null ? 'auto' : 'manual'
      vm.schedule_level = body.schedule_level ?? 6
      return route.fulfill({ json: { ok: true, data: { vm } } })
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
    localStorage.setItem(
      'kin.vm.column-order',
      JSON.stringify(['vm', 'type', 'sched', 'status', 'req', 'usage', 'cost']),
    )
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/offline-ui`)
  const rowOf = (id) => page.locator(`[data-vm-row][aria-label^="${id}，"]`)
  const row = rowOf('offline-slot')
  const table = page.getByRole('table', { name: '槽位列表', exact: true })
  await row.waitFor()
  const headers = (await table.locator('th[data-column]').allInnerTexts()).map((label) => label.trim())
  assert.deepEqual(headers, ['账号', '类型', '调度', '状态', '今日 / 7D 请求', '用量窗口', '成本'])
  const cell = (slot, name) => slot.locator(`[data-vm-cell="${name}"]`)
  assert.equal(await cell(row, 'sched').getByRole('switch').count(), 1)
  assert.equal(await row.getByText('P6', { exact: true }).count(), 1)
  const accountBadge = cell(row, 'account').locator('[data-vm-requesting]')
  assert.equal(await accountBadge.getAttribute('title'), '请求中 3')
  const accountNameBox = await cell(row, 'account').getByText('测试槽', { exact: true }).boundingBox()
  const accountBadgeBox = await accountBadge.boundingBox()
  assert.ok(accountNameBox && accountBadgeBox)
  assert.ok(accountBadgeBox.x - accountNameBox.x - accountNameBox.width <= 10)
  assert.equal(
    await cell(rowOf('offline-available-codex'), 'account').getByTitle('请求中 3', { exact: true }).count(),
    1,
  )
  const claude = rowOf('offline-claude-seats')
  assert.match(await claude.innerText(), /排队\s*1/)
  assert.equal(await cell(claude, 'account').locator('[data-vm-requesting]').count(), 0)
  const picker = page.getByRole('button', { name: '显示列' })
  const drawer = page.getByRole('dialog', { name: '显示列' })
  await picker.click()
  assert.equal(await drawer.getByRole('checkbox').count(), 19)
  assert.ok(await drawer.getByRole('checkbox', { name: /账号/ }).isDisabled())
  for (const label of ['席位占用', 'Fable 用量', '请求中']) {
    await drawer.getByRole('checkbox', { name: label, exact: true }).check()
  }
  await drawer.getByRole('checkbox', { name: '成本', exact: true }).uncheck()
  await page.keyboard.press('Escape')
  assert.equal(await cell(claude, 'seats').innerText(), '2/5')
  assert.equal(await cell(claude, 'fable').innerText(), '37%')
  assert.equal(await cell(row, 'fable').innerText(), '—')
  assert.equal(await cell(row, 'cost').count(), 0)
  await page.reload()
  await row.waitFor()
  assert.equal(await cell(row, 'inflight').innerText(), '3')
  await picker.click()
  await drawer.getByRole('button', { name: '恢复官方布局' }).click()
  await page.keyboard.press('Escape')
  assert.deepEqual(await table.locator('th[data-column]').allTextContents(), ['账号','调度','类型','状态','今日 / 7D 请求','用量窗口','成本'])
  assert.match(await cell(row, 'req').innerText(), /12 请求/)
  assert.match(await cell(row, 'cost').innerText(), /\$71\.72/)
  assert.equal(await rowOf('offline-manual6').getByText('24h 无请求', { exact: true }).count(), 1)
  assert.equal(await rowOf('offline-manual10').getByText('24h 未知', { exact: true }).count(), 1)
  assert.equal(await page.getByLabel(/额度待刷新/).count(), 0)
  assert.equal(await row.getByText('余额 12.5 点', { exact: true }).count(), 0)
  const screenshotDirectory = process.env.VM_LIST_SCREENSHOT_DIR
  if (screenshotDirectory)
    await page.screenshot({ path: path.join(screenshotDirectory, 'vm-list-desktop.png'), fullPage: true })
  const refresh = page.getByRole('button', { name: '刷新离线数据', exact: true })
  for (const inflight of [0, 2, 3]) {
    vm.inflight = inflight
    await refresh.click()
    if (inflight) {
      await cell(row, 'account').getByTitle(`请求中 ${inflight}`, { exact: true }).waitFor()
    } else {
      await accountBadge.waitFor({ state: 'detached' })
    }
  }
  const summary = page.getByRole('button', { name: '列表统计', exact: true })
  await summary.click()
  await page.getByLabel('当前列表汇总', { exact: true }).waitFor()
  await summary.click()
  const order = () => page.locator('[data-vm-row]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
  const initialOrder = await order()
  const nameSort = table.getByRole('button', { name: '账号', exact: true })
  await nameSort.focus()
  await page.keyboard.press('Enter')
  assert.equal(await nameSort.evaluate((el) => el === document.activeElement), true)
  assert.equal(await nameSort.locator('..').getAttribute('aria-sort'), 'ascending')
  await nameSort.click()
  assert.equal(await nameSort.locator('..').getAttribute('aria-sort'), 'descending')
  await nameSort.click()
  assert.deepEqual(await order(), initialOrder)
  const quotaSort = table.getByRole('button', { name: '用量窗口', exact: true })
  await quotaSort.click()
  assert.ok((await order())[0].startsWith(`${longId}，`))
  assert.equal(await quotaSort.locator('..').getAttribute('aria-sort'), 'descending')
  await quotaSort.click()
  await quotaSort.click()
  assert.deepEqual(await order(), initialOrder)
  const metricSort = page.getByRole('combobox', { name: '排序指标', exact: true })
  const options = await metricSort.locator('option').allTextContents()
  assert.deepEqual(options, [
    '调度状态', '账号名称', '5H 剩余', '今日费用', '缓存命中',
    '24h 成功率',
    '5H 用量',
    '7D 用量',
    'Fable 用量',
    '今日请求',
    '席位占用',
    '排队',
    '请求中',
    '7D 费用',
    '7D Token',
    '每请求费用',
    '累计费用',
  ])
  await metricSort.selectOption({ label: '排队' })
  assert.ok((await order())[0].startsWith('offline-claude-seats，'))
  await metricSort.selectOption({ label: '7D Token' })
  assert.ok((await order())[0].startsWith(`${longId}，`))
  await metricSort.selectOption({ index: 0 })
  assert.deepEqual(await order(), initialOrder)
  const optionsButton = page.getByRole('button', { name: '列表选项' })
  const grouping = page.getByRole('checkbox', { name: '按状态分组' })
  const secondary = page.getByRole('checkbox', { name: '次要信息常显' })
  await optionsButton.click()
  assert.equal(await grouping.isChecked(), false)
  assert.equal(await secondary.isChecked(), false)
  await grouping.check()
  await page.keyboard.press('Escape')
  await row.waitFor({state:'hidden'})
  await page.getByRole('button',{name:/关闭调用.*1 台/}).click()
  await row.waitFor()
  await optionsButton.click()
  await grouping.uncheck()
  await secondary.check()
  assert.equal(await page.locator('[data-vm-table]').getAttribute('data-pin'),'true')
  await secondary.uncheck()
  await page.keyboard.press('Escape')
  const scrollPane = page.getByRole('region',{name:'账号列表横向滚动'})
  const assertNoHorizontalOverflow = async () => {
    assert.ok(await scrollPane.evaluate(el => {
      const viewport=document.documentElement, bounds=el.getBoundingClientRect()
      return viewport.scrollWidth<=viewport.clientWidth+1 && bounds.left>=0 && bounds.right<=viewport.clientWidth+1
    }))
  }
  await assertNoHorizontalOverflow()
  await row.getByRole('button', { name: '更多操作 offline-slot', exact: true }).click()
  await page.getByRole('menuitem', { name: 'API 赠额与调用', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.deepEqual(healthRequests, [])
  const scheduleSwitch = row.getByRole('switch')
  await scheduleSwitch.click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-vm-row][aria-label^="offline-slot，"] [role="switch"]')
        ?.getAttribute('aria-checked') === 'true',
  )
  await scheduleSwitch.click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-vm-row][aria-label^="offline-slot，"] [role="switch"]')
        ?.getAttribute('aria-checked') === 'false',
  )
  assert.deepEqual(switchWrites, [{ schedulable: true }, { schedulable: false }])
  const expand = row.getByRole('button', {
    name: '展开 offline-slot 明细',
    exact: true,
  })
  const detail = page.getByRole('region', {
    name: 'offline-slot 明细',
    exact: true,
  })
  await row.focus()
  await page.keyboard.press('Enter')
  await detail.getByText('99.0%', { exact: true }).waitFor()
  const rangeTargets = await detail
    .getByRole('group', { name: '健康时间范围', exact: true })
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((el) => {
        const box = el.getBoundingClientRect()
        return box.width >= 24 && box.height >= 24
      }),
    )
  assert.deepEqual(rangeTargets, [true, true])
  assert.equal(await detail.getByRole('region').count(), 3)
  await detail.getByLabel(/额度待刷新，最近测量/).waitFor()
  await detail.getByText('余额 12.5 点', { exact: true }).waitFor()
  assert.equal(await detail.getByRole('button', { name: 'API配置', exact: true }).count(), 1)
  const quick = detail.getByRole('group', { name: '账号快捷操作' })
  await quick.getByRole('button', { name: 'API配置', exact: true }).waitFor()
  const priority = quick.getByRole('combobox', { name: '调度优先级' })
  assert.equal(await priority.inputValue(), 'auto')
  await priority.selectOption('2')
  await row.getByText('P2 手', { exact: true }).waitFor()
  await priority.selectOption('5')
  await row.getByText('P5 手', { exact: true }).waitFor()
  rejectPriority = true
  await priority.selectOption('8')
  await quick.getByRole('alert').waitFor()
  assert.match(await quick.getByRole('alert').innerText(), /测试保存失败/)
  assert.equal(await priority.inputValue(), '5')
  rejectPriority = false
  await priority.selectOption('auto')
  await row.getByText('P6', { exact: true }).waitFor()
  assert.deepEqual(priorityWrites, [2, 5, 8, null])

  const costDetail = detail.getByRole('region', { name: '成本拆分', exact: true })
  assert.match(await costDetail.innerText(), /57\.1M/)
  assert.match(await costDetail.innerText(), /\$0\.130/)
  rejectHealth = true
  await detail.getByRole('button', { name: '7D', exact: true }).click()
  await detail.getByText('加载失败：离线健康查询失败', { exact: true }).waitFor()
  await detail.getByRole('button', { name: '24h', exact: true }).click()
  await detail.getByText('99.0%', { exact: true }).waitFor()
  assert.deepEqual(
    healthRequests.map(({ range }) => range),
    ['24h', '7d'],
  )
  await row.focus()
  await page.keyboard.press('Space')
  assert.equal(await detail.count(), 0)
  await row.getByRole('button', { name: '打开 测试槽 详情页', exact: true }).click()
  assert.equal(await detail.count(), 0)
  await row.focus()
  await page.keyboard.press('Shift+Enter')
  assert.equal(await page.getByRole('status', { name: '详情打开次数' }).innerText(), '2')
  const accountName = cell(row, 'account').getByText('测试槽', { exact: true })
  await accountName.evaluate((el) => {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await row.dispatchEvent('click')
  assert.equal(await detail.count(), 0)
  await page.evaluate(() => window.getSelection().removeAllRanges())
  await cell(row, 'req').click()
  await detail.waitFor()
  await row.focus()
  await page.keyboard.press('Escape')
  assert.equal(await detail.count(), 0)
  await page.getByRole('button', { name: '展开 offline-manual6 明细', exact: true }).click()
  const emptyDetail = page.getByRole('region', {
    name: 'offline-manual6 明细',
    exact: true,
  })
  await emptyDetail.getByText('该时段无请求', { exact: true }).waitFor()
  await page.getByRole('button', { name: '收起 offline-manual6 明细', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await assertNoHorizontalOverflow()
  const narrowAccount = await cell(row, 'account').boundingBox()
  assert.ok(narrowAccount)
  assert.ok(await scrollPane.evaluate(el=>el.scrollWidth>el.clientWidth))
  await scrollPane.evaluate(el=>el.scrollLeft=el.scrollWidth)
  const pinned = await cell(row,'account').boundingBox()
  assert.ok(pinned && Math.abs(pinned.x-narrowAccount.x)<1)
  const narrowBadge = await accountBadge.boundingBox()
  assert.ok(narrowBadge && narrowBadge.x >= 0 && narrowBadge.x + narrowBadge.width <= 390)
  await expand.click()
  await detail.waitFor()
  await assertNoHorizontalOverflow()
  await row.getByRole('button', { name: '收起 offline-slot 明细', exact: true }).click()
  if (screenshotDirectory) {
    await page.setViewportSize({ width: 390, height: 960 })
    await page.reload()
    await row.waitFor()
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
    assert.equal(await detail.getByRole('button', { name: 'API配置', exact: true }).count(), 0)
    assert.equal(await detail.getByRole('combobox', { name: '调度优先级' }).count(), 0)
  }
  assert.deepEqual(rejectedOrigins, [])
  assert.deepEqual(errors, [])
})
