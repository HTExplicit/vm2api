import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { WebSocketServer } from 'ws'
import { createServer } from '../web/node_modules/vite/dist/node/index.js'
import { BrowserStream } from '../src/lib/browser/browser-stream.mjs'
import { createBrowserFixture } from './browser-fixture.mjs'

// Exercise the real React dialog, binary frames, WebSocket input and stock Chromium
// against an offline ordinary form. No account, website or usable proxy.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath =
  process.env.UI_BROWSER_EXE ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find((candidate) => fs.existsSync(candidate))
assert.ok(executablePath, 'set UI_BROWSER_EXE to an installed Chromium executable')
const web = path.join(root, 'web')
const base = '/api/panel/vms/input-smoke/browser'
const source = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {SlotBrowserDialog} from '/src/features/vm/openai-platform-browser-dialog.tsx';
import '/src/styles/index.css';
createRoot(document.getElementById('root')).render(React.createElement(SlotBrowserDialog,{vmId:'input-smoke',purpose:'platform',open:true,onOpenChange:()=>{}}));`
const iframe = `<button id="button" style="width:140px;height:60px" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Click target</button><input id="text" style="display:block;margin-top:30px;width:200px;height:50px"><script>document.addEventListener('mousedown',()=>document.body.dataset.downAt=String(Date.now()));document.addEventListener('mouseup',()=>document.body.dataset.held=String(Date.now()-Number(document.body.dataset.downAt)));</script>`
const html = `<html><body style="margin:0"><iframe id="form" style="position:absolute;left:500px;top:400px;width:350px;height:220px;border:0" srcdoc="${iframe.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></body></html>`
const wss = new WebSocketServer({ noServer: true })
let remote, stream, client, vite
const wire = []
const errors = []
try {
  // Keep the target and both scroll axes inside a deterministic large canvas.
  remote = await createBrowserFixture({ executablePath, viewport: { width: 1920, height: 1080 } })
  await remote.page.goto('data:text/html,' + encodeURIComponent(html))
  stream = new BrowserStream({ page: remote.page })
  vite = await createServer({
    root: web,
    configFile: path.join(web, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'offline-browser-input-smoke',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === '/__input-smoke') {
              res.setHeader('Content-Type', 'text/html')
              void server
                .transformIndexHtml(
                  req.url,
                  '<html><body><div id="root"></div><script type="module" src="/__input-smoke.tsx"></script></body></html>',
                )
                .then((html) => res.end(html))
            } else if (req.url === base || req.url.startsWith(base + '/') || req.url.includes('/browser-ticket')) {
              res.setHeader('Content-Type', 'application/json')
              const data = req.url.includes('/browser-ticket')
                ? { ticket: 'offline-smoke', url: '/__input-browser?ticket=offline-smoke' }
                : { active: true }
              res.end(JSON.stringify({ ok: true, data }))
            } else next()
          })
        },
        resolveId(id) {
          if (id === '/__input-smoke.tsx') return '\0input-smoke.tsx'
        },
        load(id) {
          if (id === '\0input-smoke.tsx') return source
        },
      },
    ],
  })
  vite.httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/__input-browser?')) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => wire.push(JSON.parse(String(raw))))
      stream.attach(ws)
    })
  })
  await vite.listen()
  client = await chromium.launch({ executablePath, headless: true, args: ['--no-proxy-server'] })
  const page = await client.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.addInitScript(() => localStorage.setItem('kin_console_token', 'offline-input-smoke'))
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  const url = 'http://127.0.0.1:' + vite.httpServer.address().port + '/__input-smoke'
  await page.goto(url)
  const image = page.getByRole('img', { name: 'OpenAI 官方登录与账号网页' })
  await image.waitFor({ state: 'visible', timeout: 45000 })
  const form = remote.page.frameLocator('#form')
  const remoteButton = form.locator('#button')
  const remoteInput = form.locator('#text')
  async function clickRemote(locator, hold = 100) {
    // Manual mouse coordinates do not get Playwright locator actionability
    // waits. Let the dialog finish reflow after viewport/quality changes.
    let previousBounds
    for (let attempt = 0; attempt < 20; attempt++) {
      const bounds = await image.boundingBox()
      if (JSON.stringify(bounds) === JSON.stringify(previousBounds)) break
      previousBounds = bounds
      await sleep(100)
    }
    const target = await locator.boundingBox()
    const dimensions = await remote.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    const viewport = page.getByRole('application')
    const imageBox = await image.boundingBox()
    const expected = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
    const click = {
      x: imageBox.x + (expected.x / dimensions.width) * imageBox.width,
      y: imageBox.y + (expected.y / dimensions.height) * imageBox.height,
    }
    const before = await viewport.evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }))
    const previousDown = await form.locator('body').evaluate(() => document.body.dataset.downAt)
    await page.mouse.move(click.x, click.y)
    await page.mouse.down()
    const deadline = Date.now() + 10000
    while ((await form.locator('body').evaluate(() => document.body.dataset.downAt)) === previousDown) {
      assert.ok(Date.now() < deadline, 'the forwarded press reaches the iframe')
      await sleep(20)
    }
    await sleep(hold)
    await page.mouse.up()
    await stream.inputTail
    await sleep(150)
    const after = await viewport.evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }))
    assert.deepEqual(after, before, 'clicking does not scroll the image to the hidden keyboard')
    const down = wire.findLast((message) => message.type === 'mouse_down')
    assert.ok(down, 'the real dialog forwards mouse press')
    assert.ok(
      Math.abs(down.x - expected.x) <= 1 && Math.abs(down.y - expected.y) <= 1,
      `the real dialog maps the displayed frame to the correct target: ${JSON.stringify({ expected, down, dimensions, imageBox })}`,
    )
    return { before, expected, sent: { x: down.x, y: down.y } }
  }
  const fit = await clickRemote(remoteButton)
  assert.equal(await form.locator('body').getAttribute('data-clicks'), '1')
  const held = await form.locator('body').evaluate(() => Number(document.body.dataset.held))
  assert.ok(held >= 50, 'remote down/up retains a real press interval')
  await clickRemote(remoteInput)
  await page.keyboard.type('hello')
  await page.getByRole('textbox', { name: '远程浏览器输入' }).evaluate((element) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '中文')
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }))
  })
  await sleep(250)
  assert.equal(await remoteInput.inputValue(), 'hello中文')
  await page.getByRole('button', { name: '流畅画面 · 切原图' }).click()
  await sleep(500)
  await page.setViewportSize({ width: 1000, height: 750 })
  await page.getByRole('button', { name: '放大网页' }).click()
  await page.getByRole('application').evaluate((element) => {
    element.scrollLeft = 300
    element.scrollTop = 250
  })
  await page.getByRole('button', { name: '原图画面 · 切流畅' }).focus()
  const scrolled = await clickRemote(remoteButton)
  assert.ok(scrolled.before.x > 0 && scrolled.before.y > 0, 'regression test really scrolls both axes')
  assert.equal(await form.locator('body').getAttribute('data-clicks'), '2')
  await page.getByRole('button', { name: '原图画面 · 切流畅' }).click()
  await sleep(400)
  const smooth = await clickRemote(remoteButton)
  assert.equal(await form.locator('body').getAttribute('data-clicks'), '3')
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      offline: true,
      real_dialog: true,
      real_iframe_clicks: 3,
      text: 'hello中文',
      held_ms: held,
      fit,
      scrolled_native: scrolled,
      scrolled_smooth: smooth,
      page_errors: errors.length,
    }),
  )
} finally {
  stream?.close()
  wss.close()
  await client?.close()
  await vite?.close()
  await remote?.close()
}
