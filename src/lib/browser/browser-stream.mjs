const ACTIVE_INTERVAL = 200
const IDLE_INTERVAL = 1000
const MAX_DIMENSION = 1280

async function resizeJpeg(image, { width, height, maxDimension }) {
  const ratio = Math.min(1, maxDimension / Math.max(width, height))
  if (ratio === 1) return { image, width, height }
  const { default: sharp } = await import('sharp')
  const { data, info } = await sharp(image)
    .resize({
      width: Math.round(width * ratio),
      height: Math.round(height * ratio),
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 60 })
    .toBuffer({ resolveWithObject: true })
  return { image: data, width: info.width, height: info.height }
}

async function imageDimensions(image) {
  const { default: sharp } = await import('sharp')
  const { width, height } = await sharp(image).metadata()
  return { width, height }
}

async function pressKey(keyboard, value) {
  let key = String(value)
  const modifiers = []
  let prefix
  while ((prefix = /^(Control|Meta|Alt|Shift)\+/.exec(key))) {
    modifiers.push(prefix[1])
    key = key.slice(prefix[0].length)
  }
  const held = []
  try {
    for (const modifier of modifiers) {
      await keyboard.down(modifier)
      held.push(modifier)
    }
    await keyboard.press(key)
  } finally {
    for (const modifier of held.reverse()) await keyboard.up(modifier)
  }
}

function message(error) {
  return String(error?.message || '浏览器操作失败')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[key]')
    .slice(0, 300)
}

/** One capture loop per browser. Slow clients skip frames rather than queue them. */
export class BrowserStream {
  constructor({
    page,
    assertCurrent = () => {},
    onInput = () => {},
    onClose = () => {},
    onContinue = () => {},
    onReturnToAuthorization = () => {},
    canReturnToAuthorization = () => false,
    isInputLocked = () => false,
    isAuthorizationCompleting = () => false,
    now = Date.now,
    resize = resizeJpeg,
    measure = imageDimensions,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    Object.assign(this, {
      page,
      assertCurrent,
      onInput,
      onClose,
      onContinue,
      onReturnToAuthorization,
      canReturnToAuthorization,
      isInputLocked,
      isAuthorizationCompleting,
      now,
      resize,
      measure,
      setTimer,
      clearTimer,
    })
    this.clients = new Map()
    this.closed = false
    this.capturing = false
    this.lastCaptureAt = -Infinity
    this.frameRequested = false
    this.pendingInputs = 0
    this.sequence = 0
    this.inputTail = Promise.resolve()
    this.viewportDirty = true
    this.viewport = null
    this.navigationLoading = false
    this.navigation = () => {
      this.viewportDirty = true
      this.requestFrame()
    }
    this.frameNavigated = (frame) => {
      if (frame !== this.page.mainFrame()) return
      this.sendNavigation()
    }
    page.on?.('domcontentloaded', this.navigation)
    page.on?.('framenavigated', this.frameNavigated)
  }

  navigationState(error) {
    return {
      type: 'navigation',
      url: this.page.url(),
      loading: this.navigationLoading,
      canReturnToAuthorization: !this.isInputLocked() && this.canReturnToAuthorization(),
      inputLocked: this.isInputLocked(),
      ...(error ? { error: message(error) } : {}),
    }
  }

  sendNavigation(error) {
    if (this.closed) return
    const payload = JSON.stringify(this.navigationState(error))
    for (const ws of this.clients.keys()) if (ws.readyState === 1) ws.send(payload)
  }

  attach(ws) {
    if (this.closed) return ws.close()
    const client = {
      mode: 'smooth',
      pressedButtons: new Set(),
      message: (raw) => this.receive(ws, raw),
      close: () => this.detach(ws),
      error: () => this.detach(ws),
    }
    this.clients.set(ws, client)
    ws.on('message', client.message)
    ws.on('close', client.close)
    ws.on('error', client.error)
    if (ws.readyState === 1) ws.send(JSON.stringify(this.navigationState()))
    this.schedule(0)
  }

  detach(ws) {
    const client = this.clients.get(ws)
    if (!client) return
    ws.off('message', client.message)
    ws.off('close', client.close)
    ws.off('error', client.error)
    this.clients.delete(ws)
    this.enqueue(async () => {
      if (this.closed) return
      for (const button of client.pressedButtons) {
        await this.page.mouse.up({ button })
        client.pressedButtons.delete(button)
        this.requestFrame()
      }
    })
    if (!this.clients.size) this.clearSchedule()
  }

  requestFrame() {
    if (this.closed) return
    this.frameRequested = true
    this.schedule(Math.max(0, this.lastCaptureAt + ACTIVE_INTERVAL - this.now()))
  }

  clearSchedule() {
    if (this.timer != null) this.clearTimer(this.timer)
    this.timer = null
    this.timerAt = null
  }

  schedule(delay) {
    if (this.closed || !this.clients.size || this.capturing || this.pendingInputs) return
    const at = this.now() + delay
    if (this.timer != null && this.timerAt <= at) return
    this.clearSchedule()
    this.timerAt = at
    this.timer = this.setTimer(() => {
      this.timer = null
      this.timerAt = null
      void this.capture()
    }, delay)
    this.timer?.unref?.()
  }

  async capture() {
    if (this.closed || this.capturing || this.pendingInputs || !this.clients.size) return
    this.clearSchedule()
    this.capturing = true
    this.frameRequested = false
    this.lastCaptureAt = this.now()
    try {
      try {
        await this.assertCurrent()
      } catch (error) {
        this.close()
        await this.onClose(error)
        return
      }
      const ready = [...this.clients].filter(([ws]) => ws.readyState === 1 && !ws.bufferedAmount)
      if (!ready.length) return
      if (this.viewportDirty || !this.viewport) {
        this.viewport = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        this.viewportDirty = false
      }
      const { width, height } = this.viewport
      const image = Buffer.from(await this.page.screenshot({ type: 'jpeg', quality: 70 }))
      const pixels = await this.measure(image)
      if (this.closed) return
      const encoded = new Map([['native', { image, ...pixels }]])
      if (ready.some(([, client]) => client.mode === 'smooth')) {
        encoded.set('smooth', await this.resize(image, { ...pixels, maxDimension: MAX_DIMENSION }))
      }
      const seq = ++this.sequence
      for (const [ws, client] of ready) {
        if (this.closed || ws.readyState !== 1 || ws.bufferedAmount || !this.clients.has(ws)) continue
        const frame = encoded.get(client.mode)
        if (!frame) continue
        ws.send(
          JSON.stringify({
            type: 'frame',
            seq,
            mime: 'image/jpeg',
            width,
            height,
            imageWidth: frame.width,
            imageHeight: frame.height,
            quality: client.mode,
          }),
        )
        ws.send(frame.image, { binary: true })
      }
    } catch {
      // A navigation can interrupt a screenshot; the next frame samples the current page.
    } finally {
      this.capturing = false
      // A completed input asks for its frame immediately. Otherwise leave a full
      // quiet second after encoding; never catch up with a slow capture loop.
      this.schedule(
        this.frameRequested ? Math.max(0, this.lastCaptureAt + ACTIVE_INTERVAL - this.now()) : IDLE_INTERVAL,
      )
    }
  }

  receive(ws, raw) {
    let input
    try {
      input = JSON.parse(String(raw))
    } catch {
      return
    }
    const client = this.clients.get(ws)
    if (!client || this.closed) return
    if (input.type === 'close') {
      // Closing the browser interrupts a pending goto; it must not wait behind it.
      void this.input(ws, input)
      return
    }
    if (input.type === 'quality') {
      if (input.mode === 'smooth' || input.mode === 'native') {
        client.mode = input.mode
        this.requestFrame()
      }
      return
    }
    if (input.type === 'move') {
      if (this.moveTask) {
        this.moveTask.ws = ws
        this.moveTask.input = input
        return
      }
      const task = { ws, input }
      this.moveTask = task
      this.enqueue(async () => {
        if (this.moveTask === task) this.moveTask = null
        await this.input(task.ws, task.input)
      })
      return
    }
    this.moveTask = null
    this.enqueue(() => this.input(ws, input))
  }

  enqueue(action) {
    this.pendingInputs++
    this.clearSchedule()
    this.inputTail = this.inputTail
      .then(action)
      .catch(() => {})
      .finally(() => {
        this.pendingInputs--
        if (!this.pendingInputs) {
          this.schedule(
            this.frameRequested ? Math.max(0, this.lastCaptureAt + ACTIVE_INTERVAL - this.now()) : IDLE_INTERVAL,
          )
        }
      })
  }

  async input(ws, input) {
    const client = this.clients.get(ws)
    if (this.closed || !client || ws.readyState !== 1) return
    const navigationInput = input.type === 'navigate' || input.type === 'return_to_authorization'
    let navigationStarted = false
    let authorizationCompletingAtStart = false
    try {
      try {
        await this.assertCurrent()
      } catch (error) {
        this.close()
        await this.onClose(error)
        return
      }
      if ((await this.onInput(input, ws)) === false) {
        if (navigationInput) this.sendNavigation()
        return
      }
      if (input.type === 'close') {
        await this.onClose()
        return
      }
      if (navigationInput) {
        if (this.isInputLocked()) {
          this.sendNavigation()
          return
        }
        let url
        if (input.type === 'navigate') {
          url = String(input.url || '').trim()
          let parsed
          try {
            parsed = new URL(url)
          } catch {
            throw new Error('请输入完整的 http:// 或 https:// 链接。')
          }
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('仅支持 http:// 或 https:// 链接。')
          }
        } else if (!this.canReturnToAuthorization()) {
          throw new Error('当前授权会话已结束，无法返回原授权页面。')
        }
        authorizationCompletingAtStart = this.isAuthorizationCompleting()
        navigationStarted = true
        this.navigationLoading = true
        this.sendNavigation()
        if (input.type === 'navigate') {
          await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        } else {
          await this.onReturnToAuthorization(input, ws)
        }
        this.navigationLoading = false
        this.sendNavigation()
      } else if (input.type === 'continue') await this.onContinue(input, ws)
      else if (input.type === 'click')
        await this.page.mouse.click(Number(input.x), Number(input.y), { button: input.button || 'left' })
      else if (input.type === 'mouse_down' || input.type === 'mouse_up') {
        await this.page.mouse.move(Number(input.x), Number(input.y))
        const button = input.button || 'left'
        if (input.type === 'mouse_down') {
          await this.page.mouse.down({ button })
          client.pressedButtons.add(button)
        } else {
          await this.page.mouse.up({ button })
          client.pressedButtons.delete(button)
        }
      } else if (input.type === 'move') await this.page.mouse.move(Number(input.x), Number(input.y))
      else if (input.type === 'scroll')
        await this.page.mouse.wheel({ deltaX: Number(input.deltaX) || 0, deltaY: Number(input.deltaY) || 0 })
      else if (input.type === 'key') {
        await pressKey(this.page.keyboard, input.key)
        this.viewportDirty = true
      } else if (input.type === 'text') await this.page.keyboard.sendCharacter(String(input.text))
      else return
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input_ack', seq: input.seq ?? null }))
      if (input.type !== 'move') this.requestFrame()
    } catch (error) {
      if (navigationInput) {
        this.navigationLoading = false
        if (navigationStarted && !authorizationCompletingAtStart && this.isAuthorizationCompleting()) {
          this.sendNavigation()
        } else {
          this.sendNavigation(
            navigationStarted
              ? new Error(
                  error?.name === 'TimeoutError'
                    ? '页面打开超时，请检查链接后重试。'
                    : '页面打开失败，请检查链接后重试。',
                )
              : error,
          )
        }
        this.requestFrame()
      } else if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'status', status: 'error', message: message(error) }))
      }
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.clearSchedule()
    this.page.off?.('domcontentloaded', this.navigation)
    this.page.off?.('framenavigated', this.frameNavigated)
    for (const ws of [...this.clients.keys()]) {
      this.detach(ws)
      ws.close()
    }
  }
}
