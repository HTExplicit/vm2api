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
    now = Date.now,
    resize = resizeJpeg,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    Object.assign(this, { page, assertCurrent, onInput, onClose, onContinue, now, resize, setTimer, clearTimer })
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
    this.navigation = () => {
      this.viewportDirty = true
      this.requestFrame()
    }
    page.on?.('domcontentloaded', this.navigation)
  }

  attach(ws) {
    if (this.closed) return ws.close()
    const client = {
      mode: 'smooth',
      message: (raw) => this.receive(ws, raw),
      close: () => this.detach(ws),
      error: () => this.detach(ws),
    }
    this.clients.set(ws, client)
    ws.on('message', client.message)
    ws.on('close', client.close)
    ws.on('error', client.error)
    this.schedule(0)
  }

  detach(ws) {
    const client = this.clients.get(ws)
    if (!client) return
    ws.off('message', client.message)
    ws.off('close', client.close)
    ws.off('error', client.error)
    this.clients.delete(ws)
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
      const image = await this.page.screenshot({ type: 'jpeg', quality: 70, scale: 'css' })
      if (this.closed) return
      const encoded = new Map([['native', { image, width, height }]])
      if (ready.some(([, client]) => client.mode === 'smooth')) {
        encoded.set('smooth', await this.resize(image, { width, height, maxDimension: MAX_DIMENSION }))
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
    if (this.closed || !this.clients.has(ws) || ws.readyState !== 1) return
    try {
      try {
        await this.assertCurrent()
      } catch (error) {
        this.close()
        await this.onClose(error)
        return
      }
      if ((await this.onInput(input, ws)) === false) return
      if (input.type === 'close') {
        await this.onClose()
        return
      }
      if (input.type === 'continue') await this.onContinue(input, ws)
      else if (input.type === 'click')
        await this.page.mouse.click(Number(input.x), Number(input.y), { button: input.button || 'left' })
      else if (input.type === 'move') await this.page.mouse.move(Number(input.x), Number(input.y))
      else if (input.type === 'scroll')
        await this.page.mouse.wheel(Number(input.deltaX) || 0, Number(input.deltaY) || 0)
      else if (input.type === 'key') await this.page.keyboard.press(String(input.key))
      else if (input.type === 'text') await this.page.keyboard.insertText(String(input.text))
      else return
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input_ack', seq: input.seq ?? null }))
      if (input.type !== 'move') this.requestFrame()
    } catch (error) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'status', status: 'error', message: message(error) }))
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.clearSchedule()
    this.page.off?.('domcontentloaded', this.navigation)
    for (const ws of [...this.clients.keys()]) {
      this.detach(ws)
      ws.close()
    }
  }
}
