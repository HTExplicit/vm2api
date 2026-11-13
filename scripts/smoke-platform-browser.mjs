import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserStream } from '../src/lib/browser/browser-stream.mjs'
import { verifyLocalBrowserPage } from '../src/lib/browser/local-browser-fixture.mjs'
import { createBrowserFixture } from './browser-fixture.mjs'

async function completes(promise, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function blockIndexedDbUpgrade(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('fixture', 1)
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          // Keep the v1 connection alive instead of closing on versionchange.
          globalThis.fixtureHeldDatabase = open.result
          const upgrade = indexedDB.open('fixture', 2)
          globalThis.fixtureUpgrade = upgrade
          upgrade.onblocked = () => {
            globalThis.fixtureUpgradeBlocked = true
            resolve(open.result.version)
          }
          upgrade.onupgradeneeded = () => reject(new Error('the fixture upgrade must remain blocked'))
          upgrade.onerror = () => reject(upgrade.error)
        }
      }),
  )
}

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

// Run in a disposable CI container after building the public image. These
// stock Chromium checks do not claim to validate CloakBrowser fingerprints.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm2api-profile-smoke-'))
try {
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = await createBrowserFixture({ profileDir: path.join(root, attempt === 2 ? 'slot-b' : 'slot-a') })
    try {
      if (attempt === 0) assert.ok((await verifyLocalBrowserPage(session.page)).screenshotBytes > 0)
      await session.context.route('http://fixture.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<title>Browser fixture</title><p>ready</p>' }),
      )
      await session.page.goto('http://fixture.test/')
      const identity = await session.page.evaluate(() => ({
        userAgent: navigator.userAgent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        saved: localStorage.getItem('slot'),
      }))
      assert.match(identity.userAgent, /Chrom(?:e|ium)/)
      assert.equal(identity.timezone, 'America/New_York')
      assert.equal(identity.saved, attempt === 1 ? 'slot-a' : null)
      const cookie = (await session.context.cookies()).find((value) => value.name === 'slot')
      assert.equal(cookie?.value, attempt === 1 ? 'slot-a' : undefined)
      if (attempt === 0) {
        await session.context.addCookies([
          { name: 'slot', value: 'slot-a', url: 'http://fixture.test/', expires: Math.floor(Date.now() / 1000) + 3600 },
        ])
        await session.page.evaluate(async () => {
          localStorage.setItem('slot', 'slot-a')
          await new Promise((resolve, reject) => {
            const open = indexedDB.open('fixture', 1)
            open.onupgradeneeded = () => open.result.createObjectStore('state')
            open.onerror = () => reject(open.error)
            open.onsuccess = () => {
              const tx = open.result.transaction('state', 'readwrite')
              tx.objectStore('state').put('slot-a', 'slot')
              tx.oncomplete = () => {
                open.result.close()
                resolve()
              }
              tx.onerror = () => reject(tx.error)
            }
          })
        })
        await verifyBrowserInput(session.page)
        await session.page.goto('http://fixture.test/')
        assert.equal(await completes(blockIndexedDbUpgrade(session.page), 'IndexedDB upgrade did not block'), 1)
        const snapshot = await completes(session.storageState(), 'Cookie snapshot stalled behind blocked IndexedDB')
        assert.equal(snapshot.cookies.find((value) => value.name === 'slot')?.value, 'slot-a')
        assert.deepEqual(snapshot.origins, [], 'the HTTP snapshot must not export localStorage or IndexedDB')
        assert.deepEqual(
          await session.page.evaluate(() => ({
            blocked: globalThis.fixtureUpgradeBlocked,
            state: globalThis.fixtureUpgrade.readyState,
          })),
          { blocked: true, state: 'pending' },
          'Cookie export must complete without releasing the blocked upgrade',
        )
      } else if (attempt === 1) {
        const indexed = await session.page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const open = indexedDB.open('fixture')
              open.onerror = () => reject(open.error)
              open.onsuccess = () => {
                const request = open.result.transaction('state').objectStore('state').get('slot')
                request.onsuccess = () => {
                  open.result.close()
                  resolve(request.result)
                }
                request.onerror = () => reject(request.error)
              }
            }),
        )
        assert.equal(indexed, 'slot-a')
      } else {
        assert.deepEqual(
          await session.page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name)),
          [],
        )
      }
      assert.ok(await session.page.screenshot({ type: 'jpeg' }))
    } finally {
      await completes(session.close(), 'Browser close stalled behind blocked IndexedDB')
    }
  }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
console.log(
  'Stock Chromium: blocked IndexedDB permits Cookie snapshot and close; persistent storage, isolated profiles, screenshot and iframe input passed',
)
