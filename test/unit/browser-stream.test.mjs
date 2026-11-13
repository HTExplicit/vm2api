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
  let url = 'https://claude.com/login'
  const mainFrame = {}
  page.url = () => url
  page.mainFrame = () => mainFrame
  page.goto = async (next, options) => {
    calls.input.push(['goto', next, options])
    url = next
    page.emit('framenavigated', mainFrame)
    page.emit('domcontentloaded')
  }
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
    down: async ({ button }) => calls.input.push(['down', button]),
    up: async ({ button }) => calls.input.push(['up', button]),
    move: async (x, y) => calls.input.push(['move', x, y]),
    wheel: async ({ deltaX, deltaY }) => calls.input.push(['scroll', deltaX, deltaY]),
  }
  page.keyboard = {
    press: async (key) => calls.input.push(['key', key]),
    sendCharacter: async (text) => calls.input.push(['text', text]),
    down: async (key) => calls.input.push(['key_down', key]),
    up: async (key) => calls.input.push(['key_up', key]),
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
    measure: async () => ({ width: 1920, height: 1080 }),
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
    assert.equal(ws.sent.length, 3)
    assert.equal(typeof ws.sent[1].data, 'string')
    assert.ok(Buffer.isBuffer(ws.sent[2].data))
    assert.equal(ws.sent[2].options.binary, true)
    assert.deepEqual(ws.json()[1], {
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
  assert.strictEqual(a.sent[2].data, b.sent[2].data)
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

test('mouse press, drag and release keep their order and request a fresh frame', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  await f.fire()
  f.setTime(500)
  ws.input({ type: 'mouse_down', x: 10, y: 20, seq: 1 })
  ws.input({ type: 'move', x: 14, y: 24, seq: 2 })
  ws.input({ type: 'move', x: 18, y: 28, seq: 3 })
  ws.input({ type: 'mouse_up', x: 20, y: 30, seq: 4 })
  await f.stream.inputTail
  assert.deepEqual(f.calls.input, [
    ['move', 10, 20],
    ['down', 'left'],
    ['move', 18, 28],
    ['move', 20, 30],
    ['up', 'left'],
  ])
  assert.deepEqual(
    ws
      .json()
      .filter((x) => x.type === 'input_ack')
      .map((x) => x.seq),
    [1, 3, 4],
  )
  assert.equal(f.nextAt(), 500, 'press and release should advance the next frame')
})

test('mouse press and release preserve the requested button', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  for (const button of ['left', 'middle', 'right']) {
    ws.input({ type: 'mouse_down', x: 12, y: 34, button })
    ws.input({ type: 'mouse_up', x: 12, y: 34, button })
  }
  await f.stream.inputTail
  assert.deepEqual(
    f.calls.input.filter(([type]) => type !== 'move'),
    [
      ['down', 'left'],
      ['up', 'left'],
      ['down', 'middle'],
      ['up', 'middle'],
      ['down', 'right'],
      ['up', 'right'],
    ],
  )
})

test('disconnect releases a held button after its in-flight press has finished', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  let finishPress
  const pressed = new Promise((resolve) => {
    f.page.mouse.down = async ({ button }) => {
      f.calls.input.push(['down', button])
      await new Promise((finish) => {
        finishPress = finish
        resolve()
      })
    }
  })
  f.stream.attach(ws)
  ws.input({ type: 'mouse_down', x: 12, y: 34, button: 'right' })
  await pressed
  ws.close()
  const reconnect = new Socket()
  f.stream.attach(reconnect)
  finishPress()
  await f.stream.inputTail
  assert.deepEqual(f.calls.input, [
    ['move', 12, 34],
    ['down', 'right'],
    ['up', 'right'],
  ])
  assert.equal(f.stream.closed, false, 'disconnect should retain the browser for a reconnect')
})

test('disconnect does not release a button that was already released', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  ws.input({ type: 'mouse_down', x: 12, y: 34 })
  ws.input({ type: 'mouse_up', x: 12, y: 34 })
  await f.stream.inputTail
  ws.close()
  await f.stream.inputTail
  assert.deepEqual(
    f.calls.input.filter(([type]) => type === 'up'),
    [['up', 'left']],
  )
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
  assert.equal(slow.sent.length, 1)
  slow.bufferedAmount = 0
  await f.fire()
  assert.equal(slow.sent.length, 3)
  assert.equal(slow.json()[1].seq, 3)
  assert.equal(slow.sent[2].data.toString(), 'small-image-3')
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
  assert.equal(f.page.listenerCount('framenavigated'), 0)
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
  assert.equal(f.nextAt(), 200, 'the input update is retained for a fresh frame after the current capture')
  assert.ok(ws.json().find((x) => x.type === 'input_ack' && x.seq === 1))
})

test('slow captures leave a full quiet second instead of starting catch-up screenshots', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  f.page.screenshot = async () => {
    f.calls.screenshots++
    f.setTime(650)
    return Buffer.from('slow-image')
  }
  await f.fire()
  assert.equal(f.nextAt(), 1650)
  assert.equal(f.calls.screenshots, 1)
})

test('pending input takes priority over a scheduled screenshot and requests one frame when complete', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  let finish
  f.stream.attach(ws)
  await f.fire()
  f.page.keyboard.sendCharacter = async () =>
    new Promise((resolve) => {
      finish = resolve
    })
  ws.input({ type: 'text', text: 'typing' })
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve()
  assert.equal(f.timers.size, 0)
  await f.stream.capture()
  assert.equal(f.calls.screenshots, 1)
  f.setTime(550)
  finish()
  await f.stream.inputTail
  assert.equal(f.nextAt(), 550)
  await f.fire()
  assert.equal(f.calls.screenshots, 2)
  assert.equal(f.nextAt(), 1550, 'one input does not start a sustained screenshot burst')
})

test('mouse motion alone does not trigger repeated screenshots', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  await f.fire()
  f.setTime(300)
  ws.input({ type: 'move', x: 30, y: 40 })
  await f.stream.inputTail
  assert.deepEqual(f.calls.input, [['move', 30, 40]])
  assert.equal(f.nextAt(), 1300)
  assert.equal(f.calls.screenshots, 1)
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

test('attach and main-frame redirects report the current address without exposing subframe URLs', async (t) => {
  let canReturn = true
  let locked = false
  const f = fixture(t, {
    canReturnToAuthorization: () => canReturn,
    isInputLocked: () => locked,
  })
  const ws = new Socket()
  f.stream.attach(ws)
  assert.deepEqual(ws.json()[0], {
    type: 'navigation',
    url: 'https://claude.com/login',
    loading: false,
    canReturnToAuthorization: true,
    inputLocked: false,
  })
  f.page.emit('framenavigated', { url: () => 'https://iframe.example.test/' })
  assert.equal(ws.json().length, 1)
  f.page.url = () => 'https://claude.com/login/verify?flow=existing'
  f.page.emit('framenavigated', f.page.mainFrame())
  assert.equal(ws.json().at(-1).url, 'https://claude.com/login/verify?flow=existing')
  canReturn = false
  locked = true
  f.stream.sendNavigation()
  assert.equal(ws.json().at(-1).canReturnToAuthorization, false)
  assert.equal(ws.json().at(-1).inputLocked, true)
  const reconnect = new Socket()
  f.stream.attach(reconnect)
  assert.deepEqual(reconnect.json()[0], ws.json().at(-1))
})

test('mail-link navigation preserves the full URL and stays in the input queue and current page', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  const url = 'https://claude.com/login/verify?token=a%2Bb%3D&return_to=%2Fcai%2Foauth%2Fauthorize#continue'
  ws.input({ type: 'text', text: 'before', seq: 1 })
  ws.input({ type: 'navigate', url: `  ${url}  `, seq: 2 })
  ws.input({ type: 'key', key: 'Tab', seq: 3 })
  await f.stream.inputTail
  assert.deepEqual(f.calls.input, [
    ['text', 'before'],
    ['goto', url, { waitUntil: 'domcontentloaded', timeout: 45_000 }],
    ['key', 'Tab'],
  ])
  const navigation = ws.json().filter((item) => item.type === 'navigation')
  assert.ok(navigation.some((item) => item.loading === true))
  assert.deepEqual(navigation.at(-1), {
    type: 'navigation',
    url,
    loading: false,
    canReturnToAuthorization: false,
    inputLocked: false,
  })
  assert.deepEqual(
    ws
      .json()
      .filter((item) => item.type === 'input_ack')
      .map((item) => item.seq),
    [1, 2, 3],
  )
  assert.equal(
    ws.json().some((item) => item.type === 'status'),
    false,
  )
})

test('WebSocket close interrupts a pending navigation before later queued input can execute', async (t) => {
  let f, rejectNavigation, started
  let navigationSettled = false
  let closedDuringNavigation = false
  const navigating = new Promise((resolve) => {
    started = resolve
  })
  f = fixture(t, {
    onClose() {
      closedDuringNavigation = !navigationSettled
      f.calls.closed++
      f.stream.close()
      rejectNavigation(Error('browser closed during navigation'))
    },
  })
  f.page.goto = async () => {
    started()
    try {
      await new Promise((_, reject) => {
        rejectNavigation = reject
      })
    } finally {
      navigationSettled = true
    }
  }
  const ws = new Socket()
  f.stream.attach(ws)
  ws.input({ type: 'navigate', url: 'https://claude.com/login', seq: 1 })
  await navigating
  ws.input({ type: 'text', text: 'must not reach the closed browser', seq: 2 })
  ws.input({ type: 'close', seq: 3 })
  for (let i = 0; i < 10 && !f.calls.closed; i++) await Promise.resolve()
  assert.equal(f.calls.closed, 1)
  assert.equal(closedDuringNavigation, true)
  await f.stream.inputTail
  assert.equal(f.stream.closed, true)
  assert.equal(ws.readyState, 3)
  assert.deepEqual(f.calls.input, [])
  assert.equal(
    ws.json().some((item) => item.type === 'status'),
    false,
  )
  assert.equal(
    ws.json().some((item) => item.type === 'input_ack'),
    false,
  )
})

test('invalid addresses and failed navigation report a navigation error without overriding OAuth status', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  for (const url of ['', 'claude.com/login', 'javascript:alert(1)', 'file:///tmp/private', 'data:text/html,test']) {
    ws.input({ type: 'navigate', url })
    await f.stream.inputTail
    assert.equal(ws.json().at(-1).type, 'navigation')
    assert.equal(ws.json().at(-1).loading, false)
    assert.ok(ws.json().at(-1).error)
  }
  assert.deepEqual(f.calls.input, [])
  const privateUrl = 'https://claude.com/login/verify?token=fixture-private-mail-token&signature=private-signature'
  f.page.goto = async () => {
    throw Object.assign(Error(`page.goto: Timeout 45000ms navigating to "${privateUrl}"`), { name: 'TimeoutError' })
  }
  ws.input({ type: 'navigate', url: privateUrl })
  await f.stream.inputTail
  assert.equal(ws.json().at(-1).error, '页面打开超时，请检查链接后重试。')
  assert.equal(ws.json().at(-1).loading, false)
  assert.doesNotMatch(JSON.stringify(ws.json()), /fixture-private-mail-token|private-signature/)
  f.page.goto = async () => {
    throw Error(`page.goto: ERR_PROXY_CONNECTION_FAILED ${privateUrl}`)
  }
  ws.input({ type: 'navigate', url: privateUrl })
  await f.stream.inputTail
  assert.equal(ws.json().at(-1).error, '页面打开失败，请检查链接后重试。')
  assert.doesNotMatch(JSON.stringify(ws.json()), /fixture-private-mail-token|private-signature/)
  assert.equal(
    ws.json().some((item) => item.type === 'status'),
    false,
  )
})

test('authorization return execution errors omit the signed URL from the navigation error', async (t) => {
  const f = fixture(t, {
    canReturnToAuthorization: () => true,
    onReturnToAuthorization: async () => {
      throw Error(
        'page.goto failed https://claude.com/cai/oauth/authorize?state=private-state&code_challenge=private-challenge',
      )
    },
  })
  const ws = new Socket()
  f.stream.attach(ws)
  ws.input({ type: 'return_to_authorization' })
  await f.stream.inputTail
  assert.equal(ws.json().at(-1).error, '页面打开失败，请检查链接后重试。')
  assert.doesNotMatch(JSON.stringify(ws.json()), /private-state|private-challenge/)
  assert.equal(
    ws.json().some((item) => item.type === 'status'),
    false,
  )
})

test('a provider callback owns navigation aborts while authorization completes without hiding invalid URLs', async (t) => {
  let completing = false
  const f = fixture(t, { isAuthorizationCompleting: () => completing })
  f.page.goto = async () => {
    completing = true
    throw Error('page.goto: NS_ERROR_ABORTED at provider OAuth callback')
  }
  const ws = new Socket()
  f.stream.attach(ws)
  ws.input({ type: 'navigate', url: 'https://claude.com/login/verify?token=fixture-token' })
  await f.stream.inputTail
  assert.equal(ws.json().at(-1).type, 'navigation')
  assert.equal(ws.json().at(-1).loading, false)
  assert.equal(ws.json().at(-1).error, undefined)
  assert.equal(
    ws.json().some((item) => item.type === 'status'),
    false,
  )

  ws.input({ type: 'navigate', url: 'javascript:alert(1)' })
  await f.stream.inputTail
  assert.match(ws.json().at(-1).error, /仅支持/)

  completing = false
  f.page.goto = async () => {
    throw Error('page.goto: ERR_PROXY_CONNECTION_FAILED')
  }
  ws.input({ type: 'navigate', url: 'https://claude.com/login' })
  await f.stream.inputTail
  assert.equal(ws.json().at(-1).error, '页面打开失败，请检查链接后重试。')
})

test('new navigation after OAuth completion still reports genuine network failures and timeouts', async (t) => {
  const f = fixture(t, { isAuthorizationCompleting: () => true })
  const ws = new Socket()
  f.stream.attach(ws)
  for (const [name, expected] of [
    ['Error', '页面打开失败，请检查链接后重试。'],
    ['TimeoutError', '页面打开超时，请检查链接后重试。'],
  ]) {
    f.page.goto = async () => {
      throw Object.assign(Error('page.goto failed at https://mail.fixture.test/verify?token=private'), { name })
    }
    ws.input({ type: 'navigate', url: 'https://claude.com/login' })
    await f.stream.inputTail
    assert.equal(ws.json().at(-1).type, 'navigation')
    assert.equal(ws.json().at(-1).loading, false)
    assert.equal(ws.json().at(-1).error, expected)
    assert.doesNotMatch(ws.json().at(-1).error, /private|token=/)
  }
  assert.equal(
    ws.json().some((item) => item.type === 'status'),
    false,
  )
})

test('returning to authorization uses the current service callback and reports expired capability separately', async (t) => {
  let available = true
  let returned = 0
  const f = fixture(t, {
    canReturnToAuthorization: () => available,
    onReturnToAuthorization: async () => {
      returned++
    },
  })
  const ws = new Socket()
  f.stream.attach(ws)
  ws.input({ type: 'return_to_authorization', seq: 9 })
  await f.stream.inputTail
  assert.equal(returned, 1)
  assert.deepEqual(
    ws.json().filter((item) => item.type === 'input_ack'),
    [{ type: 'input_ack', seq: 9 }],
  )
  available = false
  f.stream.sendNavigation()
  ws.input({ type: 'return_to_authorization', seq: 10 })
  await f.stream.inputTail
  assert.equal(returned, 1)
  assert.equal(ws.json().at(-1).canReturnToAuthorization, false)
  assert.match(ws.json().at(-1).error, /授权会话已结束/)
  assert.equal(
    ws.json().some((item) => item.type === 'status'),
    false,
  )
})

test('input locks and existing admission checks prevent navigation and authorization return', async (t) => {
  let returned = 0
  const locked = fixture(t, {
    isInputLocked: () => true,
    canReturnToAuthorization: () => true,
    onReturnToAuthorization: async () => {
      returned++
    },
  })
  const ws = new Socket()
  locked.stream.attach(ws)
  ws.input({ type: 'navigate', url: 'https://claude.com/login' })
  ws.input({ type: 'return_to_authorization' })
  await locked.stream.inputTail
  assert.deepEqual(locked.calls.input, [])
  assert.equal(returned, 0)
  assert.equal(ws.json().at(-1).inputLocked, true)
  assert.equal(ws.json().at(-1).canReturnToAuthorization, false)

  const rejected = fixture(t, { onInput: () => false })
  const blocked = new Socket()
  rejected.stream.attach(blocked)
  blocked.input({ type: 'navigate', url: 'https://claude.com/login' })
  await rejected.stream.inputTail
  assert.deepEqual(rejected.calls.input, [])
  rejected.stream.assertCurrent = () => {
    throw Error('proxy changed')
  }
  blocked.input({ type: 'navigate', url: 'https://claude.com/login' })
  await rejected.stream.inputTail
  assert.equal(rejected.calls.closed, 1)
  assert.deepEqual(rejected.calls.input, [])
})

test('native screenshot pixels remain separate from CSS viewport coordinates', async (t) => {
  const f = fixture(t, { measure: async () => ({ width: 3840, height: 2160 }) })
  const ws = new Socket()
  f.stream.attach(ws)
  ws.input({ type: 'quality', mode: 'native' })
  await f.fire()
  const frame = ws.json().find((item) => item.type === 'frame')
  assert.equal(frame.width, 1920)
  assert.equal(frame.height, 1080)
  assert.equal(frame.imageWidth, 3840)
  assert.equal(frame.imageHeight, 2160)
})

test('Puppeteer keyboard chords release modifiers and use native wheel parameters', async (t) => {
  const f = fixture(t)
  const ws = new Socket()
  f.stream.attach(ws)
  ws.input({ type: 'key', key: 'Control+Shift+ArrowLeft' })
  ws.input({ type: 'scroll', deltaX: 12, deltaY: 34 })
  await f.stream.inputTail
  assert.deepEqual(f.calls.input, [
    ['key_down', 'Control'],
    ['key_down', 'Shift'],
    ['key', 'ArrowLeft'],
    ['key_up', 'Shift'],
    ['key_up', 'Control'],
    ['scroll', 12, 34],
  ])
  f.page.keyboard.press = async () => {
    throw new Error('target closed')
  }
  ws.input({ type: 'key', key: 'Control+a' })
  await f.stream.inputTail
  assert.deepEqual(f.calls.input.slice(-2), [
    ['key_down', 'Control'],
    ['key_up', 'Control'],
  ])
})
