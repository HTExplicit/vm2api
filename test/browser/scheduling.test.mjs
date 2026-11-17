import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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

test('official compact list preserves sorting, live counts, API access and detail permissions', {
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
  const writes = []
  const switchWrites = []
  const healthRequests = []
  let rejectHealth = false
  let role = 'admin'
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
    email: 'offline@example.test',
    reset_7d: '2026-11-21T01:00:00Z',
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
    health_24h: Array.from({ length: 48 }, (_, i) => (i === 47 ? [99, 1] : [0, 0])),
  }
  const visualRows = [
    {
      id: 'offline-auto1',
      name: '自动 1',
      schedule_level: 1,
      schedule_level_mode: 'auto',
    },
    {
      id: 'offline-manual6',
      name: '手动 6',
      schedule_level: 6,
      schedule_level_mode: 'manual',
    },
    {
      id: 'offline-manual10',
      name: '手动 10',
      schedule_level: 10,
      schedule_level_mode: 'manual',
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
      schedulable: true,
      schedule_state: 'on',
      availability: { key: 'ok', text: '可用', usable: true },
      inflight: 0,
      seats_max: 5,
      seats_used: 2,
      queue_depth: 1,
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
    codex_plan: 'pro',
    codex_plan_type: 'pro',
    chatgpt_plan_type: 'pro',
    codex: { plan_type: 'pro', subscription: { plan_type: 'pro', rate_limit_multiplier: 20 } },
    utilization_5h: 1,
    utilization_7d: 1,
    reset_5h: new Date(Date.now() + 99 * 3600_000).toISOString(),
    reset_7d: new Date(Date.now() + 999 * 3600_000).toISOString(),
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
  assert.equal(await row.evaluate((el) => el.getBoundingClientRect().height), 44)
  assert.equal(await table.getByRole('columnheader').count(), 16)
  assert.equal(await page.locator('[data-slot="priority-segment"]').count(), 0)
  assert.equal(await row.getByRole('cell').nth(2).getByRole('switch').count(), 1)
  assert.equal(await row.getByRole('cell').nth(2).getByText('P6', { exact: true }).count(), 1)
  assert.equal(await rowOf('offline-available-codex').getByRole('cell').nth(10).innerText(), '3')
  assert.equal(await row.getByRole('cell').nth(10).innerText(), '3')
  assert.equal(await rowOf('offline-claude-seats').getByRole('cell').nth(8).innerText(), '2/5')
  assert.equal(await rowOf('offline-claude-seats').getByRole('cell').nth(9).innerText(), '1')
  assert.equal(await rowOf('offline-manual6').getByText('24h 无请求', { exact: true }).count(), 1)
  assert.equal(await rowOf('offline-manual10').getByText('24h 未知', { exact: true }).count(), 1)
  assert.equal(await page.getByLabel(/额度待刷新/).count(), 0)
  await page.getByLabel('全局汇总', { exact: true }).waitFor()
  const order = () => page.locator('[data-vm-row]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
  const initialOrder = await order()
  const healthSort = table.getByRole('button', { name: '健康 · 24h', exact: true })
  await healthSort.focus()
  await page.keyboard.press('Enter')
  assert.equal(await healthSort.evaluate((el) => el === document.activeElement), true)
  assert.equal(await healthSort.locator('..').getAttribute('aria-sort'), 'ascending')
  await healthSort.click()
  assert.equal(await healthSort.locator('..').getAttribute('aria-sort'), 'descending')
  await healthSort.click()
  assert.deepEqual(await order(), initialOrder)
  const seatsSort = table.getByRole('button', { name: '席位', exact: true })
  await seatsSort.click()
  assert.match((await order())[0], /^offline-claude-seats，/)
  await seatsSort.click()
  await seatsSort.click()
  const grouping = page.getByRole('button', { name: '按状态分组', exact: true })
  const secondary = page.getByRole('button', { name: '次要信息常显', exact: true })
  assert.equal(await grouping.getAttribute('aria-pressed'), 'false')
  assert.equal(await secondary.getAttribute('aria-pressed'), 'false')
  await grouping.click()
  await row.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: /关闭调用.*1 台/ }).click()
  await row.waitFor()
  await grouping.click()
  await secondary.click()
  assert.equal(await page.locator('[data-vm-table]').getAttribute('data-pin'), 'true')
  await secondary.click()
  assert.equal(await page.locator('[data-vm-table]').getAttribute('data-pin'), 'false')
  const scroll = page.locator('[data-vm-table]')
  const leftBefore = await row.getByRole('cell').nth(1).boundingBox()
  await scroll.evaluate((el) => {
    el.scrollLeft = el.scrollWidth
  })
  assert.equal(leftBefore.x, (await row.getByRole('cell').nth(1).boundingBox()).x)
  await row.getByRole('button', { name: '更多操作 offline-slot', exact: true }).click()
  await page.getByRole('menuitem', { name: 'API 赠额与调用', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.deepEqual(writes, [])
  assert.deepEqual(healthRequests, [])
  await scroll.evaluate((el) => {
    el.scrollLeft = 0
  })
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
  await row.getByRole('button', { name: '打开 offline-slot 详情页', exact: true }).click()
  assert.equal(await detail.count(), 0)
  await row.focus()
  await page.keyboard.press('Shift+Enter')
  assert.equal(await page.getByRole('status', { name: '详情打开次数' }).innerText(), '2')
  await row.getByText('offline-slot', { exact: true }).evaluate((el) => {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await row.dispatchEvent('click')
  assert.equal(await detail.count(), 0)
  await page.evaluate(() => window.getSelection().removeAllRanges())
  await row.getByText('offline-slot', { exact: true }).click()
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
  const screenshots = path.join(root, '.tmp/130-ui')
  fs.mkdirSync(screenshots, { recursive: true })
  const checkLayout = async () => {
    const cells = rowOf(longId).getByRole('cell')
    const primary = cells.nth(1)
    const account = primary.getByText(longId, { exact: true })
    assert.equal(await account.evaluate((el) => el.scrollWidth > el.clientWidth), true)
    const kernel = primary.getByText('默认', { exact: true })
    const p = await primary.boundingBox(),
      k = await kernel.boundingBox()
    assert.ok(k.x >= p.x && k.x + k.width <= p.x + p.width)
    for (const index of [4, 5]) {
      const block = cells.nth(index).locator('div').first()
      const children = await block.locator(':scope > span').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect()
          return {
            y: r.y,
            bottom: r.bottom,
            width: r.width,
            scroll: el.scrollWidth,
            client: el.clientWidth,
            opacity: getComputedStyle(el).opacity,
          }
        }),
      )
      assert.equal(children.length, 3)
      assert.ok(children[0].bottom <= children[1].y && children[1].bottom <= children[2].y)
      assert.ok(children[2].scroll <= children[2].client)
      assert.equal(children[2].opacity, '1')
    }
  }
  const capture = async (name) => {
    await checkLayout()
    await scroll.evaluate((el) => {
      el.scrollLeft = 0
    })
    await page.mouse.move(0, 0)
    await page.evaluate(() => document.activeElement?.blur())
    await page.screenshot({ path: path.join(screenshots, `${name}-rows.png`), fullPage: true })
    await expand.click()
    await detail.getByText('99.0%', { exact: true }).waitFor()
    await scroll.evaluate((el) => {
      el.scrollLeft = 0
    })
    await page.screenshot({ path: path.join(screenshots, `${name}-expanded.png`), fullPage: true })
    await row.getByRole('button', { name: '收起 offline-slot 明细', exact: true }).click()
  }
  await capture('light-1440')
  await page.setViewportSize({ width: 1920, height: 900 })
  await capture('light-wide')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await capture('dark-wide')
  await page.evaluate(() => {
    document.documentElement.style.zoom = '1.5'
  })
  assert.equal(await row.evaluate((el) => el.getBoundingClientRect().height), 66)
  await capture('dark-150pct')
  await page.evaluate(() => {
    document.documentElement.style.zoom = ''
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await capture('dark-narrow')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  await capture('light-narrow')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => {
    document.documentElement.style.zoom = '1.5'
  })
  await capture('light-150pct')
  await page.evaluate(() => {
    document.documentElement.style.zoom = ''
  })
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2'
  })
  await capture('light-200pct')
  await page.evaluate(() => {
    document.documentElement.style.zoom = ''
  })
  for (role of ['user', 'super']) {
    await page.reload()
    await row.waitFor()
    const beforeHealth = healthRequests.length
    await expand.click()
    await detail.getByText('健康明细仅管理员可查看', { exact: true }).waitFor()
    assert.equal(healthRequests.length, beforeHealth)
  }
  assert.deepEqual(writes, [])
  assert.deepEqual(rejectedOrigins, [])
  assert.deepEqual(errors, [])
})
