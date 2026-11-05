import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { WebSocketServer } from 'ws'
import { createServer } from '../web/node_modules/vite/dist/node/index.js'

// Real dialog, local panel fixtures and local WebSocket only. No account or
// official website is opened, and no browser profile is imported.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(root, 'web')
const output = process.env.UI_SMOKE_DIR || path.join(root, '.private', 'browser-close-ui-smoke')
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

const base = '/api/panel/vms/close-smoke/browser'
const source = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Toaster} from 'sonner';
import {SlotBrowserDialog} from '/src/features/vm/openai-platform-browser-dialog.tsx';
import '/src/styles/index.css';
function App(){const[open,setOpen]=useState(true);const[mounted,setMounted]=useState(true);
globalThis.__closeFixture={show:()=>setOpen(true),leave:()=>setMounted(false)};
return React.createElement(React.Fragment,null,
React.createElement(Toaster,{position:'bottom-right'}),
React.createElement('button',{onClick:()=>setOpen(true)},'打开浏览器'),
mounted?React.createElement(SlotBrowserDialog,{vmId:'close-smoke',purpose:'platform',open,onOpenChange:setOpen}):null);}
createRoot(document.getElementById('root')).render(React.createElement(App));`

const wss = new WebSocketServer({ noServer: true })
const errors = []
const externalRequests = []
let fixture, client, vite

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function closeReply(res, mode) {
  if (mode === 'fail') {
    fixture.state = {
      active: true,
      status: 'close_failed',
      purpose: 'platform',
      message: 'Offline browser cleanup failed',
    }
    json(res, 502, { ok: false, error: { code: 'browser_close_failed', message: fixture.state.message } })
  } else {
    fixture.state = {
      active: false,
      status: 'closed',
      purpose: 'platform',
      ...(mode === 'warning' ? { warning: '已关闭，但会话保存失败' } : {}),
    }
    json(res, 200, { ok: true, data: fixture.state })
  }
}

async function until(predicate, message) {
  const deadline = Date.now() + 7000
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message)
    await sleep(20)
  }
}

async function openCase({ status = 'needs_login', width = 1100 } = {}) {
  fixture = {
    state: {
      active: true,
      status,
      purpose: 'platform',
      ...(status === 'close_failed' ? { message: 'Offline browser cleanup failed' } : {}),
    },
    closes: 0,
    opens: 0,
    tickets: 0,
    gets: 0,
    mode: 'fail',
    pending: null,
  }
  const page = await client.newPage({ viewport: { width, height: 844 } })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1') return route.continue()
    externalRequests.push(url.hostname)
    return route.abort()
  })
  await page.addInitScript(() => localStorage.setItem('kin_console_token', 'offline-close-smoke'))
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:' + vite.httpServer.address().port + '/__close-smoke')
  await page.getByRole('dialog').waitFor({ state: 'visible' })
  if (status === 'close_failed')
    await page.getByRole('button', { name: '重试关闭', exact: true }).waitFor({ state: 'visible' })
  else await until(() => fixture.tickets === 1, 'browser transport becomes ready')
  return page
}

async function checkFailedDismiss(page, dismiss) {
  await dismiss()
  await until(() => fixture.closes === 1, 'dismiss sends one close request')
  await page.getByRole('button', { name: '重试关闭', exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.getByRole('dialog').count(), 1, 'failed close preserves the dialog')
  assert.match(await page.getByRole('alert').innerText(), /Offline browser cleanup failed/)
  fixture.mode = 'success'
  await page.getByRole('button', { name: '重试关闭', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(fixture.closes, 2, 'successful manual retry closes once')
  await sleep(100)
  assert.equal(fixture.closes, 2, 'successful close is not repeated by effect cleanup')
}

try {
  vite = await createServer({
    root: web,
    configFile: path.join(web, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'offline-browser-close-smoke',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === '/__close-smoke') {
              res.setHeader('Content-Type', 'text/html')
              void server
                .transformIndexHtml(
                  req.url,
                  '<html><body><div id="root"></div><script type="module" src="/__close-smoke.tsx"></script></body></html>',
                )
                .then((html) => res.end(html))
            } else if (req.url === base && req.method === 'GET') {
              fixture.gets++
              json(res, 200, { ok: true, data: fixture.state })
            } else if (req.url === base + '/open' && req.method === 'POST') {
              fixture.opens++
              json(res, 200, { ok: true, data: fixture.state })
            } else if (req.url === base + '/close' && req.method === 'POST') {
              fixture.closes++
              if (fixture.mode === 'hold') fixture.pending = res
              else closeReply(res, fixture.mode)
            } else if (req.url === '/api/panel/vms/close-smoke/browser-ticket') {
              fixture.tickets++
              json(res, 200, {
                ok: true,
                data: { ticket: 'offline-close', url: '/__close-browser?ticket=offline-close' },
              })
            } else next()
          })
        },
        resolveId(id) {
          if (id === '/__close-smoke.tsx') return '\0close-smoke.tsx'
        },
        load(id) {
          if (id === '\0close-smoke.tsx') return source
        },
      },
    ],
  })
  vite.httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/__close-browser?')) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {})
      ws.send(JSON.stringify({ type: 'status', ...fixture.state }))
    })
  })
  await vite.listen()
  client = await chromium.launch({ executablePath, headless: true, args: ['--no-proxy-server'] })

  let page = await openCase()
  await checkFailedDismiss(page, () => page.getByRole('button', { name: '关闭浏览器', exact: true }).click())
  await page.close()

  page = await openCase()
  await checkFailedDismiss(page, () => page.getByRole('button', { name: '关闭浏览器窗口', exact: true }).click())
  await page.close()

  page = await openCase()
  await checkFailedDismiss(page, () => page.keyboard.press('Escape'))
  await page.close()

  page = await openCase()
  await checkFailedDismiss(page, () => page.mouse.click(2, 2))
  await page.close()

  page = await openCase()
  fixture.mode = 'hold'
  const close = page.getByRole('button', { name: '关闭浏览器', exact: true })
  await close.evaluate((button) => {
    button.click()
    button.click()
  })
  await until(() => fixture.pending !== null, 'the close request is held')
  assert.equal(fixture.closes, 1, 'double close submits once')
  assert.equal(await page.getByRole('dialog').count(), 1, 'pending close preserves the dialog')
  await page.keyboard.press('Escape')
  await page.mouse.click(2, 2)
  assert.equal(fixture.closes, 1, 'other dismissal paths cannot duplicate the pending close')
  closeReply(fixture.pending, 'fail')
  fixture.pending = null
  await page.getByRole('button', { name: '重试关闭', exact: true }).waitFor({ state: 'visible' })
  await page.screenshot({ path: path.join(output, 'close-failed-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, 'close-failed-mobile.png'), fullPage: true })
  fixture.mode = 'success'
  await page.getByRole('button', { name: '重试关闭', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.close()

  page = await openCase()
  fixture.mode = 'warning'
  await page.getByRole('button', { name: '关闭浏览器', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByText('已关闭，但会话保存失败', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(fixture.closes, 1, 'warning is still a successful resource close')
  await page.close()

  page = await openCase({ status: 'close_failed' })
  assert.equal(fixture.opens, 0, 'reopening a failed close does not launch a browser')
  assert.equal(fixture.tickets, 0, 'reopening a failed close does not request a transport ticket')
  assert.ok(fixture.gets >= 1, 'reopening reads the current cleanup state')
  fixture.mode = 'success'
  await page.getByRole('button', { name: '重试关闭', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.close()

  page = await openCase()
  await page.evaluate(() => globalThis.__closeFixture.leave())
  await until(() => fixture.closes === 1, 'leaving the page requests resource close')
  await page.getByText(/Offline browser cleanup failed/).waitFor({ state: 'visible' })
  assert.equal(await page.getByRole('dialog').count(), 0, 'leaving does not resurrect the dialog')
  await page.close()

  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])
  console.log(
    JSON.stringify({
      offline: true,
      real_dialog: true,
      dismissal_paths: 4,
      failed_close_preserves_dialog: true,
      retry_releases_resources: true,
      duplicate_close_blocked: true,
      warning_does_not_block_close: true,
      reopen_does_not_launch: true,
      leaving_reports_failure: true,
      desktop_and_mobile: true,
      external_requests: externalRequests.length,
      page_errors: errors.length,
    }),
  )
} finally {
  if (fixture?.pending) closeReply(fixture.pending, 'fail')
  for (const ws of wss.clients) ws.close()
  wss.close()
  await client?.close()
  await vite?.close()
}
