import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from '../web/node_modules/vite/dist/node/index.js'
import { openDatabase, closeDatabase } from '../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageLogsView } from '../src/lib/db/repos/usage-logs-view.mjs'

// Exercise the real log table and detail dialog with offline database fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.tmp', 'stream-diagnostics-ui')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-log-ui-'))
const executablePath =
  process.env.UI_BROWSER_EXE ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find((candidate) => fs.existsSync(candidate))
assert.ok(executablePath, 'set UI_BROWSER_EXE to an installed Chromium executable')
const errors = []
const externalRequests = []
let browser, vite
try {
  const db = openDatabase({ dbPath: path.join(temporary, 'logs.db') })
  const repo = new UsageLogsRepo(db)
  for (const [index, [code, state, duration, ttft]] of [
    ['ECONNRESET', 'incomplete', 23315, 22292],
    ['ECONNRESET', 'incomplete', 21554, 10247],
    ['ECONNRESET', 'incomplete', 4696, 3393],
    ['worker_timeout', 'incomplete', 180000, 1000],
    ['stream_incomplete', 'incomplete', 2000, 1000],
    ['client_cancelled', 'cancelled', 1000, 500],
    [null, 'verified', 2000, 500],
  ].entries()) {
    repo.insertSummary({
      id: `fixture-${index}`,
      request_id: `request-${index}`,
      created_at: new Date(Date.now() - index * 10000).toISOString(),
      status: 200,
      model: index === 0 ? 'gpt-6-astra' : 'gpt-6.1-sol',
      requested_model: index === 0 ? 'gpt-6-astra' : 'gpt-6.1-sol',
      sent_model: index === 0 ? 'gpt-6-astra' : 'gpt-6.1-sol',
      stream: true,
      protocol: 'openai.responses',
      path: '/v1/responses',
      duration_ms: duration,
      first_token_ms: ttft,
      final_state: state,
      error_code: code,
      error_message: code === 'ECONNRESET' ? 'aborted' : '',
      input_tokens: index === 6 ? 100 : 0,
      output_tokens: index === 6 ? 10 : 0,
      total_cost: 0,
      actual_cost: 0,
      failure_diagnostics: code
        ? {
            component: 'codex-kernel',
            phase: 'stream',
            kernelRunId: 'kernel-run-offline',
            kernelRequestId: `kernel-request-${index}`,
            lastEventType: 'response.output_text.delta',
            lastEventAgoMs: 1000,
            responseCommitted: true,
            usageState: 'missing',
          }
        : null,
    })
  }
  const payload = new UsageLogsView(db).listBatch()
  const source = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createRootRoute,createRouter,createMemoryHistory,RouterProvider} from '@tanstack/react-router';
import {TooltipProvider} from '/src/components/ui/tooltip.tsx';
import {VirtualizedLogsTable} from '/src/features/logs/virtualized-logs-table.tsx';
import {LogDetailDialog} from '/src/features/logs/log-detail/log-detail-dialog.tsx';
import '/src/styles/index.css';
function App(){const[detail,setDetail]=useState(null);return React.createElement('main',{className:'flex h-screen flex-col gap-4 bg-background p-5 text-foreground'},React.createElement('h1',{className:'text-xl font-semibold'},'请求日志 · 离线验收'),React.createElement(VirtualizedLogsTable,{filters:{},autoRefreshEnabled:false,autoRefreshIntervalMs:5000,onOpenDetail:(row,opts)=>setDetail({row,...opts})}),React.createElement(LogDetailDialog,{state:detail,onClose:()=>setDetail(null)}));}
const router=createRouter({routeTree:createRootRoute({component:App}),history:createMemoryHistory({initialEntries:['/']})});
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(TooltipProvider,null,React.createElement(RouterProvider,{router}))));`
  vite = await createServer({
    root: path.join(root, 'web'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'offline-log-failures-smoke',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === '/__log-smoke') {
              res.setHeader('Content-Type', 'text/html')
              void server
                .transformIndexHtml(
                  req.url,
                  '<html lang="zh-CN"><body><div id="root"></div><script type="module" src="/__log-smoke.tsx"></script></body></html>',
                )
                .then((html) => res.end(html))
            } else if (req.url.startsWith('/api/')) {
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  ok: true,
                  data: req.url.startsWith('/api/panel/usage-logs?') ? payload : { attempts: [] },
                }),
              )
            } else next()
          })
        },
        resolveId(id) {
          if (id === '/__log-smoke.tsx') return '\0log-smoke.tsx'
        },
        load(id) {
          if (id === '\0log-smoke.tsx') return source
        },
      },
    ],
  })
  await vite.listen()
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  await page.addInitScript(() => localStorage.setItem('kin_console_token', 'offline-log-smoke'))
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1') return route.continue()
    externalRequests.push(url.hostname)
    return route.abort()
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__log-smoke`)
  await page
    .getByRole('button', { name: /^传输中断/ })
    .first()
    .waitFor()
  fs.mkdirSync(output, { recursive: true })
  for (const dark of [false, true]) {
    await page.evaluate((enabled) => document.documentElement.classList.toggle('dark', enabled), dark)
    const theme = dark ? 'dark' : 'light'
    await page.screenshot({ path: path.join(output, `${theme}-table.png`) })
    await page
      .getByRole('button', { name: /^传输中断/ })
      .first()
      .click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('heading', { name: '请求诊断', exact: true }).scrollIntoViewIfNeeded()
    await dialog.getByRole('button', { name: '复制内核运行 ID' }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'kernel-run-offline')
    await dialog.getByRole('button', { name: '复制请求 ID' }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'request-0')
    await dialog.getByRole('button', { name: '复制内核请求 ID' }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'kernel-request-0')
    assert.ok((await dialog.innerText()).includes('0 不代表实际无消耗'))
    await page.screenshot({ path: path.join(output, `${theme}-detail.png`) })
    await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 640, height: 960 })
  await page
    .getByRole('button', { name: /^传输中断/ })
    .first()
    .scrollIntoViewIfNeeded()
  assert.ok(
    await page
      .getByRole('button', { name: /^传输中断/ })
      .first()
      .isVisible(),
  )
  await page.screenshot({ path: path.join(output, 'narrow-table.png') })
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])
  console.log(
    JSON.stringify({
      verified: true,
      fixtures: payload.logs.length,
      screenshots: output,
      clipboard: 'passed',
      externalRequests: 0,
    }),
  )
} finally {
  await browser?.close()
  await vite?.close()
  closeDatabase()
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
  fs.rmSync(temporary, { recursive: true, force: true })
}
