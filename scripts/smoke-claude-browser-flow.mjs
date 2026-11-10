import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { WebSocketServer } from 'ws'
import { createServer } from '../web/node_modules/vite/dist/node/index.js'

// Real import and reauthorization components, local API/WS fixtures only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(root, 'web')
const output = process.env.UI_SMOKE_DIR || path.resolve(root, '..', '.private', 'claude-browser-oauth-ui')
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

const vmId = 'claude-browser-smoke'
const vmBase = `/api/panel/vms/${vmId}`
const proxy = { id: 'offline-proxy', host: '192.0.2.1', port: 1080, bound_vm_ids: [vmId], status: 'healthy' }
const emptyVm = () => ({
  id: vmId,
  name: 'Offline Claude slot',
  platform: 'anthropic',
  family: 'claude',
  kernel: 'debian13',
  runtime_type: 'docker',
  status: 'stopped',
  runtime: { stopped: true },
  has_token: false,
  can_import_credential: true,
  proxy,
  proxy_id: proxy.id,
  schedulable: false,
})
const source = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createRootRoute,createRoute,createRouter,createMemoryHistory,Outlet,RouterProvider} from '@tanstack/react-router';
import {Toaster} from 'sonner';
import {OnboardFlow} from '/src/features/import/onboard-flow.tsx';
import {VmReauthDialog} from '/src/features/vm/vm-reauth-dialog.tsx';
import '/src/styles/index.css';
const qc=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}});
window.refreshDashboard=()=>qc.invalidateQueries({queryKey:['panel','dashboard']});
function Reauth(){const [open,setOpen]=useState(true);return React.createElement(VmReauthDialog,{vm:open?window.__fixtureVm:null,onOpenChange:setOpen});}
const rootRoute=createRootRoute({component:Outlet});
const onboard=createRoute({getParentRoute:()=>rootRoute,path:'/__claude-onboard',component:OnboardFlow});
const reauth=createRoute({getParentRoute:()=>rootRoute,path:'/__claude-reauth',component:Reauth});
const detail=createRoute({getParentRoute:()=>rootRoute,path:'/vm/$id',component:()=>React.createElement('p',null,'Slot detail')});
const router=createRouter({routeTree:rootRoute.addChildren([onboard,reauth,detail]),history:createMemoryHistory({initialEntries:[location.pathname]})});
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:qc},React.createElement(React.Fragment,null,React.createElement(Toaster),React.createElement(RouterProvider,{router}))));`

const wss = new WebSocketServer({ noServer: true })
const sockets = new Set()
const pageErrors = []
const unexpected = []
const cases = []
let fixture, vite, client, frame

async function mockApi(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = `${req.method} ${url.pathname}`
  let body = ''
  for await (const chunk of req) body += chunk
  fixture.requests.push({ route, body: body ? JSON.parse(body) : null })
  let data
  switch (route) {
    case 'GET /api/panel/me':
      data = { role: 'admin', username: 'offline-admin' }
      break
    case 'GET /api/panel/dashboard':
      fixture.dashboardReads++
      data = { vms: [fixture.vm] }
      break
    case 'GET /api/panel/vms':
      data = { items: [fixture.vm] }
      break
    case 'GET /api/panel/routing':
      data = { official_cc: { enabled: true } }
      break
    case 'GET /api/panel/vms/create-options':
      data = { vm: { default_runtime: 'docker', memory: '1g', vcpus: 1, disk_gb: 10 }, kvm: { available: false } }
      break
    case 'GET /api/panel/cluster/nodes':
      data = { items: [] }
      break
    case 'GET /api/panel/proxies':
      data = { proxies: [proxy], totals: { bind_limit: 5 } }
      break
    case `GET ${vmBase}`:
      data = { vm: fixture.vm }
      break
    case `GET ${vmBase}/official-cc-bootstrap`:
      data = { status: null }
      break
    case `GET ${vmBase}/browser`:
      data = { active: fixture.browserActive }
      break
    case `POST ${vmBase}/browser/open`:
      fixture.browserActive = true
      data = { active: true }
      break
    case `POST ${vmBase}/browser/close`:
      fixture.browserActive = false
      data = { active: false }
      break
    case `POST ${vmBase}/browser-ticket`:
      data = { ticket: 'offline-claude', url: '/__claude-browser?ticket=offline-claude' }
      break
    case `POST ${vmBase}/start`:
      fixture.vm = { ...fixture.vm, status: 'running', runtime: { stopped: false } }
      data = { vm: fixture.vm, boot: { rust_ok: true } }
      break
    case `GET ${vmBase}/health`:
      data = { id: vmId, kernel: { rust_health: { reachable: true, process_up: true, status: 200, ready_slots: 1 } } }
      break
    case `POST ${vmBase}/schedulable`:
      fixture.vm = { ...fixture.vm, schedulable: true }
      data = { id: vmId, schedulable: true }
      break
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

async function capture(page, name) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const bounds = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
  assert.ok(bounds.document <= bounds.viewport, `${name}: no horizontal document overflow`)
  const box = await page.getByRole('dialog', { name: 'Claude 浏览器登录', exact: true }).boundingBox()
  assert.ok(box && box.x >= -1 && box.x + box.width <= bounds.viewport + 1, `${name}: dialog fits viewport`)
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true })
}

async function openCase({ mode, flavor, width, status = 'stopped' }) {
  fixture = { vm: emptyVm(), browserActive: false, requests: [], dashboardReads: 0 }
  if (mode === 'reauth') {
    fixture.vm = {
      ...fixture.vm,
      status,
      runtime: { stopped: status === 'stopped' },
      has_token: true,
      email: 'offline@example.test',
      claude: { mode: 'oauth', has_access: true, has_refresh: true },
      schedule_off: true,
      schedulable: false,
    }
  }
  const context = await client.newContext({ viewport: { width, height: width < 600 ? 844 : 1000 } })
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin === origin) return route.continue()
    unexpected.push(`EXTERNAL ${url.origin}`)
    return route.abort()
  })
  await context.addInitScript((vm) => {
    localStorage.setItem('kin_console_token', 'offline-claude-smoke')
    localStorage.removeItem('kin_api_base')
    window.__fixtureVm = vm
  }, fixture.vm)
  const page = await context.newPage()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`${origin}/__claude-${mode}`)
  if (mode === 'onboard') {
    await page.getByRole('button', { name: '创建空槽', exact: true }).waitFor({ timeout: 45000 })
    await page.getByRole('radio', { name: /已有空槽/ }).click()
    await page.getByRole('radio', { name: /Offline Claude slot/ }).click()
  } else await page.getByRole('dialog', { name: /重新授权/ }).waitFor({ timeout: 45000 })

  const types = page.getByRole('tablist', { name: '凭证类型' })
  await types.getByRole('tab', { name: 'Setup Token', exact: true }).waitFor()
  assert.equal(
    await types.getByRole('tab', { name: 'Setup Token', exact: true }).getAttribute('aria-selected'),
    'true',
    'existing type default is unchanged',
  )
  assert.equal(
    await page.getByRole('button', { name: '浏览器登录', exact: true }).count(),
    0,
    'no browser entry for Setup Token',
  )
  await types.getByRole('tab', { name: 'OAuth', exact: true }).click()
  const methods = page.getByRole('tablist', { name: '导入方式' })
  assert.equal(
    await methods.getByRole('tab', { name: 'Cookie', exact: true }).getAttribute('aria-selected'),
    'true',
    'existing method default is unchanged',
  )
  assert.equal(
    await page.getByRole('button', { name: '浏览器登录', exact: true }).count(),
    0,
    'Cookie remains its own import method',
  )
  await methods.getByRole('tab', { name: flavor === 'cai' ? '授权链接' : 'Claude Code', exact: true }).click()
  await page.getByRole('button', { name: '浏览器登录', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Claude 浏览器登录', exact: true })
  await dialog.waitFor()
  await dialog.getByRole('img', { name: 'Claude 官方登录与账号网页', exact: true }).waitFor()
  await until(() => sockets.size > 0, 'local browser WebSocket connected')
  const open = fixture.requests.find((request) => request.route === `POST ${vmBase}/browser/open`)
  assert.deepEqual(open?.body, { purpose: 'oauth', flavor }, 'each button selects its own OAuth chain')
  assert.doesNotMatch(await dialog.innerText(), /OpenAI|Platform/, 'Claude dialog has only Claude actions')
  await capture(page, `${mode}-${flavor}-${width}-login`)

  const originalPower = {
    status: fixture.vm.status,
    stopped: fixture.vm.runtime.stopped,
    schedulable: fixture.vm.schedulable,
    schedule_off: fixture.vm.schedule_off,
  }
  fixture.vm = {
    ...fixture.vm,
    has_token: true,
    email: 'offline@example.test',
    claude: { mode: 'oauth', has_access: true, has_refresh: true },
  }
  for (const ws of sockets)
    ws.send(
      JSON.stringify({
        type: 'status',
        status: 'oauth_complete',
        purpose: 'oauth',
        result: {
          oauth_email: fixture.vm.email,
          official_cc_bootstrap: { scheduled: false, reason: 'credential_edit' },
        },
      }),
    )
  const complete = dialog.getByRole('button', { name: '完成', exact: true })
  if (mode === 'onboard') {
    const start = dialog.getByRole('button', { name: '开机并完成', exact: true })
    await start.waitFor()
    assert.equal(
      fixture.requests.filter(({ route }) => route === `POST ${vmBase}/start`).length,
      0,
      'saving does not start the slot',
    )
    assert.equal(
      await page.getByRole('dialog', { name: 'Claude 浏览器登录', exact: true }).count(),
      1,
      'saving retains selected slot and dialog',
    )
    await start.click()
    await complete.waitFor()
    assert.deepEqual(
      fixture.requests
        .map(({ route }) => route)
        .filter((route) =>
          [`POST ${vmBase}/start`, `GET ${vmBase}/health`, `POST ${vmBase}/schedulable`].includes(route),
        ),
      [`POST ${vmBase}/start`, `GET ${vmBase}/health`, `POST ${vmBase}/schedulable`],
      'new slot starts, checks Claude health, then enables scheduling',
    )
  } else {
    await complete.waitFor()
    assert.equal(
      await dialog.getByRole('button', { name: '开机并完成', exact: true }).count(),
      0,
      'reauthorization does not ask to power on',
    )
    assert.deepEqual(
      {
        status: fixture.vm.status,
        stopped: fixture.vm.runtime.stopped,
        schedulable: fixture.vm.schedulable,
        schedule_off: fixture.vm.schedule_off,
      },
      originalPower,
      'reauthorization preserves power and scheduling',
    )
  }
  assert.equal(await dialog.getByRole('button', { name: /Platform/ }).count(), 0)
  await capture(page, `${mode}-${flavor}-${width}-saved`)
  await complete.click()
  await dialog.waitFor({ state: 'detached' })
  if (mode === 'onboard') {
    await page.getByRole('link', { name: '打开槽位详情' }).waitFor()
    assert.equal(
      await page.getByText(/官方初装未启动/).count(),
      0,
      'browser completion does not enter initial setup pending',
    )
    await page.getByText('Claude 浏览器登录已完成，内核已就绪并开启调度。', { exact: true }).waitFor()
    assert.equal(
      await page.getByRole('button', { name: /重试初装/ }).count(),
      0,
      'completed browser login does not offer model bootstrap',
    )
    await page.screenshot({ path: path.join(output, `${mode}-${flavor}-${width}-complete.png`), fullPage: true })
  } else {
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    assert.equal(
      fixture.requests.filter(({ route }) => /\/(start|stop|schedulable|health)$/.test(route)).length,
      0,
      'reauthorization has no power, scheduling, or model health action',
    )
  }
  assert.equal(
    fixture.requests.filter(({ route }) => route === `POST ${vmBase}/official-cc-bootstrap`).length,
    0,
    'browser completion never runs the model bootstrap',
  )
  cases.push({ mode, flavor, width, preserved_status: mode === 'reauth' ? status : null })
  await context.close()
  await until(() => sockets.size === 0, 'case WebSocket closed')
}

try {
  vite = await createServer({
    root: web,
    configFile: path.join(web, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'offline-claude-browser-smoke',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url.startsWith('/api/')) return void mockApi(req, res)
            if (['/__claude-onboard', '/__claude-reauth'].includes(req.url)) {
              res.setHeader('Content-Type', 'text/html')
              void server
                .transformIndexHtml(
                  req.url,
                  '<html><body><div id="root"></div><script type="module" src="/__claude-smoke.tsx"></script></body></html>',
                )
                .then((html) => res.end(html))
            } else next()
          })
        },
        resolveId(id) {
          if (id === '/__claude-smoke.tsx') return '\0claude-smoke.tsx'
        },
        load(id) {
          if (id === '\0claude-smoke.tsx') return source
        },
      },
    ],
  })
  vite.httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/__claude-browser?')) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
      ws.send(JSON.stringify({ type: 'status', status: 'oauth_waiting', purpose: 'oauth' }))
      ws.send(
        JSON.stringify({
          type: 'frame',
          seq: 1,
          mime: 'image/jpeg',
          width: 960,
          height: 540,
          imageWidth: 960,
          imageHeight: 540,
          quality: 'smooth',
        }),
      )
      ws.send(frame)
    })
  })
  await vite.listen()
  client = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-proxy-server', '--disable-background-networking'],
  })
  const framePage = await client.newPage({ viewport: { width: 960, height: 540 } })
  await framePage.setContent(
    '<html><body style="margin:0;background:#f6f5f1;color:#25241f;font:18px system-ui;display:grid;place-items:center;height:100vh"><main style="width:360px"><h1 style="font-size:32px">Claude</h1><p>Offline authorization fixture</p><label>Email address<input style="display:block;box-sizing:border-box;width:100%;height:44px;margin:12px 0;border:1px solid #c8c5bd;border-radius:6px" value="offline@example.test"></label><button style="width:100%;height:44px;border:0;border-radius:6px;background:#c96547;color:white;font:inherit">Continue</button><p style="font-size:13px;color:#666">Local test page. No account is connected.</p></main></body></html>',
  )
  frame = await framePage.screenshot({ type: 'jpeg', quality: 80 })
  await framePage.close()
  await openCase({ mode: 'onboard', flavor: 'cai', width: 1440 })
  await openCase({ mode: 'onboard', flavor: 'claude_code', width: 390 })
  await openCase({ mode: 'reauth', flavor: 'cai', width: 390, status: 'stopped' })
  await openCase({ mode: 'reauth', flavor: 'claude_code', width: 1440, status: 'running' })
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors')
  assert.deepEqual(unexpected, [], 'all HTTP and WebSocket traffic is local and mocked')
  console.log(
    JSON.stringify({
      offline: true,
      real_onboard_flow: true,
      real_reauth_dialog: true,
      dual_oauth: true,
      cases,
      screenshots: 10,
      output,
      page_errors: 0,
      external_requests: 0,
    }),
  )
} finally {
  for (const ws of sockets) ws.terminate()
  wss.close()
  await client?.close()
  await vite?.close()
}
