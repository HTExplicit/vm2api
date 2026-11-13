import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
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
  const button = await frame.$('button')
  const bounds = await button.boundingBox()
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
    const result = await button.evaluate((element) => ({ ...element.dataset }))
    assert.equal(result.clicks, '1', 'a forwarded press and release must click the actual iframe button')
    assert.equal(result.events, 'mousedown,mouseup,')
    assert.ok(Number(result.up) - Number(result.down) >= 50, 'the press duration must be preserved')
    socket.input({ type: 'click', ...point, seq: 4 })
    await stream.inputTail
    assert.equal(
      await button.evaluate((element) => element.dataset.clicks),
      '2',
      'legacy click input must still reach the button',
    )
    assert.deepEqual(socket.acknowledgements, [1, 2, 3, 4])
  } finally {
    stream.close()
  }
}

// Actual Shard kernel, installed only into a disposable CI volume. A second
// container runs --reopen against these same synthetic profiles.
const reusableRoot = process.env.BROWSER_FIXTURE_PROFILE_ROOT
const root = reusableRoot || (await fs.mkdtemp(path.join(os.tmpdir(), 'vm2api-profile-smoke-')))
await fs.mkdir(root, { recursive: true })
const reopen = process.argv.includes('--reopen')
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex')
const baselinePath = path.join(root, 'baseline.json')
const baseline = reopen ? JSON.parse(await fs.readFile(baselinePath, 'utf8')) : {}
try {
  for (const [attempt, slot] of ['slot-a', 'slot-b', 'slot-a'].entries()) {
    const profileDir = path.join(root, slot)
    const session = await createBrowserFixture({ profileDir })
    const child = session.browser.process()
    try {
      if (attempt === 0) {
        assert.ok((await verifyLocalBrowserPage(session.page)).screenshotBytes > 0)
        assert.equal(
          await session.page.evaluate(() => {
            const gl = document.createElement('canvas').getContext('webgl2')
            if (!gl) return false
            gl.clearColor(0.25, 0.5, 0.75, 1)
            gl.clear(gl.COLOR_BUFFER_BIT)
            const pixel = new Uint8Array(4)
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
            return (
              Math.abs(pixel[0] - 64) < 10 && Math.abs(pixel[1] - 128) < 10 && pixel[3] === 255 && gl.getError() === 0
            )
          }),
          true,
          'software WebGL renders real pixels',
        )
      }
      await session.page.setRequestInterception(true)
      session.page.on('request', (request) =>
        request.url().startsWith('http://fixture.test/')
          ? request.respond({ contentType: 'text/html', body: '<title>Browser fixture</title><p>ready</p>' })
          : request.abort(),
      )
      await session.page.goto('http://fixture.test/')
      const identity = await session.page.evaluate(() => ({
        userAgent: navigator.userAgent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        saved: localStorage.getItem('slot'),
      }))
      assert.match(identity.userAgent, /Chrom(?:e|ium)/)
      assert.equal(identity.timezone, 'America/New_York')
      const existing = reopen || attempt === 2
      assert.equal(identity.saved, existing ? slot : null)
      const cookie = (await session.context.cookies()).find((value) => value.name === 'slot')
      assert.equal(cookie?.value, existing ? slot : undefined)
      const fingerprintHash = await hash(path.join(profileDir, 'fingerprint.json'))
      if (existing)
        assert.equal(fingerprintHash, baseline[slot], 'same profile keeps its fingerprint across process restarts')
      else baseline[slot] = fingerprintHash
      if (!existing) {
        await session.context.setCookie({
          name: 'slot',
          value: slot,
          url: 'http://fixture.test/',
          expires: Math.floor(Date.now() / 1000) + 3600,
        })
        await session.page.evaluate(async (slot) => {
          localStorage.setItem('slot', slot)
          await new Promise((resolve, reject) => {
            const open = indexedDB.open('fixture', 1)
            open.onupgradeneeded = () => open.result.createObjectStore('state')
            open.onerror = () => reject(open.error)
            open.onsuccess = () => {
              const tx = open.result.transaction('state', 'readwrite')
              tx.objectStore('state').put(slot, 'slot')
              tx.oncomplete = () => {
                open.result.close()
                resolve()
              }
              tx.onerror = () => reject(tx.error)
            }
          })
        }, slot)
        if (attempt === 0) await verifyBrowserInput(session.page)
        await session.page.goto('http://fixture.test/')
        assert.equal(await completes(blockIndexedDbUpgrade(session.page), 'IndexedDB upgrade did not block'), 1)
        const cookies = await completes(session.exportCookies(), 'Cookie snapshot stalled behind blocked IndexedDB')
        assert.equal(cookies.find((value) => value.name === 'slot')?.value, slot)
        assert.deepEqual(
          await session.page.evaluate(() => ({
            blocked: globalThis.fixtureUpgradeBlocked,
            state: globalThis.fixtureUpgrade.readyState,
          })),
          { blocked: true, state: 'pending' },
          'Cookie export must complete without releasing the blocked upgrade',
        )
      } else {
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
        assert.equal(indexed, slot)
      }
      assert.ok(await session.page.screenshot({ type: 'jpeg' }))
    } finally {
      await completes(session.close(), 'Browser close stalled behind blocked IndexedDB')
      assert.equal(child.exitCode, 0, 'close waits for the real browser process to exit normally')
      assert.equal(child.signalCode, null)
    }
  }
  assert.notEqual(baseline['slot-a'], baseline['slot-b'], 'separate slots have independent fingerprint seeds')
  if (!reopen) await fs.writeFile(baselinePath, JSON.stringify(baseline))
} finally {
  if (!reusableRoot) await fs.rm(root, { recursive: true, force: true })
}
console.log(
  `ShardBrowser ${reopen ? 'fresh-container reopen' : 'A/B/A'}: persistent storage, fingerprint isolation, WebGL, screenshot, iframe input and real process exit passed`,
)
