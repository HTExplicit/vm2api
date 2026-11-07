import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { WebSocketServer } from 'ws'
import { createServer } from '../web/node_modules/vite/dist/node/index.js'

// Real import-page ancestry and browser dialog, with every API/WebSocket local.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.UI_BROWSER_EXE || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((candidate) => fs.existsSync(candidate))
assert.ok(executablePath, 'set UI_BROWSER_EXE to an installed Chromium executable')
const web = path.join(root, 'web')
const vmId = 'import-browser-smoke'
const vmBase = `/api/panel/vms/${vmId}`
const source = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createRootRoute,createRoute,createRouter,createMemoryHistory,Outlet,RouterProvider} from '@tanstack/react-router';
import {OnboardFlow} from '/src/features/import/onboard-flow.tsx';
import '/src/styles/index.css';
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}});
const rootRoute=createRootRoute({component:Outlet});
const flowRoute=createRoute({getParentRoute:()=>rootRoute,path:'/__import-smoke',component:OnboardFlow});
const detailRoute=createRoute({getParentRoute:()=>rootRoute,path:'/vm/$id',component:()=>React.createElement('p',null,'Slot detail')});
const router=createRouter({routeTree:rootRoute.addChildren([flowRoute,detailRoute]),history:createMemoryHistory({initialEntries:['/__import-smoke']})});
window.refreshDashboard=()=>queryClient.invalidateQueries({queryKey:['panel','dashboard']});
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(RouterProvider,{router})));`
const proxy = { id: 'offline-proxy', host: '192.0.2.1', port: 1080, bound_vm_ids: [vmId], status: 'healthy' }
const emptyVm = () => ({
  id: vmId, name: 'Offline GPT slot', platform: 'openai', family: 'codex',
  kernel: 'debian13', runtime_type: 'docker', status: 'stopped',
  runtime: { stopped: true }, has_token: false, can_import_credential: true,
  proxy, proxy_id: proxy.id, schedulable: false,
})
let vm = emptyVm()
let deleted = false
let browserActive = false
let dashboardReads = 0
let dashboardSavedReads = 0
const requests = []
const unexpected = []
const pageErrors = []
const sockets = new Set()
const wss = new WebSocketServer({ noServer: true })
let vite, client

function mockApi(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = `${req.method} ${url.pathname}`
  requests.push(route)
  let data
  switch (route) {
    case 'GET /api/panel/dashboard':
      dashboardReads++
      if (vm.has_token) dashboardSavedReads++
      data = { vms: deleted ? [] : [vm] }
      break
    case 'GET /api/panel/me': data = { role: 'admin', username: 'offline-admin' }; break
    case 'GET /api/panel/routing': data = { official_cc: { enabled: true } }; break
    case 'GET /api/panel/vms/create-options':
      data = { vm: { default_runtime: 'docker', memory: '1g', vcpus: 1, disk_gb: 10 }, kvm: { available: false } }
      break
    case 'GET /api/panel/cluster/nodes': data = { items: [] }; break
    case 'GET /api/panel/proxies': data = { proxies: [proxy], totals: { bind_limit: 5 } }; break
    case `GET ${vmBase}/official-cc-bootstrap`: data = { status: null }; break
    case `GET ${vmBase}/browser`: data = { active: browserActive }; break
    case `POST ${vmBase}/browser/open`: browserActive = true; data = { active: true }; break
    case `POST ${vmBase}/browser/close`: browserActive = false; data = { active: false }; break
    case `POST ${vmBase}/browser-ticket`:
      data = { ticket: 'offline-import', url: '/__import-browser?ticket=offline-import' }
      break
    case `POST ${vmBase}/start`:
      vm = { ...vm, status: 'running', runtime: { stopped: false } }
      data = { id: vmId, boot: { rust_ok: true } }
      break
    case `GET ${vmBase}/health`:
      data = { id: vmId, kernel: { codex_health: { vm_id: vmId, reachable: true, process_up: true, status: 200, healthy: true } } }
      break
    case `POST ${vmBase}/schedulable`:
      vm = { ...vm, schedulable: true }
      data = { id: vmId, schedulable: true }
      break
    case `GET ${vmBase}`: data = { vm }; break
    default:
      unexpected.push(route)
      res.statusCode = 500
      data = { error: { message: `Unmocked offline request: ${route}` } }
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(res.statusCode === 500 ? { ok: false, ...data } : { ok: true, data }))
}

async function until(predicate, message) {
  const deadline = Date.now() + 15000
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}

try {
  vite = await createServer({
    root: web,
    configFile: path.join(web, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'offline-import-browser-smoke',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url.startsWith('/api/')) return mockApi(req, res)
          if (req.url === '/__import-smoke') {
            res.setHeader('Content-Type', 'text/html')
            void server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__import-smoke.tsx"></script></body></html>').then((html) => res.end(html))
          } else next()
        })
      },
      resolveId(id) { if (id === '/__import-smoke.tsx') return '\0import-smoke.tsx' },
      load(id) { if (id === '\0import-smoke.tsx') return source },
    }],
  })
  vite.httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/__import-browser?')) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
      ws.send(JSON.stringify({ type: 'status', status: 'awaiting_login', purpose: 'oauth' }))
    })
  })
  await vite.listen()
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
  client = await chromium.launch({ executablePath, headless: true, args: ['--no-proxy-server', '--disable-background-networking'] })
  const context = await client.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    unexpected.push(`EXTERNAL ${route.request().url()}`)
    return route.abort()
  })
  await context.addInitScript(() => {
    localStorage.setItem('kin_console_token', 'offline-import-smoke')
    localStorage.removeItem('kin_api_base')
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`${origin}/__import-smoke`)
  const create = page.getByRole('button', { name: '创建空槽', exact: true })
  await create.waitFor({ timeout: 45000 })

  async function selectSlot() {
    await page.getByRole('radio', { name: /已有空槽/ }).click()
    await page.getByRole('radio', { name: /Offline GPT slot/ }).click()
    await page.getByRole('button', { name: '浏览器登录', exact: true }).waitFor()
    assert.equal(await create.count(), 0, 'selecting a slot leaves the creation form')
  }
  async function openLogin() {
    await page.getByRole('button', { name: '浏览器登录', exact: true }).click()
    await page.getByRole('dialog', { name: 'OpenAI 浏览器登录' }).waitFor()
    await until(() => sockets.size > 0, 'local browser WebSocket connected')
  }
  async function saveCredentials() {
    const readsBefore = dashboardSavedReads
    vm = { ...vm, has_token: true, email: 'offline@example.test' }
    for (const ws of sockets) ws.send(JSON.stringify({ type: 'status', status: 'oauth_complete', purpose: 'oauth', result: { oauth_email: vm.email } }))
    await until(() => dashboardSavedReads > readsBefore, 'credentials trigger a dashboard refetch')
    // Await the actual query refresh and React effects, not just the HTTP send.
    await page.evaluate(async () => {
      await window.refreshDashboard()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await page.getByRole('dialog', { name: 'OpenAI 浏览器登录' }).count(), 1, 'saved credentials retain the browser dialog')
    assert.equal(await create.count(), 0, 'saved credentials retain the selected slot')
    await page.getByRole('button', { name: '开机并完成', exact: true }).waitFor()
  }

  await selectSlot()
  await openLogin()
  await saveCredentials()
  assert.equal(requests.filter((route) => route === `POST ${vmBase}/start`).length, 0, 'saving credentials does not boot before the user completes')
  await page.getByRole('button', { name: '开机并完成', exact: true }).click()
  await page.getByRole('button', { name: '完成', exact: true }).waitFor()
  assert.deepEqual(requests.filter((route) => [
    `POST ${vmBase}/start`, `GET ${vmBase}/health`, `POST ${vmBase}/schedulable`,
  ].includes(route)), [`POST ${vmBase}/start`, `GET ${vmBase}/health`, `POST ${vmBase}/schedulable`], 'completion boots, verifies kernel, then enables scheduling')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  const detail = page.getByRole('link', { name: '打开槽位详情' })
  await detail.waitFor()
  assert.equal(await detail.getAttribute('href'), `/vm/${vmId}`)
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await page.getByText('运行中', { exact: true }).count() > 0, true)
  assert.equal(await create.count(), 0)
  await page.getByRole('button', { name: '再上线一台', exact: true }).click()
  await page.getByText('没有空槽', { exact: true }).waitFor()
  await page.getByRole('button', { name: '新建一台', exact: true }).click()
  await create.waitFor()

  // Closing after a save also keeps selection; real deletion still clears it.
  vm = emptyVm()
  await page.evaluate(() => window.refreshDashboard())
  await selectSlot()
  await openLogin()
  await saveCredentials()
  await page.getByRole('button', { name: '关闭浏览器窗口', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.equal(await create.count(), 0, 'ordinary close after save retains selection')
  await page.getByRole('button', { name: '浏览器登录', exact: true }).waitFor()
  deleted = true
  await page.evaluate(() => window.refreshDashboard())
  await page.getByText('没有空槽', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '浏览器登录', exact: true }).count(), 0, 'deleting the selected slot clears it')
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors')
  assert.deepEqual(unexpected, [], 'all API requests mocked and no external network requests')
  console.log(JSON.stringify({ offline: true, real_onboard_flow: true, real_browser_dialog: true, saved_retains_selection: true, boot_health_schedule_order: true, completed_receipt: true, restart: true, close_retains_selection: true, deletion_clears_selection: true, dashboard_reads: dashboardReads, page_errors: pageErrors.length }))
} finally {
  for (const ws of sockets) ws.terminate()
  wss.close()
  await client?.close()
  await vite?.close()
}
