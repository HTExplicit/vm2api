import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import test from 'node:test'
import { createGracefulShutdown } from '../../src/lib/http/graceful-shutdown.mjs'

class FakeResponse extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
  }
  destroy() {
    this.destroyed = true
    this.emit('close')
  }
  end() {
    this.emit('finish')
  }
}

class FakeServer extends EventEmitter {
  constructor() {
    super()
    this.closed = false
    this.allConnectionsClosed = false
  }
  close(cb) {
    this.closed = true
    cb?.()
  }
  closeAllConnections() {
    this.allConnectionsClosed = true
  }
}

test('createGracefulShutdown: tracks in-flight requests and decrements on finish or close', () => {
  const gs = createGracefulShutdown({ exit: () => {} })
  assert.equal(gs.isShuttingDown(), false)
  assert.equal(gs.getActiveCount(), 0)

  const res1 = new FakeResponse()
  const res2 = new FakeResponse()

  assert.equal(gs.trackRequest({}, res1), true)
  assert.equal(gs.trackRequest({}, res2), true)
  assert.equal(gs.getActiveCount(), 2)

  res1.end()
  assert.equal(gs.getActiveCount(), 1)

  res2.destroy()
  assert.equal(gs.getActiveCount(), 0)
})

test('createGracefulShutdown: waits for in-flight requests to drain before calling afterDrain and exit', async () => {
  const server = new FakeServer()
  const events = []
  let exitCode = null

  const gs = createGracefulShutdown({
    server,
    drainTimeoutMs: 1000,
    beforeDrain: async () => {
      events.push('beforeDrain')
    },
    afterDrain: async () => {
      events.push('afterDrain')
    },
    exit: (code) => {
      exitCode = code
      events.push('exit')
    },
    logger: { log() {}, warn() {} },
  })

  const res = new FakeResponse()
  gs.trackRequest({}, res)
  assert.equal(gs.getActiveCount(), 1)

  const shutdownPromise = gs.shutdown('SIGTERM')
  assert.equal(gs.isShuttingDown(), true)
  assert.equal(server.closed, true)
  assert.deepEqual(events, ['beforeDrain'])

  // Requests after shutdown started are rejected
  const resLate = new FakeResponse()
  assert.equal(gs.trackRequest({}, resLate), false)

  // In-flight request finishes
  res.end()

  await shutdownPromise
  assert.equal(exitCode, 0)
  assert.deepEqual(events, ['beforeDrain', 'afterDrain', 'exit'])
})

test('createGracefulShutdown: times out and force-closes remaining requests if drain takes too long', async () => {
  const server = new FakeServer()
  const events = []
  let exitCode = null

  const gs = createGracefulShutdown({
    server,
    drainTimeoutMs: 50,
    beforeDrain: async () => {
      events.push('beforeDrain')
    },
    afterDrain: async () => {
      events.push('afterDrain')
    },
    exit: (code) => {
      exitCode = code
      events.push('exit')
    },
    logger: { log() {}, warn() {} },
  })

  const res = new FakeResponse()
  gs.trackRequest({}, res)
  assert.equal(gs.getActiveCount(), 1)

  // Start shutdown without finishing res
  await gs.shutdown('SIGINT')

  assert.equal(res.destroyed, true)
  assert.equal(server.allConnectionsClosed, true)
  assert.equal(exitCode, 0)
  assert.deepEqual(events, ['beforeDrain', 'afterDrain', 'exit'])
})

test('createGracefulShutdown: shutdown is idempotent', async () => {
  let beforeDrainCount = 0
  let afterDrainCount = 0

  const gs = createGracefulShutdown({
    drainTimeoutMs: 50,
    beforeDrain: async () => {
      beforeDrainCount++
    },
    afterDrain: async () => {
      afterDrainCount++
    },
    exit: () => {},
    logger: { log() {}, warn() {} },
  })

  const p1 = gs.shutdown('SIGTERM')
  const p2 = gs.shutdown('SIGINT')
  assert.equal(p1, p2)
  await p1

  assert.equal(beforeDrainCount, 1)
  assert.equal(afterDrainCount, 1)
})

for (const cleanupFails of [false, true]) {
  test(`server shutdown preserves browser cleanup and queued logs, cleanup failure=${cleanupFails}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-fork-'))
    const db = openDatabase({ dataDir: dir })
    const logs = new RequestLogStore({ dataDir: dir, db, mode: 'normal' })
    const events = []
    const source = fs.readFileSync(new URL('../../src/server.mjs', import.meta.url), 'utf8')
    const wiring = source.slice(source.indexOf('let browserShutdownFailed = false'), source.indexOf('const server = http.createServer'))
    const stop = (name) => ({ stop: async () => { events.push(name) } })
    const context = {
      createGracefulShutdown: (options) => createGracefulShutdown({
        ...options,
        logger: { log() {}, warn() {} },
      }),
      process: { exit: (code) => events.push(`exit:${code}`) },
      console: { warn() {} },
      installJevUsageRecorder() { events.push('jev-recorder-off') },
      vmTestSchedule: stop('schedule'),
      backupService: { stopScheduler() {} },
      proxyPool: { stopScheduler() {} },
      healthMonitor: stop('health'),
      credentialRefreshMonitor: stop('credentials'),
      kernelWatchdog: stop('watchdog'),
      cliNodeGuard: stop('guard'),
      usageProbeMonitor: stop('usage'),
      catalogMonitor: stop('catalog'),
      notifyMonitor: stop('notify'),
      codexBrowserLogin: stop('oauth'),
      slotBrowserManager: { stop: async () => {
        events.push('browser')
        if (cleanupFails) throw Object.assign(new Error('fixture'), { code: 'browser_close_failed' })
      } },
      openaiApiManager: stop('account-api'),
      stopVmWatch() { events.push('watch') },
      stopAllRustKernels() { events.push('kernels') },
      clusterManager: stop('cluster'),
      closeDatabase() { events.push('database'); closeDatabase() },
    }
    let persisted
    try {
      vm.runInNewContext(wiring + '\nglobalThis.shutdown = gracefulShutdown', context)
      const response = new FakeResponse()
      context.shutdown.trackRequest({}, response)
      const pending = context.shutdown.shutdown()
      assert.equal(events.includes('browser'), false, 'cleanup waits for active HTTP requests')
      assert.equal(events.includes('jev-recorder-off'), false, 'active reviews keep their usage recorder while draining')
      const row = logs.finish(logs.start({ headers: {}, socket: {} }, { protocol: 'anthropic.messages' }), { status: 200 })
      response.end()
      await pending
      for (const service of ['oauth', 'browser', 'account-api']) assert.equal(events.filter((name) => name === service).length, 1)
      assert.ok(events.indexOf('database') > events.indexOf('account-api'))
      assert.ok(events.indexOf('jev-recorder-off') < events.indexOf('database'))
      assert.equal(events.at(-1), `exit:${cleanupFails ? 1 : 0}`)
      persisted = new DatabaseSync(path.join(dir, 'kin.db'), { readOnly: true })
      assert.equal(persisted.prepare('SELECT status FROM usage_logs WHERE request_id = ?').get(row.request_id)?.status, 200)
    } finally {
      closeDatabase()
      persisted?.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
