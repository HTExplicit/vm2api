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

async function openFixture(t, { view = 'proxy', api, websocket }) {
  assert.ok(process.env.UI_BROWSER_EXE, 'UI_BROWSER_EXE must point to an installed test Chromium')
  const vite = await createServer({
    configFile: false,
    root: path.join(root, 'web'),
    cacheDir: path.join(root, 'web/node_modules/.vite-proxy-kvm-fixture'),
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
  if (websocket) await context.routeWebSocket('**/api/panel/**', websocket)
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
    if (view === 'kvm' && request.method() === 'GET' && url.pathname === '/api/panel/gemini/maintenance') {
      return route.fulfill({ json: { ok: true, data: { available: false } } })
    }
    return api(route, request, url.pathname)
  })
  await context.addInitScript(() => {
    localStorage.setItem('kin_console_token', 'offline-proxy-kvm-fixture-token')
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    errors.push(error.message)
    t.diagnostic(error.message)
  })
  await page.goto(`${origin}/offline-ui?view=${view}`)
  return { page, rejectedOrigins, errors }
}

function replyToKernelInstall(route, request, installs, resultForTarget) {
  const jobId = 'offline-kernel-install'
  if (request.method() === 'POST') {
    const body = request.postDataJSON()
    assert.equal(body.background, true)
    installs.push(body)
    return route.fulfill({ status: 202, json: { ok: true, data: { job_id: jobId } } })
  }
  assert.equal(request.method(), 'GET')
  assert.equal(new URL(request.url()).searchParams.get('job_id'), jobId)
  assert.equal(installs.length, 1, 'polling does not resubmit the installation')
  const item = resultForTarget(installs[0].targets[0])
  const report = { ok: true, total: 1, ok_count: 1, failed_count: 0, items: [item] }
  return route.fulfill({ json: { ok: true, data: { state: 'completed', report } } })
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
  await page.waitForFunction(
    (id) => document.getElementById(id)?.disabled === true,
    await dialog.getByRole('radio', { name: 'HTTP', exact: true }).getAttribute('id'),
  )
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
      if (pathname === '/api/panel/crag-subscription') {
        assert.equal(role, 'admin', 'host entitlement is only queried by admins')
        return route.fulfill({ json: { ok: true, data: { ready: false, state: 'unavailable' } } })
      }
      if (pathname === '/api/panel/kernels') {
        return route.fulfill({
          json: {
            ok: true,
            data: {
              kernels: [{ id: 'crag', name: 'CRAG', paid: true, ready: true, version: '3.1.1', payload_tag: 'crag-3.1.1', release_options: [{ tag: 'crag-3.1.1', label: '标准 3.1.1' }] }],
              licenses: Object.fromEntries(vms.map((vm) => [vm.id, { valid: true, status: 'valid' }])),
              installations: {},
            },
          },
        })
      }
      assert.equal(pathname, '/api/panel/kernels/install')
      return replyToKernelInstall(route, request, installs, (target) => {
        const stopped = target.id === 'offline-stopped'
        return {
          ...target,
          ok: true,
          stopped,
          restarted: !stopped,
          status: stopped ? 'stopped' : 'running',
          schedulable: false,
        }
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
  assert.match(await dialog.innerText(), /CRAG 安装版本：crag-3\.1\.1（标准 3\.1\.1）/)
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
  assert.deepEqual(installs, [
    { background: true, targets: [{ id: 'offline-stopped', kernel: 'crag', payload_tag: 'crag-3.1.1' }] },
  ])
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

test(
  'native login waits for an explicit committed frame and never replays on disconnect',
  { timeout: 60_000 },
  async (t) => {
    const tickets = []
    const sockets = []
    const inputs = []
    const { page, rejectedOrigins, errors } = await openFixture(t, {
      view: 'login',
      websocket: (socket) => {
        const url = new URL(socket.url())
        assert.equal(url.hostname, '127.0.0.1')
        assert.equal(url.pathname, '/api/panel/vms/offline-claude/shell')
        assert.equal(url.searchParams.get('login'), '1')
        sockets.push(socket)
        socket.onMessage((message) => inputs.push(JSON.parse(String(message))))
      },
      api: async (route, request, pathname) => {
        assert.equal(pathname, '/api/panel/vms/offline-claude/shell-ticket')
        assert.equal(request.method(), 'POST')
        tickets.push(request.postDataJSON())
        return route.fulfill({
          json: {
            ok: true,
            data: {
              ticket: `offline-${tickets.length}`,
              cli_bin: '/opt/native/claude',
            },
          },
        })
      },
    })
    const trigger = page.getByRole('button', {
      name: '生成授权链接',
      exact: true,
    })
    const panel = page.getByRole('region', {
      name: 'Claude Code 授权',
      exact: true,
    })
    const commits = page.locator('output[aria-label="已确认保存次数"]')
    assert.equal(
      tickets.length,
      0,
      'viewing credentials does not open a native session'
    )
    await trigger.click()
    await panel.waitFor()
    await page.waitForFunction(() => document.body.innerText.includes('已连接'))
    assert.equal(sockets.length, 1)
    sockets[0].send(
      Buffer.from('https://claude.ai/oauth/authorize?client_id=offline&sta')
    )
    assert.equal(
      await panel.getByLabel('授权链接', { exact: true }).inputValue(),
      ''
    )
    sockets[0].send(Buffer.from('te=fixture-state\nLogin successful\n'))
    await page.waitForFunction(() =>
      document
        .querySelector('#native-auth-url')
        ?.value.endsWith('state=fixture-state')
    )
    assert.equal(
      await commits.innerText(),
      '0',
      'terminal text cannot confirm persistence'
    )
    await panel
      .getByLabel('授权码或回调链接', { exact: true })
      .fill('offline-code#fixture-state')
    await panel
      .getByRole('button', { name: '提交授权码', exact: true })
      .click()
    await page.waitForFunction(
      () => document.querySelector('#native-auth-code')?.disabled
    )
    assert.equal(
      inputs
        .filter((frame) => frame.t === 'd')
        .map((frame) => frame.d)
        .join(''),
      'offline-code#fixture-state\r'
    )
    sockets[0].close({ code: 1000, reason: 'offline fixture disconnected' })
    await panel
      .getByRole('button', { name: '重新连接并生成链接', exact: true })
      .waitFor()
    assert.equal(
      tickets.length,
      1,
      'disconnect waits for an explicit operator retry'
    )
    assert.equal(
      await panel.getByLabel('授权链接', { exact: true }).inputValue(),
      ''
    )
    assert.equal(await commits.innerText(), '0')
    await panel
      .getByRole('button', { name: '重新连接并生成链接', exact: true })
      .click()
    await page.waitForFunction(() => document.body.innerText.includes('已连接'))
    assert.equal(sockets.length, 2)
    assert.equal(tickets.length, 2)
    assert.deepEqual(tickets, [{ login: true }, { login: true }])
    sockets[1].send(JSON.stringify({ t: 'login', ok: false }))
    sockets[1].send(
      JSON.stringify({
        t: 'login',
        ok: true,
        official_cc_bootstrap: { scheduled: true },
      })
    )
    sockets[1].send(JSON.stringify({ t: 'login', ok: true }))
    await panel
      .getByText('凭证已保存并同步到槽位，可以收起此面板。', { exact: true })
      .waitFor()
    assert.equal(
      await commits.innerText(),
      '1',
      'one committed result is delivered once'
    )
    await panel.getByRole('button', { name: '完成收起', exact: true }).click()
    await panel.waitFor({ state: 'hidden' })
    await page.waitForFunction(
      () => document.activeElement?.textContent?.trim() === '生成授权链接'
    )
    assert.equal(
      inputs
        .filter((frame) => frame.t === 'd')
        .map((frame) => frame.d)
        .join(''),
      'offline-code#fixture-state\r',
      'reconnect does not replay the prior authorization code'
    )
    assert.deepEqual(rejectedOrigins, [])
    assert.deepEqual(errors, [])
  }
)

test(
  'subscription browsing keeps host activation private and does not create orders',
  { timeout: 60_000 },
  async (t) => {
    let role = 'user'
    const requests = []
    const { page, rejectedOrigins, errors } = await openFixture(t, {
      view: 'shop',
      api: async (route, request, pathname) => {
        requests.push({ pathname, method: request.method() })
        assert.equal(
          request.method(),
          'GET',
          'this browsing fixture must never mutate commerce'
        )
        const respond = (data) => route.fulfill({ json: { ok: true, data } })
        if (pathname === '/api/panel/me')
          return respond({ role, user: 'offline-buyer' })
        if (pathname === '/api/panel/crag-shop/plans')
          return respond({
            plans: [
              {
                sku: 'offline-month',
                term: '1m',
                amount_minor: 1200,
                slot_limit: 1,
                remaining: 0,
              },
            ],
            payment_methods: [],
          })
        if (pathname === '/api/panel/crag-shop/orders')
          return respond({ orders: [], next_offset: null })
        assert.equal(
          role,
          'admin',
          'tenants must not request host or activation data'
        )
        if (pathname === '/api/panel/crag-subscription')
          return respond({ ready: false, state: 'unavailable' })
        if (pathname === '/api/panel/crag-shop/activation-targets')
          return respond({ targets: [] })
        if (pathname === '/api/panel/vms') return respond({ items: [] })
        assert.fail(`unexpected API path ${pathname}`)
      },
    })
    await page
      .getByRole('heading', { level: 2, name: '订阅 CRAG', exact: true })
      .waitFor()
    await page
      .getByText('还没有订阅订单。下单后可以在这里查看支付和激活状态。', {
        exact: true,
      })
      .waitFor()
    assert.equal(
      await page.getByRole('button', { name: '手动激活', exact: true }).count(),
      0
    )
    assert.equal(
      await page
        .getByRole('heading', { name: '本机订阅', exact: true })
        .count(),
      0
    )
    await page.getByRole('button', { name: '查看订单', exact: true }).click()
    await page.waitForFunction(
      () => document.activeElement?.id === 'crag-order-history'
    )
    assert.equal(
      requests.some(
        ({ pathname }) =>
          pathname === '/api/panel/crag-subscription' ||
          pathname.endsWith('/activation-targets')
      ),
      false
    )
    role = 'admin'
    await page.reload()
    const manual = page.getByRole('button', { name: '手动激活', exact: true })
    await manual.waitFor()
    await manual.click()
    const dialog = page.getByRole('dialog', {
      name: '手动激活 CRAG',
      exact: true,
    })
    await dialog.waitFor()
    await dialog.getByText('当前没有可选槽位。', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.waitForFunction(
      () => document.activeElement?.textContent?.trim() === '手动激活'
    )
    assert.equal(
      requests.every(({ method }) => method === 'GET'),
      true,
      'opening and canceling activation sends no write'
    )
    assert.deepEqual(rejectedOrigins, [])
    assert.deepEqual(errors, [])
  }
)
test(
  'remote kernel switch is confirmed once and observed across page reload',
  { timeout: 60_000 },
  async (t) => {
    const posts = []
    let job = null
    let role = 'admin'
    const { page, rejectedOrigins, errors } = await openFixture(t, {
      view: 'engine',
      api: async (route, request, pathname) => {
        const respond = (data) => route.fulfill({ json: { ok: true, data } })
        if (pathname === '/api/panel/me')
          return respond({ role, user: 'offline-operator' })
        if (pathname.endsWith('/crag-license'))
          return respond({
            license: { valid: true, status: 'valid', kind: 'offline' },
          })
        assert.equal(pathname, '/api/panel/vms/offline-remote/kernel-switch')
        if (request.method() === 'POST') {
          posts.push(request.postDataJSON())
          job = {
            id: 'offline-job',
            vm_id: 'offline-remote',
            status: 'running',
            dataplane: 'crag',
            crag_kernel_version: 'v2',
            started_at: '2026-11-16T00:00:00Z',
            finished_at: null,
            error: null,
          }
        } else assert.equal(request.method(), 'GET')
        return respond(job)
      },
    })
    const switchButton = page.getByRole('button', {
      name: '本槽切到 CRAG v2',
      exact: true,
    })
    const dialog = page.getByRole('alertdialog')
    await switchButton.click()
    await dialog.waitFor()
    await page.waitForFunction(
      () => document.activeElement?.textContent === '取消'
    )
    assert.match(await dialog.innerText(), /VM 保持当前停机状态/)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(posts.length, 0)
    await switchButton.click()
    await dialog
      .getByRole('button', { name: '保存内核配置', exact: true })
      .click()
    await dialog.waitFor({ state: 'hidden' })
    await page
      .getByText('正在切换到 CRAG v2…', { exact: true })
      .first()
      .waitFor()
    assert.deepEqual(posts, [{ dataplane: 'crag', crag_kernel_version: 'v2' }])
    assert.equal(
      await page
        .getByRole('button', { name: '正在切换到 CRAG v2…', exact: true })
        .isDisabled(),
      true
    )
    await page.reload()
    await page
      .getByRole('button', { name: '正在切换到 CRAG v2…', exact: true })
      .waitFor()
    assert.equal(
      posts.length,
      1,
      'reopening observes the existing job without a second POST'
    )
    job = { ...job, status: 'succeeded', finished_at: '2026-11-16T00:00:01Z' }
    await page.getByText('内核切换完成', { exact: true }).waitFor()
    await page
      .getByText('本槽内核配置已切换为 CRAG v2；VM 保持停止，下次启动生效。', {
        exact: true,
      })
      .first()
      .waitFor()
    role = 'user'
    await page.reload()
    await page.getByRole('heading', { name: '推理内核', exact: true }).waitFor()
    assert.equal(
      await page
        .getByRole('button', { name: '本槽切到 CRAG v2', exact: true })
        .count(),
      0
    )
    assert.equal(posts.length, 1)
    assert.deepEqual(rejectedOrigins, [])
    assert.deepEqual(errors, [])
  }
)

test(
  "confirmed Docker CRAG reinstall pins the target for automatic subscription admission",
  {
    timeout: 60_000,
  },
  async (t) => {
    const vm = {
      id: "offline-subscription",
      name: "离线订阅槽",
      status: "stopped",
      runtime_type: "docker",
      resolved_dataplane: "crag",
      resolved_crag_kernel_version: "v2",
    };
    const payloadTag = "payload-2026.11.16-crag-3.1.2";
    const installs = [];
    const { page, rejectedOrigins, errors } = await openFixture(t, {
      view: "kvm",
      api: async (route, request, pathname) => {
        const respond = (data) => route.fulfill({ json: { ok: true, data } });
        if (pathname === "/api/panel/me") return respond({ role: "admin" });
        if (pathname === "/api/panel/dashboard") return respond({ vms: [vm] });
        if (pathname === "/api/panel/crag-subscription")
          return respond({
            ready: true,
            state: "active",
            slot_limit: 2,
            used_slots: 0,
          });
        if (pathname === "/api/panel/kernels")
          return respond({
            kernels: [
              {
                id: "crag",
                name: "CRAG",
                paid: true,
                ready: true,
                version: "3.1.2",
                payload_tag: payloadTag,
                release_options: [{ tag: payloadTag, label: "标准 3.1.2" }],
              },
            ],
            licenses: {
              [vm.id]: { valid: true, status: "valid", scope: "device" },
            },
            install_licenses: {
              [vm.id]: {
                valid: false,
                status: "invalid",
                code: "license_payload_key_mismatch",
              },
            },
            installations: {},
          });
        assert.equal(pathname, "/api/panel/kernels/install");
        return replyToKernelInstall(route, request, installs, (target) => ({
          ...target,
          ok: true,
          restarted: false,
          stopped: true,
          status: "stopped",
          version: "3.1.2",
        }));
      },
    });
    const trigger = page.getByRole("button", {
      name: "重装 离线订阅槽",
      exact: true,
    });
    const dialog = page.getByRole("alertdialog");
    await trigger.click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /CRAG 会在停机前校验授权和运行名额/);
    assert.equal(installs.length, 0);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-label") ===
        "重装 离线订阅槽",
    );
    assert.equal(installs.length, 0);
    await trigger.click();
    await dialog.getByRole("button", { name: "确认重装", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("安装完成，保持停止", { exact: true }).waitFor();
    assert.deepEqual(installs, [
      {
        background: true,
        targets: [
          { id: vm.id, kernel: "crag", payload_tag: payloadTag },
        ],
      },
    ]);
    assert.deepEqual(rejectedOrigins, []);
    assert.deepEqual(errors, []);
  },
);
