import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { WebSocketServer } from 'ws'
import { createServer } from '../web/node_modules/vite/dist/node/index.js'

// Render the real dialog with an offline API and browser transport. No account,
// external website, fingerprint profile, or remote browser is opened.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(root, 'web')
const executablePath =
  process.env.UI_BROWSER_EXE ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find((candidate) => fs.existsSync(candidate))
assert.ok(executablePath, 'set UI_BROWSER_EXE to an installed Chromium executable')

const base = '/api/panel/vms/retry-smoke/browser'
const source = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SlotBrowserDialog} from '/src/features/vm/openai-platform-browser-dialog.tsx';
import '/src/styles/index.css';
globalThis.__retryCompletions=0;
function App(){const[open,setOpen]=useState(true);return React.createElement(SlotBrowserDialog,{vmId:'retry-smoke',purpose:'platform',open,onOpenChange:setOpen,onComplete:()=>globalThis.__retryCompletions++});}
createRoot(document.getElementById('root')).render(React.createElement(App));`
const wss = new WebSocketServer({ noServer: true })
const opens = []
const wire = []
const errors = []
const externalRequests = []
let tickets = 0
let closes = 0
let connections = 0
let openMode = 'success'
let pendingOpen = null
let client, vite

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendStatus(status, message) {
  for (const ws of wss.clients)
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'status', purpose: 'platform', status, message }))
}

async function until(predicate, message) {
  const deadline = Date.now() + 5000
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message)
    await sleep(20)
  }
}

try {
  vite = await createServer({
    root: web,
    configFile: path.join(web, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'offline-platform-retry-smoke',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === '/__retry-smoke') {
              res.setHeader('Content-Type', 'text/html')
              void server
                .transformIndexHtml(
                  req.url,
                  '<html><body><div id="root"></div><script type="module" src="/__retry-smoke.tsx"></script></body></html>',
                )
                .then((html) => res.end(html))
            } else if (req.url === base + '/open' && req.method === 'POST') {
              const chunks = []
              req.on('data', (chunk) => chunks.push(chunk))
              req.on('end', () => {
                opens.push(JSON.parse(Buffer.concat(chunks).toString()))
                if (openMode === 'hold') pendingOpen = res
                else if (openMode === 'fail')
                  json(res, 502, { ok: false, error: { message: 'Offline retry request rejected' } })
                else json(res, 200, { ok: true, data: { active: true } })
              })
            } else if (req.url === base + '/close' && req.method === 'POST') {
              closes++
              json(res, 200, { ok: true, data: {} })
            } else if (req.url === '/api/panel/vms/retry-smoke/browser-ticket') {
              tickets++
              json(res, 200, {
                ok: true,
                data: { ticket: 'offline-retry', url: '/__retry-browser?ticket=offline-retry' },
              })
            } else if (req.url === base) json(res, 200, { ok: true, data: { active: true } })
            else next()
          })
        },
        resolveId(id) {
          if (id === '/__retry-smoke.tsx') return '\0retry-smoke.tsx'
        },
        load(id) {
          if (id === '\0retry-smoke.tsx') return source
        },
      },
    ],
  })
  vite.httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/__retry-browser?')) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections++
      ws.on('message', (raw) => wire.push(JSON.parse(String(raw))))
      ws.send(JSON.stringify({ type: 'status', purpose: 'platform', status: 'needs_login' }))
    })
  })
  await vite.listen()
  client = await chromium.launch({ executablePath, headless: true, args: ['--no-proxy-server'] })
  const page = await client.newPage({ viewport: { width: 781, height: 864 } })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1') return route.continue()
    externalRequests.push(url.hostname)
    return route.abort()
  })
  await page.addInitScript(() => localStorage.setItem('kin_console_token', 'offline-retry-smoke'))
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:' + vite.httpServer.address().port + '/__retry-smoke')

  const login = page.getByRole('button', { name: '登录完成，继续配置', exact: true })
  await login.waitFor({ state: 'visible' })
  await until(() => login.isEnabled(), 'login continuation becomes available')
  assert.equal(opens.length, 1)
  await login.click()
  await until(() => wire.some((input) => input.type === 'continue'), 'login uses the existing continue message')
  assert.equal(opens.length, 1, 'login continuation does not start another setup request')

  sendStatus('error', 'First setup failed')
  const retry = page.getByRole('button', { name: '重试配置', exact: true })
  await retry.waitFor({ state: 'visible' })
  assert.equal(await page.getByRole('alert').innerText(), 'First setup failed')
  openMode = 'hold'
  await retry.evaluate((button) => {
    button.click()
    button.click()
  })
  await until(() => pendingOpen !== null, 'retry calls the existing open endpoint')
  const busy = page.getByRole('button', { name: '正在配置…', exact: true })
  assert.equal(await busy.isDisabled(), true)
  assert.equal(await busy.getAttribute('aria-busy'), 'true')
  assert.equal(await page.getByRole('alert').count(), 0, 'retry clears the previous error')
  assert.equal(opens.length, 2, 'consecutive clicks submit only one retry')
  assert.deepEqual(opens[1], { purpose: 'platform' })
  assert.equal(tickets, 1, 'retry reuses the browser ticket and transport')
  assert.equal(connections, 1, 'retry does not reconnect the WebSocket')
  assert.equal(closes, 0, 'retry does not close the live browser')
  json(pendingOpen, 200, { ok: true, data: { active: true } })
  pendingOpen = null

  for (const status of ['queued', 'starting', 'opening', 'configuring']) {
    sendStatus(status)
    await until(() => busy.isDisabled(), status + ' prevents another configuration')
    assert.equal(await busy.getAttribute('aria-busy'), 'true')
  }

  sendStatus('error', 'Second setup failed')
  await retry.waitFor({ state: 'visible' })
  await until(() => retry.isEnabled(), 'failed setup can be retried again')
  openMode = 'fail'
  await retry.click()
  await until(() => opens.length === 3, 'the failed retry reaches the endpoint once')
  await until(() => retry.isEnabled(), 'a rejected retry keeps its action available')
  assert.equal(await page.getByRole('alert').innerText(), 'Offline retry request rejected')
  assert.equal(await page.getByRole('dialog').count(), 1, 'a rejected retry preserves the current window')
  assert.equal(connections, 1)
  assert.equal(tickets, 1)

  openMode = 'success'
  await retry.click()
  await until(() => opens.length === 4, 'the next retry starts without reopening the browser')
  sendStatus('configuring')
  for (const [status, label] of [
    ['awaiting_key_input', '检查创建结果'],
    ['key_save_failed', '重试保存'],
  ]) {
    sendStatus('error', 'Old error before ' + status)
    await retry.waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('alert').innerText(), 'Old error before ' + status)
    sendStatus(status)
    const action = page.getByRole('button', { name: label, exact: true })
    await action.waitFor({ state: 'visible' })
    assert.equal(await action.isEnabled(), true, status + ' permits checking the retained task')
    assert.equal(await page.getByRole('alert').count(), 0, status + ' clears the old terminal error')
    const continuesBefore = wire.filter((input) => input.type === 'continue').length
    await action.evaluate((button) => {
      button.click()
      button.click()
    })
    await until(
      () => wire.filter((input) => input.type === 'continue').length === continuesBefore + 2,
      status + ' sends checks only through the existing continue transport',
    )
    assert.equal(opens.length, 4, status + ' never POSTs another setup request')
    assert.equal(connections, 1, status + ' reuses the existing WebSocket')
    assert.equal(tickets, 1, status + ' reuses the existing browser ticket')
    assert.equal(closes, 0, status + ' preserves the current browser')
  }
  sendStatus('configuring')
  await busy.waitFor({ state: 'visible' })
  assert.equal(await busy.isDisabled(), true, 'a successful save relocks the automatic configuration')
  sendStatus('api_ready')
  const ready = page.getByRole('button', { name: 'API 配置已完成', exact: true })
  await ready.waitFor({ state: 'visible' })
  assert.equal(await ready.isDisabled(), true)
  await until(() => page.evaluate(() => globalThis.__retryCompletions === 1), 'completion refreshes the panel')
  assert.equal(await page.getByRole('alert').count(), 0)
  assert.equal(connections, 1)
  assert.equal(tickets, 1)
  assert.equal(closes, 0)
  sendStatus('error', 'Close during retry')
  await retry.waitFor({ state: 'visible' })
  openMode = 'hold'
  await retry.click()
  await until(() => pendingOpen !== null, 'the closing test holds an in-flight retry')
  assert.equal(opens.length, 5)
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(closes, 0, 'closing waits for the retry before releasing the browser')
  json(pendingOpen, 200, { ok: true, data: { active: true } })
  pendingOpen = null
  await until(() => closes === 1, 'the accepted retry is followed by exactly one browser close')
  assert.equal(connections, 1, 'closing during retry never rebuilds the WebSocket')
  assert.equal(tickets, 1)
  assert.deepEqual(externalRequests, [])
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      offline: true,
      real_dialog: true,
      viewport_width: 781,
      setup_requests: opens.length,
      transport_connections: connections,
      browser_tickets: tickets,
      login_continue: true,
      retry_double_click_single_request: true,
      configuring_disabled: true,
      retry_error_preserves_window: true,
      manual_key_checks_reuse_task: true,
      secret_save_retry_reuses_task: true,
      recovery_clears_stale_errors: true,
      completed_and_closed: true,
      close_waits_for_retry: true,
      external_requests: externalRequests.length,
      page_errors: errors.length,
    }),
  )
} finally {
  if (pendingOpen) json(pendingOpen, 503, { ok: false, error: { message: 'Offline test closed' } })
  for (const ws of wss.clients) ws.close()
  wss.close()
  await client?.close()
  await vite?.close()
}
