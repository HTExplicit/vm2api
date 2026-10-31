import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { BrowserStream } from '../src/lib/browser/browser-stream.mjs'
import { createPlatformBrowserSession } from '../src/lib/openai-api/platform-browser.mjs'

// Real rendering/encoding benchmark with synthetic content only. The proxy has
// no upstream listener and the sole page is data:, so no account or web request
// can leave this process. Browser assets must already be installed in the image.
const VIEWPORT = { width: 1920, height: 1080 }
const PHASES = [0, 40, 120, 220, 350, 500, 650, 710]
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#e8edf4;color:#172b46;font:18px system-ui}
#marker{position:fixed;left:0;top:0;width:64px;height:64px;background:rgb(24,165,118)}
main{max-width:1000px;margin:100px auto;padding:48px;border-radius:20px;background:white;box-shadow:0 12px 60px #8c9db544}
h1{font-size:38px;margin:0 0 16px}p{color:#5b6d86;line-height:1.6}section{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:28px 0}
article{border:1px solid #dbe3ed;background:linear-gradient(130deg,#f7fafc,#edf3fc);padding:22px;border-radius:12px;line-height:1.7}
input,button{font:inherit;padding:15px;border-radius:10px;border:1px solid #b5c6d8}input{width:65%;margin-right:10px}button{background:#124f84;color:white;cursor:pointer}
</style></head><body><div id="marker"></div><main><h1>OpenAI browser interaction benchmark</h1>
<p>Offline synthetic page. Identical browser identity, viewport, text, controls and click sequence are used by both transports.</p>
<section>${Array.from({ length: 6 }, (_, index) => `<article><strong>Account ${index + 1}</strong><br>Independent browser session<br>Organization balance $37.1234<br>Last refresh: synthetic sample</article>`).join('')}</section>
<input value="Synthetic login input: 中文 and keyboard test" aria-label="Synthetic input"><button id="toggle">Update page</button>
<p id="result">Initial state</p></main><script>
let state=0;document.querySelector('#toggle').onclick=()=>{state=1-state;
document.querySelector('#marker').style.background=state?'rgb(205,36,83)':'rgb(24,165,118)';
document.querySelector('#result').textContent='Visible state '+state;};
</script></body></html>`
const URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE)
const SESSION_DEPS = {
  proxyLocation: async () => ({
    ip: '198.51.100.10',
    country_code: 'US',
    timezone: 'America/New_York',
    latitude: 40.71,
    longitude: -74.01,
  }),
}

async function createSession(fingerprint) {
  return createPlatformBrowserSession({ proxyUrl: 'socks5h://127.0.0.1:1', fingerprint }, SESSION_DEPS)
}

function rounded(value) {
  return Math.round(value * 100) / 100
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function timed(promise, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`benchmark timed out: ${label}`)), 15_000)
    }),
  ]).finally(() => clearTimeout(timer))
}

class Receiver extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  bytes = 0
  frames = 0
  frameBytes = []
  pendingMeta = null
  first = deferred()
  samples = []
  captureInfo = () => null

  send(payload) {
    const bytes = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload)
    this.bytes += bytes
    if (typeof payload === 'string') {
      const metadata = JSON.parse(payload)
      if (metadata.type !== 'frame') return
      if (!metadata.image) {
        this.pendingMeta = { metadata, bytes }
        return
      }
      this.frame(Buffer.from(metadata.image, 'base64'), metadata, bytes)
      return
    }
    assert.ok(this.pendingMeta, 'binary JPEG must follow its frame metadata')
    const { metadata, bytes: metaBytes } = this.pendingMeta
    this.pendingMeta = null
    this.frame(payload, metadata, bytes + metaBytes)
  }

  frame(_image, metadata, bytes) {
    const arrivedAt = performance.now()
    this.frames++
    this.frameBytes.push(bytes)
    assert.equal(metadata.width, VIEWPORT.width)
    assert.equal(metadata.height, VIEWPORT.height)
    this.first.resolve(arrivedAt)
    const waiter = this.waiter
    const captured = this.captureInfo()
    // The click handler synchronously changes the synthetic page. Count only a
    // screenshot started after Playwright acknowledged that input, never a frame
    // which happened to arrive afterwards but was captured before the click.
    if (!waiter || waiter.appliedAt == null || !captured || captured.startedAt < waiter.appliedAt) return
    this.waiter = null
    waiter.ready.resolve(arrivedAt - waiter.startedAt)
  }

  applied() {
    if (this.waiter) this.waiter.appliedAt = performance.now()
  }

  expect(state) {
    const ready = deferred()
    this.waiter = { state, startedAt: performance.now(), ready }
    return timed(ready.promise, `visible state ${state}`)
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }
}

function oldStream(page, receiver) {
  let capturing = false
  let stopped = false
  const capture = async () => {
    if (capturing || stopped) return
    capturing = true
    try {
      const image = await page.screenshot({ type: 'jpeg', quality: 65 })
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      if (!stopped)
        receiver.send(
          JSON.stringify({ type: 'frame', image: image.toString('base64'), mime: 'image/jpeg', ...viewport }),
        )
    } finally {
      capturing = false
    }
  }
  const timer = setInterval(() => void capture(), 750)
  void capture()
  return {
    async click(point) {
      await page.mouse.click(point.x, point.y)
    },
    async close() {
      stopped = true
      clearInterval(timer)
      while (capturing) await sleep(10)
      receiver.close()
    },
  }
}

async function run(kind, fingerprint) {
  const launchAt = performance.now()
  const session = await createSession(fingerprint)
  let stream
  try {
    await session.page.setViewportSize(VIEWPORT)
    await session.page.goto(URL, { waitUntil: 'load' })
    await session.page.evaluate(() => document.fonts.ready)
    const browserReadyMs = performance.now() - launchAt
    const bounds = await session.page.locator('#toggle').boundingBox()
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    const receiver = new Receiver()
    const captures = []
    const screenshot = session.page.screenshot.bind(session.page)
    session.page.screenshot = async (options) => {
      const startedAt = performance.now()
      const image = await screenshot(options)
      captures.push({ startedAt, endedAt: performance.now() })
      return image
    }
    receiver.captureInfo = () => captures.at(-1)
    const startCpu = process.cpuUsage()
    const startedAt = performance.now()
    if (kind === 'old') stream = oldStream(session.page, receiver)
    else {
      const binary = new BrowserStream({ page: session.page })
      binary.attach(receiver)
      stream = {
        async click(position, index) {
          receiver.emit('message', JSON.stringify({ type: 'click', seq: index, ...position }))
          await binary.inputTail
        },
        close: () => binary.close(),
      }
    }
    const firstFrameMs = (await timed(receiver.first.promise, 'first frame')) - startedAt
    for (const [index, phase] of PHASES.entries()) {
      await sleep(phase)
      const visible = receiver.expect((index + 1) % 2)
      await stream.click(point, index)
      receiver.applied()
      receiver.samples.push(await visible)
    }
    const wallMs = performance.now() - startedAt
    const cpu = process.cpuUsage(startCpu)
    await stream.close()
    stream = null
    return {
      fingerprint: session.fingerprint,
      result: {
        browser_ready_ms: rounded(browserReadyMs),
        first_frame_ms: rounded(firstFrameMs),
        input_to_fresh_frame_ms: receiver.samples.map(rounded),
        input_to_fresh_frame_median_ms: rounded(median(receiver.samples)),
        input_to_fresh_frame_mean_ms: rounded(
          receiver.samples.reduce((sum, value) => sum + value, 0) / receiver.samples.length,
        ),
        capture_ms_median: rounded(median(captures.map((sample) => sample.endedAt - sample.startedAt))),
        frame_bytes_median: Math.round(median(receiver.frameBytes)),
        total_bytes: receiver.bytes,
        frames: receiver.frames,
        node_cpu_ms: { user: rounded(cpu.user / 1000), system: rounded(cpu.system / 1000) },
        node_cpu_percent: rounded((cpu.user + cpu.system) / 10 / wallMs),
        wall_ms: rounded(wallMs),
      },
    }
  } finally {
    await stream?.close()
    await session.close()
  }
}

const prepared = await createSession()
let fingerprint
try {
  fingerprint = prepared.fingerprint
} finally {
  await prepared.close()
}
const original = await run('old', fingerprint)
const optimized = await run('new', original.fingerprint)
assert.deepEqual(optimized.fingerprint, original.fingerprint, 'benchmark sessions must share the same saved identity')
console.log(
  JSON.stringify({
    page: 'offline-data-url',
    viewport: VIEWPORT,
    samples: PHASES.length,
    note: 'Server input to fresh JPEG ready to send; receiver does not decode or resize. No network RTT or frontend decode. Node process CPU excludes Firefox child CPU. No account, model or upstream network request.',
    old: original.result,
    optimized: optimized.result,
    improvement: {
      input_latency_percent: rounded(
        (1 - optimized.result.input_to_fresh_frame_median_ms / original.result.input_to_fresh_frame_median_ms) * 100,
      ),
      frame_bytes_percent: rounded(
        (1 - optimized.result.frame_bytes_median / original.result.frame_bytes_median) * 100,
      ),
    },
  }),
)
