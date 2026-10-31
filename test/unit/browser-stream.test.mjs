import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BrowserStream } from '../../src/lib/browser/browser-stream.mjs'

class Socket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  sent = []
  send(data, options) {
    this.sent.push({ data, options })
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
  input(data) {
    this.emit('message', JSON.stringify(data))
  }
  json() {
    return this.sent.filter((x) => typeof x.data === 'string').map((x) => JSON.parse(x.data))
  }
}

function fixture(t, options = {}) {
  let now = 0
  let timerId = 0
  const timers = new Map()
  const calls = { screenshots: 0, viewport: 0, resizes: 0, input: [], closed: 0 }
  const page = new EventEmitter()
  page.evaluate = async () => {
    calls.viewport++
    return { width: 1920, height: 1080 }
  }
  page.screenshot = async () => {
    calls.screenshots++
    return Buffer.from('full-image-' + calls.screenshots)
  }
  page.mouse = {
    click: async (x, y) => calls.input.push(['click', x, y]),
    move: async (x, y) => calls.input.push(['move', x, y]),
    wheel: async (x, y) => calls.input.push(['scroll', x, y]),
  }
  page.keyboard = {
    press: async (key) => calls.input.push(['key', key]),
    insertText: async (text) => calls.input.push(['text', text]),
  }
  const stream = new BrowserStream({
    page,
    now: () => now,
    setTimer(fn, delay) {
      const id = ++timerId
      timers.set(id, { fn, at: now + delay })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    async resize(_buffer, dimensions) {
      calls.resizes++
      assert.equal(dimensions.maxDimension, 1280)
      return { image: Buffer.from('small-image-' + calls.resizes), width: 1280, height: 720 }
    },
    onClose: () => calls.closed++,
    ...options,
  })
  t.after(() => stream.close())
  return {
    page,
    stream,
    timers,
    calls,
    setTime: (value) => (now = value),
    nextAt: () => Math.min(...[...timers.values()].map((x) => x.at)),
    async fire() {
      const entry = [...timers].sort(([, a], [, b]) => a.at - b.at)[0]
      assert.ok(entry, 'a capture should be scheduled')
      timers.delete(entry[0])
      now = entry[1].at
      entry[1].fn()
      for (let i = 0; i < 30 && stream.capturing; i++) await Promise.resolve()
      assert.equal(stream.capturing, false)
    },
  }
}

test('clients share one screenshot and one smooth encoding, with JSON metadata adjacent to binary', async (t) => {
  const f = fixture(t)
  const a = new Socket()
  const b = new Socket()
  const native = new Socket()
  f.stream.attach(a)
  f.stream.attach(b)
  f.stream.attach(native)
  native.input({ type: 'quality', mode: 'native' })
  await f.fire()
  assert.equal(f.calls.screenshots, 1)
  assert.equal(f.calls.resizes, 1)
  for (const ws of [a, b, native]) {
    assert.equal(ws.sent.length, 2)
    assert.equal(typeof ws.sent[0].data, 'string')
    assert.ok(Buffer.isBuffer(ws.sent[1].data))
    assert.equal(ws.sent[1].options.binary, true)
    assert.deepEqual(ws.json()[0], {
      type: 'frame',
      seq: 1,
      mime: 'image/jpeg',
      width: 1920,
      height: 1080,
      imageWidth: ws === native ? 1920 : 1280,
      imageHeight: ws === native ? 1080 : 720,
      quality: ws === native ? 'native' : 'smooth',
    })
  }
  assert.strictEqual(a.sent[1].data, b.sent[1].data)
  assert.equal(f.calls.viewport, 1)
  await f.fire()
  assert.equal(f.calls.viewport, 1, 'unchanged viewport should not be queried every frame')
  f.page.emit('domcontentloaded')
  await f.fire()
  assert.equal(f.calls.viewport, 2)
})

test('input is serialized, acknowledged and advances idle capture without exceeding 5 FPS', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  await f.fire()
  assert.equal(f.nextAt(), 1000)
  f.setTime(500)
  ws.input({ type: 'text', text: '中', seq: 1 })
  ws.input({ type: 'text', text: '文', seq: 2 })
  await f.stream.inputTail
  assert.deepEqual(f.calls.input, [
    ['text', '中'],
    ['text', '文'],
  ])
  assert.deepEqual(
    ws.json().filter((x) => x.type === 'input_ack'),
    [
      { type: 'input_ack', seq: 1 },
      { type: 'input_ack', seq: 2 },
    ],
  )
  assert.equal(f.nextAt(), 500, 'input should not wait for the idle frame deadline')
  await f.fire()
  f.setTime(501)
  ws.input({ type: 'click', x: 70, y: 80, seq: 3 })
  await f.stream.inputTail
  assert.equal(f.nextAt(), 700, 'captures remain at most 5 FPS')
})

test('mouse moves coalesce within a sequence but keep their order around click events', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  ws.input({ type: 'move', x: 1, y: 1 })
  ws.input({ type: 'move', x: 2, y: 2 })
  ws.input({ type: 'click', x: 3, y: 3 })
  ws.input({ type: 'move', x: 4, y: 4 })
  ws.input({ type: 'move', x: 5, y: 5 })
  await f.stream.inputTail
  assert.deepEqual(f.calls.input, [
    ['move', 2, 2],
    ['click', 3, 3],
    ['move', 5, 5],
  ])
})

test('backpressured clients do not accumulate old frames and resume with the latest capture', async (t) => {
  const f = fixture(t)
  const fast = new Socket()
  const slow = new Socket()
  slow.bufferedAmount = 4
  f.stream.attach(fast)
  f.stream.attach(slow)
  await f.fire()
  await f.fire()
  assert.equal(slow.sent.length, 0)
  slow.bufferedAmount = 0
  await f.fire()
  assert.equal(slow.sent.length, 2)
  assert.equal(slow.json()[0].seq, 3)
  assert.equal(slow.sent[1].data.toString(), 'small-image-3')
})

test('native mode avoids resizing and quality switches do not change the page viewport', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  ws.input({ type: 'quality', mode: 'native' })
  await f.fire()
  assert.equal(f.calls.resizes, 0)
  ws.input({ type: 'quality', mode: 'smooth' })
  await f.fire()
  assert.equal(f.calls.resizes, 1)
  assert.equal(f.calls.viewport, 1)
  assert.equal(ws.json().at(-1).width, 1920)
})

test('changed account or proxy closes the stream before screenshots and further input', async (t) => {
  const f = fixture(t, {
    assertCurrent() {
      throw new Error('proxy changed')
    },
  })
  const ws = new Socket()
  f.stream.attach(ws)
  await f.fire()
  assert.equal(f.calls.screenshots, 0)
  assert.equal(f.calls.closed, 1)
  assert.equal(ws.readyState, 3)
  assert.equal(f.timers.size, 0)
  ws.input({ type: 'text', text: 'must not send' })
  await f.stream.inputTail
  assert.deepEqual(f.calls.input, [])
})

test('closing detaches listeners and all clients without leaving an idle capture timer', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  assert.equal(f.timers.size, 1)
  f.stream.close()
  f.stream.close()
  assert.equal(f.timers.size, 0)
  assert.equal(ws.listenerCount('message'), 0)
  assert.equal(f.page.listenerCount('domcontentloaded'), 0)
  assert.equal(ws.readyState, 3)
})

test('capture stays serialized when input requests an update during an in-flight screenshot', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  let complete
  f.page.screenshot = async () => {
    f.calls.screenshots++
    await new Promise((resolve) => {
      complete = resolve
    })
    return Buffer.from('screenshot')
  }
  f.stream.attach(ws)
  const pending = f.stream.capture()
  for (let i = 0; i < 10 && !complete; i++) await Promise.resolve()
  assert.equal(f.calls.screenshots, 1)
  ws.input({ type: 'text', text: 'while capturing', seq: 1 })
  await f.stream.inputTail
  await f.stream.capture()
  assert.equal(f.calls.screenshots, 1, 'input and polling cannot start another concurrent capture')
  complete()
  await pending
  assert.equal(f.calls.screenshots, 1)
  assert.equal(f.nextAt(), 0, 'initial attach timer is harmless while a capture is already in flight')
  assert.ok(ws.json().find((x) => x.type === 'input_ack' && x.seq === 1))
})

test('a proxy change discovered by input immediately closes before the next periodic screenshot', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  await f.fire()
  f.stream.assertCurrent = () => {
    throw new Error('proxy changed')
  }
  ws.input({ type: 'click', x: 4, y: 5 })
  await f.stream.inputTail
  assert.equal(f.calls.closed, 1)
  assert.equal(f.timers.size, 0)
  assert.equal(ws.readyState, 3)
  assert.deepEqual(f.calls.input, [])
})
