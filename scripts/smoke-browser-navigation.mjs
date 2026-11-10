import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { WebSocketServer } from 'ws'
import { createServer } from '../web/node_modules/vite/dist/node/index.js'

// Exercise the real shared dialog; every API, image and socket is local.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(root, 'web')
const output = process.env.UI_SMOKE_DIR || path.resolve(root, '..', '.private', 'browser-navigation-ui')
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
const vmId = 'browser-navigation-smoke'
const base = `/api/panel/vms/${vmId}`
const source = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SlotBrowserDialog} from '/src/features/vm/openai-platform-browser-dialog.tsx';
import '/src/styles/index.css';
function App(){const[open,setOpen]=useState(true);return React.createElement(SlotBrowserDialog,{vmId:'${vmId}',...window.__fixtureProps,open,onOpenChange:setOpen,onComplete:()=>window.__completed=true});}
createRoot(document.getElementById('root')).render(React.createElement(App));`
const sockets = new Set()
const wss = new WebSocketServer({ noServer: true })
const errors = []
const external = []
const cases = []
let fixture, vite, client, frame

function navigation(patch = {}) {
  fixture.navigation = { ...fixture.navigation, ...patch }
  for (const ws of sockets) ws.send(JSON.stringify(fixture.navigation))
}

function status(patch) {
  fixture.status = { ...fixture.status, ...patch }
  for (const ws of sockets) ws.send(JSON.stringify(fixture.status))
}

async function until(predicate, message) {
  const deadline = Date.now() + 10000
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function mockApi(req, res) {
  let body = ''
  for await (const chunk of req) body += chunk
  const route = `${req.method} ${new URL(req.url, 'http://127.0.0.1').pathname}`
  fixture.requests.push({ route, body: body ? JSON.parse(body) : null })
  let data
  if (route === `GET ${base}/browser`) data = { active: fixture.active }
  else if (route === `POST ${base}/browser/open`) {
    fixture.active = true
    data = { active: true }
  } else if (route === `POST ${base}/browser/close`) {
    fixture.active = false
    data = { active: false, status: 'closed' }
  } else if (route === `POST ${base}/browser-ticket`) {
    data = { ticket: 'offline-navigation', url: '/__navigation-socket?ticket=offline-navigation' }
  } else {
    external.push(`UNMOCKED ${route}`)
    res.statusCode = 500
    data = { error: { message: route } }
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(res.statusCode === 500 ? { ok: false, ...data } : { ok: true, data }))
}

async function capture(page, name) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const box = await page.getByRole('dialog').boundingBox()
  const width = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(width.scroll <= width.viewport, `${name}: no document horizontal overflow`)
  assert.ok(box && box.x >= -1 && box.x + box.width <= width.viewport + 1, `${name}: dialog fits the viewport`)
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true })
}

async function openCase({ provider, purpose, width }) {
  const oauth = purpose === 'oauth'
  const label = provider === 'anthropic' ? 'claude' : purpose === 'platform' ? 'platform' : 'gpt'
  const authorizationUrl = oauth
    ? `https://${provider === 'anthropic' ? 'claude.com/cai' : 'auth.openai.com'}/oauth/authorize?state=offline%2Bstate&code_challenge=fixture#saved`
    : 'https://platform.openai.com/'
  fixture = {
    active: false,
    requests: [],
    wire: [],
    connections: 0,
    authorizationUrl,
    status: { type: 'status', status: oauth ? 'oauth_waiting' : 'needs_login', purpose },
    navigation: {
      type: 'navigation',
      url: authorizationUrl,
      loading: false,
      canReturnToAuthorization: oauth,
      inputLocked: false,
    },
  }
  const context = await client.newContext({ viewport: { width, height: width < 600 ? 844 : 1000 } })
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin === origin) return route.continue()
    external.push(`EXTERNAL ${url.origin}`)
    return route.abort()
  })
  await context.addInitScript(
    (props) => {
      localStorage.setItem('kin_console_token', 'offline-navigation-smoke')
      localStorage.removeItem('kin_api_base')
      window.__fixtureProps = props
    },
    { provider, purpose, ...(provider === 'anthropic' ? { flavor: 'cai' } : {}), completionMode: 'preserve_state' },
  )
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/__navigation-smoke`)
  const dialog = page.getByRole('dialog')
  const address = dialog.getByRole('textbox', { name: '浏览器地址', exact: true })
  const go = dialog.getByRole('button', { name: '前往网页', exact: true })
  const back = dialog.getByRole('button', { name: '返回当前授权页', exact: true })
  await address.waitFor({ timeout: 45000 })
  await dialog.getByRole('img').waitFor()
  await until(
    async () => (await address.inputValue()) === authorizationUrl,
    'the first navigation exposes the exact browser URL',
  )
  assert.equal(await back.count(), oauth ? 1 : 0, 'return button exists only for an active OAuth session')
  await capture(page, `${label}-${width}-address`)

  await address.focus()
  navigation({ url: 'https://redirect.example.test/focused-without-edits', loading: false })
  await until(
    async () => (await address.getAttribute('title')) === fixture.navigation.url,
    'focused clean address received redirect',
  )
  assert.equal(await address.inputValue(), authorizationUrl, 'redirect does not replace the focused address')
  await dialog.getByRole('heading').click()
  await until(
    async () => (await address.inputValue()) === fixture.navigation.url,
    'blurring a clean address reveals the current URL',
  )

  const before = fixture.wire.length
  await address.fill('javascript:alert(1)')
  await address.press('Enter')
  await dialog.getByText('请输入 http:// 或 https:// 开头的完整网址。', { exact: true }).waitFor()
  assert.equal(fixture.wire.length, before, 'invalid scheme does not reach the socket')

  const destination = 'https://mail.example.test/verify?token=offline%2Btoken&continue=%2Flogin#verification-code'
  await address.fill(destination)
  await address.press('Enter')
  await until(
    () => fixture.wire.some((message) => message.type === 'navigate' && message.url === destination),
    'Enter sends an exact navigate message',
  )
  const first = fixture.wire.find((message) => message.type === 'navigate')
  assert.equal(typeof first.seq, 'number')
  await until(() => !fixture.navigation.loading, 'fixture navigation settled')
  await until(async () => (await address.inputValue()) === destination, 'address follows submitted navigation')

  const draft = 'https://mail.example.test/second?full=unchanged%2Bvalue#draft'
  await address.fill(draft)
  navigation({ url: 'https://redirect.example.test/while-editing', loading: false })
  await until(
    async () => (await address.getAttribute('title')) === fixture.navigation.url,
    'redirect snapshot received while focused',
  )
  assert.equal(await address.inputValue(), draft, 'redirect does not replace a focused edited address')
  await dialog.getByRole('heading').click()
  navigation({ url: 'https://redirect.example.test/after-blur', loading: false })
  await until(
    async () => (await address.getAttribute('title')) === fixture.navigation.url,
    'redirect snapshot received after blur',
  )
  assert.equal(await address.inputValue(), draft, 'dirty address also survives a redirect after blur')
  await go.click()
  await until(
    () => fixture.wire.some((message) => message.type === 'navigate' && message.url === draft),
    'Go button submits the edited address',
  )
  await until(async () => await go.isEnabled(), 'navigation controls ready')

  const failure = 'https://unavailable.example.test/login?fixture=offline#attempt'
  await address.fill(failure)
  await go.click()
  await dialog.getByText('离线测试：网页暂时无法打开，请检查地址后重试。', { exact: true }).waitFor()
  assert.equal(await address.inputValue(), failure, 'failed destination remains editable')
  await capture(page, `${label}-${width}-navigation-error`)

  if (oauth) {
    await back.click()
    await until(
      () => fixture.wire.some((message) => message.type === 'return_to_authorization'),
      'return uses the existing authorization session',
    )
    await until(
      async () => (await address.inputValue()) === authorizationUrl,
      'return restores the unchanged authorization URL',
    )
    assert.equal(fixture.connections, 1, 'navigation retains one WebSocket')
    assert.equal(
      fixture.requests.filter(({ route }) => route === `POST ${base}/browser/open`).length,
      1,
      'navigation does not start a second OAuth login',
    )

    // A subsequent navigation error must not erase the credential completion.
    await address.fill(failure)
    await address.press('Enter')
    await dialog.getByText('离线测试：网页暂时无法打开，请检查地址后重试。', { exact: true }).waitFor()
    navigation({ loading: false, canReturnToAuthorization: false, inputLocked: true })
    status({ status: 'oauth_complete', result: { oauth_email: 'offline@example.test' } })
    const done = dialog.getByRole('button', { name: '完成', exact: true })
    await done.waitFor()
    assert.equal(await done.isEnabled(), true, 'navigation error does not disable OAuth completion')
    assert.equal(await back.count(), 0, 'return disappears once authorization is no longer active')
    assert.equal(await address.isDisabled(), true, 'authorization commit lock disables address input')
    await capture(page, `${label}-${width}-oauth-complete`)
    await done.click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.__completed), true)
  } else {
    navigation({ url: 'https://platform.openai.com/settings', loading: false, error: undefined })
    await until(
      async () => (await address.inputValue()) === fixture.navigation.url,
      'clean address follows a server redirect',
    )
    assert.equal(await back.count(), 0)
    await page.getByRole('button', { name: '关闭浏览器窗口', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
  }
  const commands = fixture.wire.filter(({ type }) => ['navigate', 'return_to_authorization'].includes(type))
  assert.ok(
    commands.every((message, index) => !index || message.seq > commands[index - 1].seq),
    'navigation commands keep input sequence ordering',
  )
  cases.push({
    provider,
    purpose,
    width,
    same_websocket: fixture.connections === 1,
    navigation_commands: commands.length,
  })
  await context.close()
  await until(() => sockets.size === 0, 'case socket closed')
}

try {
  vite = await createServer({
    root: web,
    configFile: path.join(web, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'offline-browser-navigation-smoke',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url.startsWith('/api/')) return void mockApi(req, res)
            if (req.url === '/__navigation-smoke') {
              res.setHeader('Content-Type', 'text/html')
              void server
                .transformIndexHtml(
                  req.url,
                  '<html><body><div id="root"></div><script type="module" src="/__navigation-smoke.tsx"></script></body></html>',
                )
                .then((html) => res.end(html))
            } else next()
          })
        },
        resolveId(id) {
          if (id === '/__navigation-smoke.tsx') return '\0navigation-smoke.tsx'
        },
        load(id) {
          if (id === '\0navigation-smoke.tsx') return source
        },
      },
    ],
  })
  vite.httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/__navigation-socket?')) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      fixture.connections++
      ws.on('close', () => sockets.delete(ws))
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw))
        if (message.type === 'quality') return
        fixture.wire.push(message)
        if (message.type === 'navigate') {
          navigation({ url: message.url, loading: true, error: undefined })
          setTimeout(
            () =>
              navigation({
                loading: false,
                ...(message.url.includes('unavailable.example.test')
                  ? { error: '离线测试：网页暂时无法打开，请检查地址后重试。' }
                  : {}),
              }),
            30,
          )
        } else if (message.type === 'return_to_authorization') {
          navigation({ url: fixture.authorizationUrl, loading: false, error: undefined })
        }
      })
      ws.send(JSON.stringify(fixture.status))
      ws.send(JSON.stringify(fixture.navigation))
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
    '<html><body style="margin:0;display:grid;place-items:center;height:100vh;background:#f5f4f0;font:18px system-ui;color:#27251f"><main><h1>Offline browser</h1><p>Same browser, same account session.</p><p>Navigation fixture only. No account connected.</p></main></body></html>',
  )
  frame = await framePage.screenshot({ type: 'jpeg', quality: 80 })
  await framePage.close()
  for (const width of [1440, 390]) {
    await openCase({ provider: 'anthropic', purpose: 'oauth', width })
    await openCase({ provider: 'openai', purpose: 'oauth', width })
    await openCase({ provider: 'openai', purpose: 'platform', width })
  }
  assert.deepEqual(errors, [], 'no uncaught page errors')
  assert.deepEqual(external, [], 'all requests are local and mocked')
  console.log(
    JSON.stringify({
      offline: true,
      real_shared_dialog: true,
      cases,
      page_errors: 0,
      external_requests: 0,
      screenshots: 16,
      output,
    }),
  )
} finally {
  for (const ws of sockets) ws.terminate()
  wss.close()
  await client?.close()
  await vite?.close()
}
