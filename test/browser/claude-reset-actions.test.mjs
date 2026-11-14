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
const fixture = fileURLToPath(new URL('./claude-reset-actions-fixture.tsx', import.meta.url)).replaceAll('\\', '/')
const FABLE = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const FULL = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const vm = {
  id: 'offline-reset',
  has_token: true,
  claude_reset_credits: {
    eligible: true,
    available_count: 3,
    held_count: 3,
    credits: [
      {
        ref: FABLE,
        kind: 'fable',
        state: 'ready',
        gives_back_weekly: true,
        resets_left: 2,
        expires_at: '2026-11-17T07:59:00Z',
        clears: ['five_hour', 'seven_day_overage_included'],
      },
      {
        ref: FULL,
        kind: 'full',
        state: 'ready',
        resets_left: 1,
        expires_at: '2026-12-10T22:00:00Z',
        clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
      },
    ],
  },
}

test('Claude reset cards confirm, cancel and retry through the real UI without spending a real card', {
  timeout: 60_000,
}, async (t) => {
  assert.ok(process.env.UI_BROWSER_EXE, 'UI_BROWSER_EXE must point to an installed test Chromium')
  const vite = await createServer({
    configFile: false,
    root: path.join(root, 'web'),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'offline-reset-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url !== '/reset-cards') return next()
            const html = await server.transformIndexHtml(
              '/reset-cards',
              `<!doctype html>
              <html lang="zh-CN"><head><meta charset="UTF-8"><title>Offline reset cards</title></head>
              <body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
            )
            res.setHeader('content-type', 'text/html')
            res.end(html)
          })
        },
      },
    ],
    resolve: {
      alias: { '@': path.join(root, 'web/src') },
      dedupe: ['react', 'react-dom', '@tanstack/react-query'],
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
  const context = await browser.newContext()
  const requests = []
  const rejectedOrigins = []
  const errors = []
  let mode = 'network-error'
  let releasePending
  const pending = new Promise((resolve) => {
    releasePending = resolve
  })
  let current = structuredClone(vm)
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) {
      rejectedOrigins.push(url.origin)
      return route.abort()
    }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname === '/api/panel/vms/offline-reset' && request.method() === 'GET') {
      return route.fulfill({ json: { ok: true, data: { vm: current } } })
    }
    assert.equal(url.pathname, '/api/panel/vms/offline-reset/claude-reset/redeem')
    assert.equal(request.method(), 'POST')
    requests.push({ card: request.postDataJSON().card, key: request.headers()['idempotency-key'] })
    if (mode === 'network-error') return route.abort('failed')
    if (mode === 'pending') await pending
    if (mode === 'stale-card') {
      return route.fulfill({
        status: 409,
        json: { ok: false, error: { code: 'CLAUDE_RESET_NOT_AVAILABLE', message: '所选卡片已失效' } },
      })
    }
    const card = current.claude_reset_credits.credits.find((credit) => credit.ref === request.postDataJSON().card)
    card.resets_left--
    current.claude_reset_credits.held_count--
    current.claude_reset_credits.available_count--
    return route.fulfill({ json: { ok: true, data: { outcome: 'reset', kind: card.kind } } })
  })
  await context.addInitScript((value) => {
    window.resetFixtureVm = value
    localStorage.setItem('kin_console_token', 'offline-reset-fixture-token')
  }, vm)
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/reset-cards`)
  const fable = page.getByRole('button', { name: '使用 Fable 卡', exact: true })
  const full = page.getByRole('button', { name: '使用全量卡', exact: true })
  const dialog = page.getByRole('alertdialog')
  await fable.click()
  await dialog.waitFor()
  assert.equal(requests.length, 0, 'opening a confirmation does not redeem')
  assert.match(await dialog.innerText(), /7 天额度不清/)
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '使用 Fable 卡')
  assert.equal(requests.length, 0)

  await full.click()
  await dialog.waitFor()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '使用全量卡')
  assert.equal(requests.length, 0, 'Cancel and Escape do not redeem')

  await fable.click()
  const confirm = dialog.getByRole('button', { name: '确认使用 Fable 卡', exact: true })
  const failed = page.waitForRequest((request) => request.url().endsWith('/claude-reset/redeem'))
  await confirm.click()
  await failed
  await page.waitForFunction(() => {
    const button = document.querySelector('[role="alertdialog"] button:last-child')
    return button && !button.disabled
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].card, FABLE)
  assert.ok(requests[0].key)
  assert.equal(await dialog.count(), 1, 'a network error leaves this confirmation available for retry')

  mode = 'pending'
  const retried = page.waitForRequest((request) => request.url().endsWith('/claude-reset/redeem'))
  await confirm.dblclick()
  await retried
  await page.waitForFunction(() => document.querySelector('[role="alertdialog"] button:last-child')?.disabled)
  assert.equal(requests.length, 2, 'a second click while pending does not duplicate the request')
  assert.deepEqual(requests[1], requests[0], 'the selected card and idempotency key survive a network retry')
  assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape')
  assert.equal(await dialog.count(), 1, 'pending redemption stays visible')
  releasePending()
  await dialog.waitFor({ state: 'hidden' })

  mode = 'success'
  await fable.click()
  const next = page.waitForRequest((request) => request.url().endsWith('/claude-reset/redeem'))
  await confirm.click()
  await next
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(requests.length, 3)
  assert.equal(requests[2].card, FABLE)
  assert.notEqual(requests[2].key, requests[1].key, 'a successful operation clears its idempotency key')

  await full.click()
  mode = 'stale-card'
  const stale = page.waitForRequest((request) => request.url().endsWith('/claude-reset/redeem'))
  await dialog.getByRole('button', { name: '确认使用全量卡', exact: true }).click()
  await stale
  await page.getByText('所选卡片已失效', { exact: true }).waitFor()
  assert.equal(requests.length, 4)
  assert.equal(requests[3].card, FULL, 'a stale selection never silently changes to a different card')
  assert.equal(await dialog.count(), 1)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(rejectedOrigins, [], 'the fixture attempted no non-loopback requests')
  assert.deepEqual(errors, [])
})
