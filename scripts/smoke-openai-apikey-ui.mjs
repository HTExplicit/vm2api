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
const fixtureSecret = 'sk-offline-ui-only-not-a-real-api-key-1234'
const base = {
  pro_eligible: true,
  claim_status: 'claimed',
  has_key: true,
  setup_status: 'ready',
  balance_checked_at: fixtureTime,
  balance_refresh_interval_minutes: 10,
  last_used_at: fixtureTime,
  unpriced_requests: 0,
  organization_id: 'org-offline',
  organization_name: 'Offline organization',
  paid_balance: '10.000',
  next_expiring_amount: '21.781779775',
  next_expiring_at: '2030-12-01T12:00:00Z',
  proxy: { id: 'proxy-fixture', name: '账号绑定代理', available: true },
}
let items = [
  {
    ...base,
    vm_id: 'slot-one',
    account_id: 'account-one',
    email: 'one@example.test',
    slot_name: '账号一',
    key_id: 'ek-one',
    endpoint_id: 'ep-one',
    key_suffix: '1234',
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
    enabled: true,
    call_status: 'invalid_key',
    balance: null,
    today_requests: 1,
    today_cost: 0,
    last_used_at: null,
  },
]
const candidate = {
  vm_id: 'slot-four',
  account_id: 'account-four',
  email: 'four@example.test',
  slot_name: '账号四',
  claim_status: 'claimed',
}
const requests = []
const errors = []
const externalRequests = []
const unknownApiRequests = []
let role = 'admin'
let empty = false
let client, vite
const source = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {TooltipProvider} from '/src/components/ui/tooltip.tsx';
import {Toaster} from 'sonner';
import {OpenaiApiKeyPage} from '/src/features/openai-apikey/index.tsx';
import '/src/styles/index.css';
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},
React.createElement(TooltipProvider,null,React.createElement(OpenaiApiKeyPage),React.createElement(Toaster,{theme:'dark'}))));`

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
            if (url.pathname === '/__openai-key-smoke') {
              res.setHeader('Content-Type', 'text/html')
              void server
                .transformIndexHtml(
                  req.url,
                  '<html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__openai-key-smoke.tsx"></script></body></html>',
                )
                .then((html) => res.end(html))
              return
            }
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
                    views: role === 'admin' ? ['openai-apikey'] : [],
                  },
                })
              }
              if (url.pathname === '/api/panel/openai-apikey' && req.method === 'GET') {
                return json(res, 200, {
                  ok: true,
                  data: {
                    items: empty ? [] : items,
                    bind_candidates: items.some((item) => item.account_id === candidate.account_id) ? [] : [candidate],
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
                /^\/api\/panel\/vms\/([^/]+)\/openai-api\/(key|enabled|resume|refresh)$/,
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
                if (action === 'key' && req.method === 'PUT') {
                  assert.equal(vmId, candidate.vm_id)
                  assert.equal(body.account_id, candidate.account_id)
                  assert.equal(body.api_key, 'sk-offline-manual-bind')
                  items.push({
                    ...base,
                    ...candidate,
                    key_id: 'ek-four',
                    endpoint_id: 'ep-four',
                    key_suffix: 'bind',
                    enabled: true,
                    has_key: true,
                    call_status: 'ready',
                    balance: null,
                    today_requests: 0,
                    today_cost: 0,
                    last_used_at: null,
                  })
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
        resolveId(id) {
          if (id === '/__openai-key-smoke.tsx') return '\0openai-key-smoke.tsx'
        },
        load(id) {
          if (id === '\0openai-key-smoke.tsx') return source
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
    externalRequests.push(url.hostname)
    return route.abort()
  })
  await context.addInitScript(() => localStorage.setItem('kin_console_token', 'offline-ui-smoke'))
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  const url = 'http://127.0.0.1:' + vite.httpServer.address().port + '/__openai-key-smoke'
  await page.goto(url)
  await page.getByRole('button', { name: 'one@example.test', exact: true }).waitFor()
  assert.equal(
    requests.filter((request) => request.path.endsWith('/key')).length,
    0,
    'opening the page does not fetch a secret',
  )
  assert.equal((await page.locator('body').innerText()).includes(fixtureSecret), false)
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

  const search = page.getByRole('textbox', { name: '搜索账号 API key' })
  await search.fill('two@example.test')
  assert.equal(await page.getByRole('button', { name: 'one@example.test', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'two@example.test', exact: true }).waitFor()
  await search.fill('no-such-account')
  await page.getByText('没有符合筛选条件的账号', { exact: true }).waitFor()
  await search.fill('')
  await page.getByRole('combobox', { name: '筛选使用开关' }).click()
  await page.getByRole('option', { name: '已关闭', exact: true }).click()
  await page.getByRole('button', { name: 'two@example.test', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'one@example.test', exact: true }).count(), 0)
  await page.getByRole('combobox', { name: '筛选使用开关' }).click()
  await page.getByRole('option', { name: '全部开关', exact: true }).click()
  await page.getByRole('combobox', { name: '筛选调用状态' }).click()
  await page.getByRole('option', { name: 'key 无效', exact: true }).click()
  await page.getByRole('button', { name: 'three@example.test', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'one@example.test', exact: true }).count(), 0)
  await page.getByRole('combobox', { name: '筛选调用状态' }).click()
  await page.getByRole('option', { name: '全部调用状态', exact: true }).click()

  await page.getByRole('button', { name: 'one@example.test', exact: true }).click()
  const detail = page.getByRole('dialog', {
    name: '账号 API key',
    exact: true,
  })
  await detail.waitFor()
  assert.equal(requests.filter((request) => request.path.endsWith('/key')).length, 0)
  await detail.getByRole('button', { name: '查看', exact: true }).click()
  await until(
    async () => (await detail.getByLabel('官方 key 内容').innerText()) === fixtureSecret,
    'the explicit reveal shows the saved secret',
  )
  const reveals = () => requests.filter((request) => request.path.endsWith('/key') && request.method === 'GET').length
  assert.equal(reveals(), 1)
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })
  assert.equal((await page.locator('body').innerText()).includes(fixtureSecret), false)
  await page.getByRole('button', { name: 'one@example.test', exact: true }).click()
  await detail.waitFor()
  assert.equal(reveals(), 1, 'reopening the drawer does not prefetch the secret')
  assert.equal((await detail.innerText()).includes(fixtureSecret), false, 'closing clears the displayed secret')
  await detail.getByRole('button', { name: '查看', exact: true }).click()
  await until(() => reveals() === 2, 'a reopened drawer obtains the secret on demand again')
  await detail.getByRole('button', { name: '隐藏', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: path.join(output, 'mobile-detail-390.png'),
    fullPage: true,
  })
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 1440, height: 1000 })

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

  await page.getByRole('button', { name: '绑定已有 key', exact: true }).click()
  const binding = page.getByRole('dialog', {
    name: '绑定已有 key',
    exact: true,
  })
  await binding.waitFor()
  await binding.getByRole('combobox').click()
  await page.getByRole('option', { name: 'four@example.test · 账号四', exact: true }).click()
  await binding.getByLabel('官方 API key', { exact: true }).fill('sk-offline-manual-bind')
  await binding.getByRole('button', { name: '保存', exact: true }).click()
  await binding.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'four@example.test', exact: true }).waitFor()
  assert.equal(requests.filter((request) => request.method === 'PUT' && request.path.endsWith('/key')).length, 1)
  assert.equal(
    requests.some((request) => /models|responses|completions/.test(request.path)),
    false,
    'manual binding never queries models or calls inference',
  )

  empty = true
  await page.reload()
  await page.getByText('还没有已绑定的官方 key。', { exact: false }).waitFor()
  await page.screenshot({
    path: path.join(output, 'empty-state.png'),
    fullPage: true,
  })
  role = 'super'
  const listsBefore = requests.filter((request) => request.path === '/api/panel/openai-apikey').length
  await page.reload()
  await page.getByText('只有管理员可以管理账号 API key。', { exact: true }).waitFor()
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
      batch_partial_result: true,
      delete_confirmation: true,
      manual_binding_without_model_query: true,
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
