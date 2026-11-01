import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserStream } from '../src/lib/browser/browser-stream.mjs'
import { createPlatformBrowserSession } from '../src/lib/openai-api/platform-browser.mjs'

async function verifyBrowserInput(page) {
  await page.goto('data:text/html,<iframe style="position:absolute;left:200px;top:100px;border:0"></iframe>')
  const frame = page.frames().find((value) => value.parentFrame())
  await frame.setContent(`<button style="width:180px;height:80px" data-clicks="0" data-events=""
    onmousedown="this.dataset.down=Date.now();this.dataset.events+='mousedown,'"
    onmouseup="this.dataset.up=Date.now();this.dataset.events+='mouseup,'"
    onclick="this.dataset.clicks=Number(this.dataset.clicks)+1">Offline input target</button>`)
  const bounds = await frame.locator('button').boundingBox()
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  class Socket extends EventEmitter {
    readyState = 1
    bufferedAmount = 0
    acknowledgements = []
    send(raw) {
      if (typeof raw === 'string') {
        const value = JSON.parse(raw)
        if (value.type === 'input_ack') this.acknowledgements.push(value.seq)
      }
    }
    input(value) {
      this.emit('message', JSON.stringify(value))
    }
    close() {
      this.readyState = 3
      this.emit('close')
    }
  }
  const socket = new Socket()
  const stream = new BrowserStream({ page })
  try {
    stream.attach(socket)
    socket.input({ type: 'mouse_down', ...point, seq: 1 })
    await stream.inputTail
    await sleep(50)
    socket.input({ type: 'move', ...point, seq: 2 })
    socket.input({ type: 'mouse_up', ...point, seq: 3 })
    await stream.inputTail
    const result = await frame.locator('button').evaluate((button) => ({ ...button.dataset }))
    assert.equal(result.clicks, '1', 'a forwarded press and release must click the actual iframe button')
    assert.equal(result.events, 'mousedown,mouseup,')
    assert.ok(Number(result.up) - Number(result.down) >= 50, 'the press duration must be preserved')
    socket.input({ type: 'click', ...point, seq: 4 })
    await stream.inputTail
    assert.equal(
      await frame.locator('button').getAttribute('data-clicks'),
      '2',
      'legacy click input must still reach the button',
    )
    assert.deepEqual(socket.acknowledgements, [1, 2, 3, 4])
  } finally {
    stream.close()
  }
}

// Build-time offline launch check. No real account, website or proxy is used.
const options = { proxyUrl: 'socks5h://127.0.0.1:1' }
const deps = {
  proxyLocation: async () => ({
    ip: '198.51.100.10',
    country_code: 'US',
    timezone: 'America/New_York',
    latitude: 40.71,
    longitude: -74.01,
  }),
}
let fingerprint
let firstFingerprint
for (let attempt = 0; attempt < 3; attempt++) {
  if (attempt === 2) fingerprint = null
  const session = await createPlatformBrowserSession(
    {
      ...options,
      fingerprint,
      onFingerprint: (value) => {
        if (fingerprint) assert.deepEqual(value, fingerprint)
        fingerprint = value
        if (attempt === 0) firstFingerprint = structuredClone(value)
        if (attempt === 2) assert.notDeepEqual(value, firstFingerprint)
      },
    },
    deps,
  )
  try {
    await session.page.goto('data:text/html,<title>vm2api browser smoke</title><p>ready</p>')
    const identity = await session.page.evaluate(() => ({
      userAgent: navigator.userAgent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }))
    assert.match(identity.userAgent, /Firefox/)
    assert.equal(identity.timezone, 'America/New_York')
    assert.ok(await session.page.screenshot({ type: 'jpeg' }))
    if (attempt === 0) await verifyBrowserInput(session.page)
  } finally {
    await session.close()
  }
}
console.log(
  'Camoufox launch, fixed identity restore, independent slot identity, screenshot and actual iframe input passed',
)
