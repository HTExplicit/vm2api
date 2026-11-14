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
const fixture = fileURLToPath(new URL('./proxy-kvm-fixture.tsx', import.meta.url)).replaceAll('\\', '/')

async function openFixture(t, { view = 'proxy', api }) {
  assert.ok(process.env.UI_BROWSER_EXE, 'UI_BROWSER_EXE must point to an installed test Chromium')
  const vite = await createServer({
    configFile: false,
    root: path.join(root, 'web'),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'offline-proxy-kvm-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (new URL(req.url, 'http://fixture').pathname !== '/offline-ui') return next()
            const html = await server.transformIndexHtml(
              '/offline-ui',
              `<!doctype html>
              <html lang="zh-CN"><head><meta charset="UTF-8"><title>Offline proxy and KVM</title></head>
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
  const context = await browser.newContext()
  const rejectedOrigins = []
  const errors = []
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) {
      rejectedOrigins.push(url.origin)
      return route.abort()
    }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    return api(route, request, url.pathname)
  })
  await context.addInitScript(() => {
    localStorage.setItem('kin_console_token', 'offline-proxy-kvm-fixture-token')
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/offline-ui?view=${view}`)
  return { page, rejectedOrigins, errors }
}

test('proxy protocols are keyboard selectable and edits preserve stored credentials', {
  timeout: 60_000,
}, async (t) => {
  const imports = []
  const edits = []
  let releaseImport
  let releaseEdit
  const pendingImport = new Promise((resolve) => {
    releaseImport = resolve
  })
  const pendingEdit = new Promise((resolve) => {
    releaseEdit = resolve
  })
  const { page, rejectedOrigins, errors } = await openFixture(t, {
    api: async (route, request, pathname) => {
      if (pathname === '/api/panel/proxies/import') {
        assert.equal(request.method(), 'POST')
        imports.push(request.postDataJSON())
        await pendingImport
        return route.fulfill({ json: { ok: true, data: { added: 2, skipped: 0 } } })
      }
      assert.equal(pathname, '/api/panel/proxies/offline-proxy')
      assert.equal(request.method(), 'PUT')
      edits.push(request.postDataJSON())
      await pendingEdit
      return route.fulfill({ json: { ok: true, data: { workers: [], egress: null } } })
    },
  })
  const panel = page.getByRole('region', { name: '添加代理', exact: true })
  const radios = panel.getByRole('radiogroup')
  const socks = radios.getByRole('radio', { name: 'SOCKS5', exact: true })
  const http = radios.getByRole('radio', { name: 'HTTP', exact: true })
  await socks.waitFor()
  assert.equal(await socks.isChecked(), true)
  await socks.focus()
  await page.keyboard.down('ArrowRight')
  await page.waitForFunction((id) => document.activeElement?.id === id, await http.getAttribute('id'))
  assert.equal(await http.isChecked(), true, 'an arrow key selects the next exclusive option')
  await page.keyboard.up('ArrowRight')
  await page.keyboard.press('Space')
  assert.equal(await http.isChecked(), true)
  const raw = 'bare.example.test:8080\nsocks5://explicit.example.test:1080'
  await panel.getByRole('textbox').fill(raw)
  assert.equal(imports.length, 0, 'selecting a protocol does not submit')
  const importing = page.waitForRequest((request) => request.url().endsWith('/proxies/import'))
  await panel.getByRole('button', { name: '导入 2 条', exact: true }).click()
  await importing
  assert.deepEqual(
    imports,
    [{ text: raw, default_scheme: 'http' }],
    'explicit schemes are preserved in the submitted text',
  )
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="radiogroup"] [role="radio"]')].every((radio) => radio.disabled),
  )
  assert.equal(await socks.isDisabled(), true)
  assert.equal(await http.isDisabled(), true)
  releaseImport()
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '')

  const openEdit = page.getByRole('button', { name: '编辑测试代理', exact: true })
  const dialog = page.getByRole('dialog', { name: '编辑代理', exact: true })
  await openEdit.click()
  await dialog.waitFor()
  const auth = dialog.getByPlaceholder('留空则不修改', { exact: true })
  assert.equal(await auth.nth(0).inputValue(), '')
  assert.equal(await auth.nth(1).inputValue(), '')
  await auth.nth(0).fill('draft-user')
  await auth.nth(1).fill('draft-password')
  await dialog.getByRole('radio', { name: 'HTTP', exact: true }).click()
  assert.equal(await auth.nth(0).inputValue(), 'draft-user')
  assert.equal(await auth.nth(1).inputValue(), 'draft-password')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.activeElement?.textContent === '编辑测试代理')
  assert.equal(edits.length, 0, 'canceling an edit makes no update request')

  await openEdit.click()
  await dialog.waitFor()
  assert.equal(await dialog.getByRole('radio', { name: 'SOCKS5', exact: true }).isChecked(), true)
  await dialog.getByRole('radio', { name: 'HTTP', exact: true }).click()
  const saving = page.waitForRequest((request) => request.url().endsWith('/proxies/offline-proxy'))
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await saving
  assert.deepEqual(edits, [{ scheme: 'http' }], 'a scheme-only edit sends no credential clearing fields')
  assert.equal(await dialog.getByRole('radio', { name: 'HTTP', exact: true }).isDisabled(), true)
  releaseEdit()
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(rejectedOrigins, [], 'the fixture attempted no non-loopback requests')
  assert.deepEqual(errors, [])
})

test('KVM CRAG reinstall confirms once and respects stopped slots and permissions', {
  timeout: 60_000,
}, async (t) => {
  const vms = [
    {
      id: 'offline-stopped',
      name: '离线停止槽',
      status: 'stopped',
      runtime_type: 'kvm',
      resolved_dataplane: 'crag',
      resolved_crag_kernel_version: 'v2',
    },
    {
      id: 'offline-running',
      name: '离线运行槽',
      status: 'running',
      runtime_type: 'kvm',
      resolved_dataplane: 'crag',
      resolved_crag_kernel_version: 'v2',
    },
  ]
  const installs = []
  let role = 'admin'
  const { page, rejectedOrigins, errors } = await openFixture(t, {
    view: 'kvm',
    api: async (route, request, pathname) => {
      if (pathname === '/api/panel/me') return route.fulfill({ json: { ok: true, data: { role } } })
      if (pathname === '/api/panel/dashboard') return route.fulfill({ json: { ok: true, data: { vms } } })
      if (pathname === '/api/panel/kernels') {
        return route.fulfill({
          json: {
            ok: true,
            data: {
              kernels: [{ id: 'crag', name: 'CRAG', paid: true, ready: true, version: '2.8.18' }],
              licenses: Object.fromEntries(vms.map((vm) => [vm.id, { valid: true, status: 'valid' }])),
              installations: {},
            },
          },
        })
      }
      assert.equal(pathname, '/api/panel/kernels/install')
      assert.equal(request.method(), 'POST')
      const body = request.postDataJSON()
      installs.push(body)
      const target = body.targets[0]
      const stopped = target.id === 'offline-stopped'
      return route.fulfill({
        json: {
          ok: true,
          data: {
            ok: true,
            total: 1,
            ok_count: 1,
            failed_count: 0,
            items: [
              {
                ...target,
                ok: true,
                stopped,
                restarted: !stopped,
                status: stopped ? 'stopped' : 'running',
                schedulable: false,
              },
            ],
          },
        },
      })
    },
  })
  const stopped = page.getByRole('button', { name: '重装 离线停止槽 的 CRAG', exact: true })
  const running = page.getByRole('button', { name: '重装 离线运行槽 的 CRAG 并重启', exact: true })
  const dialog = page.getByRole('alertdialog')
  await stopped.click()
  await dialog.waitFor()
  await page.waitForFunction(() => document.activeElement?.textContent === '取消')
  assert.match(await dialog.innerText(), /停止的槽保持停止/)
  assert.equal(installs.length, 0, 'opening a reinstall dialog does not install')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '重装 离线停止槽 的 CRAG')
  assert.equal(installs.length, 0)
  await running.click()
  await dialog.waitFor()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === '重装 离线运行槽 的 CRAG 并重启',
  )
  assert.equal(installs.length, 0, 'Cancel and Escape perform no installation')

  await stopped.click()
  const installed = page.waitForRequest((request) => request.url().endsWith('/kernels/install'))
  await dialog.getByRole('button', { name: '确认重装', exact: true }).click()
  await installed
  await dialog.waitFor({ state: 'hidden' })
  await page.getByText('安装完成，保持停止', { exact: true }).waitFor()
  assert.deepEqual(installs, [{ targets: [{ id: 'offline-stopped', kernel: 'crag' }] }])
  assert.equal(await page.getByText(/服务未确认安装后的启停状态|安装失败|重启完成/).count(), 0)
  assert.equal(await page.getByText('已完成：1 台成功', { exact: true }).count(), 1)

  role = 'user'
  await page.reload()
  await stopped.waitFor()
  assert.equal(await stopped.isDisabled(), true)
  assert.equal(await running.isDisabled(), true)
  assert.equal(installs.length, 1, 'non-admin viewing causes no installation')
  assert.deepEqual(rejectedOrigins, [], 'the fixture attempted no non-loopback requests')
  assert.deepEqual(errors, [])
})
