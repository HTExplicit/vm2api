import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import { createBoundProxyRelay, createPlatformBrowserSession } from '../../src/lib/openai-api/platform-browser.mjs'

function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-browser-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const calls = []
  const page = { url: () => 'about:blank', bringToFront: async () => calls.push(['bringToFront']) }
  const child = changes.child || Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  const context = {
    cookies: async () => [],
    deleteCookie: async (...cookies) => calls.push(['deleteCookie', cookies]),
    setCookie: async (...cookies) => calls.push(['setCookie', cookies]),
    ...changes.context,
  }
  const browser = {
    process: () => child,
    defaultBrowserContext: () => context,
    newPage: async () => {
      calls.push(['newPage'])
      return page
    },
    close: async () => {
      calls.push(['browser.close'])
      child.exitCode = 0
      child.emit('exit', 0, null)
    },
    ...changes.browser,
  }
  const options = {
    profileDir: path.join(root, 'profile'),
    cacheDir: path.join(root, 'runtime'),
    timezone: 'America/New_York',
    proxyUrl: 'socks5h://127.0.0.1:1080',
  }
  const dependencies = {
    prepareProfile: async (value) => {
      calls.push(['prepareProfile', value])
      return {
        executablePath: '/fixture/chrome',
        fingerprintPath: '/fixture/fingerprint.json',
        version: '157.0.8103.50',
      }
    },
    launch: async (value) => {
      calls.push(['launch', value])
      await changes.launch?.()
      return browser
    },
    createRelay: async (proxy) => {
      calls.push(['relay', proxy])
      return { url: 'http://127.0.0.1:54321', close: async () => calls.push(['relay.close']) }
    },
    createDisplay: async () => {
      calls.push(['display'])
      return { env: { DISPLAY: ':42' }, close: async () => calls.push(['display.close']) }
    },
  }
  return { options, dependencies, calls, context, browser, child, page }
}

test('native Puppeteer launch uses the installed profile, headful display, software GPU and bound relay', async (t) => {
  const f = fixture(t)
  const session = await createPlatformBrowserSession(f.options, f.dependencies)
  assert.deepEqual(
    f.calls.slice(0, 3).map(([name]) => name),
    ['relay', 'display', 'prepareProfile'],
  )
  const prepared = f.calls.find(([name]) => name === 'prepareProfile')[1]
  assert.equal(prepared.timezone, 'America/New_York')
  assert.deepEqual(prepared.env, { DISPLAY: ':42' })
  const launch = f.calls.find(([name]) => name === 'launch')[1]
  assert.equal(launch.executablePath, '/fixture/chrome')
  assert.equal(launch.userDataDir, f.options.profileDir)
  assert.equal(launch.headless, false)
  assert.equal(launch.defaultViewport, null)
  assert.equal(launch.waitForInitialPage, false)
  assert.equal(launch.protocolTimeout, 60_000, 'protocol commands must permit the 30–45 second business waits')
  assert.deepEqual(launch.env, { DISPLAY: ':42' })
  assert.ok(launch.args.includes('--fingerprint-profile=/fixture/fingerprint.json'))
  assert.ok(launch.args.includes('--proxy-server=http://127.0.0.1:54321'))
  assert.ok(launch.args.includes('--use-angle=swiftshader'))
  assert.equal(session.browser, f.browser)
  assert.equal(session.context, f.context)
  assert.equal(session.page, f.page)
  assert.equal(session.version, '157.0.8103.50')
  assert.equal(f.calls.filter(([name]) => name === 'newPage').length, 1)
  await session.close()
  assert.deepEqual(
    f.calls.slice(-3).map(([name]) => name),
    ['browser.close', 'relay.close', 'display.close'],
  )
})

test('pending HTTP snapshot replaces native cookies using full deletion objects and filters expiration', async (t) => {
  const old = [{ name: 'removed', value: 'old', domain: 'example.test', path: '/', expires: -1, httpOnly: true }]
  const f = fixture(t, { context: { cookies: async () => old } })
  const cookies = [
    { name: 'session', value: 'fresh', domain: 'example.test', path: '/', expires: -1 },
    { name: 'live', value: 'value', domain: 'example.test', path: '/', expires: 2001 },
    { name: 'expired', value: 'old', domain: 'example.test', path: '/', expires: 2000 },
  ]
  const session = await createPlatformBrowserSession(
    { ...f.options, storageState: { cookies, cookies_pending: true } },
    { ...f.dependencies, now: () => 2_000_000 },
  )
  assert.deepEqual(
    f.calls.find(([name]) => name === 'deleteCookie'),
    ['deleteCookie', old],
  )
  assert.deepEqual(
    f.calls.find(([name]) => name === 'setCookie'),
    ['setCookie', cookies.slice(0, 2)],
  )
  await session.close()
})

test('Cookie export does not traverse IndexedDB or localStorage', async (t) => {
  const cookies = [{ name: 'session', value: 'current', domain: 'example.test', path: '/', expires: -1 }]
  const f = fixture(t, { context: { cookies: async () => cookies } })
  const session = await createPlatformBrowserSession(f.options, f.dependencies)
  assert.deepEqual(await session.exportCookies(), cookies)
  assert.equal(session.storageState, undefined)
  await session.close()
})

test('a stalled Cookie export times out independently of the longer browser protocol deadline', async (t) => {
  const f = fixture(t, { context: { cookies: () => new Promise(() => {}) } })
  const session = await createPlatformBrowserSession(f.options, f.dependencies)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exported = session.exportCookies()
  const rejected = assert.rejects(exported, { code: 'browser_cookie_timeout' })
  t.mock.timers.tick(3000)
  await rejected
  await session.close()
  assert.equal(f.child.exitCode, 0)
  assert.deepEqual(
    f.calls.slice(-3).map(([name]) => name),
    ['browser.close', 'relay.close', 'display.close'],
  )
})

test('ordinary DB snapshots never overwrite newer profile cookies', async (t) => {
  for (const storageState of [
    undefined,
    { cookies: [] },
    { cookies: [{ name: 'old' }] },
    { cookies: [], cookies_pending: false },
  ]) {
    const f = fixture(t)
    const session = await createPlatformBrowserSession({ ...f.options, storageState }, f.dependencies)
    assert.equal(
      f.calls.some(([name]) => ['deleteCookie', 'setCookie'].includes(name)),
      false,
    )
    await session.close()
  }
})

test('a pending empty Cookie snapshot removes cookies deleted by the HTTP server', async (t) => {
  const old = [{ name: 'gone', value: 'old', domain: 'example.test', path: '/', expires: -1 }]
  const f = fixture(t, { context: { cookies: async () => old } })
  const session = await createPlatformBrowserSession(
    { ...f.options, storageState: { cookies: [], cookies_pending: true } },
    f.dependencies,
  )
  assert.deepEqual(
    f.calls.find(([name]) => name === 'deleteCookie'),
    ['deleteCookie', old],
  )
  assert.equal(
    f.calls.some(([name]) => name === 'setCookie'),
    false,
  )
  await session.close()
})

test('proxy, absolute directories and resolved timezone are required before starting resources', async (t) => {
  const f = fixture(t)
  for (const [patch, code] of [
    [{ proxyUrl: '' }, 'proxy_required'],
    [{ proxyUrl: 'ftp://127.0.0.1' }, 'proxy_unsupported'],
    [{ profileDir: 'relative' }, 'browser_path_required'],
    [{ cacheDir: '' }, 'browser_path_required'],
    [{ timezone: '' }, 'browser_timezone_required'],
  ])
    await assert.rejects(createPlatformBrowserSession({ ...f.options, ...patch }, f.dependencies), { code })
  assert.deepEqual(f.calls, [])
})

test('cancellation during launch closes the owned process before its relay and display', async (t) => {
  const controller = new AbortController()
  const f = fixture(t, { launch: () => controller.abort() })
  await assert.rejects(createPlatformBrowserSession({ ...f.options, signal: controller.signal }, f.dependencies), {
    name: 'AbortError',
  })
  assert.deepEqual(
    f.calls.slice(-3).map(([name]) => name),
    ['browser.close', 'relay.close', 'display.close'],
  )
})

test('closing is shared and supporting resources wait for actual browser process exit', async (t) => {
  const f = fixture(t)
  let release
  f.browser.close = async () => {
    f.calls.push(['browser.close'])
    await new Promise((resolve) => {
      release = resolve
    })
    f.child.exitCode = 0
  }
  const session = await createPlatformBrowserSession(f.options, f.dependencies)
  const first = session.close(),
    second = session.close()
  assert.equal(first, second)
  assert.equal(
    f.calls.some(([name]) => name === 'relay.close'),
    false,
  )
  release()
  await first
  assert.equal(f.calls.filter(([name]) => name === 'browser.close').length, 1)
  await session.close()
  assert.equal(f.calls.filter(([name]) => name === 'relay.close').length, 1)
})

test('protocol close completion cannot release a browser whose process is still running', async (t) => {
  const f = fixture(t)
  let attempts = 0
  f.browser.close = async () => {
    attempts++
    if (attempts === 2) f.child.exitCode = 0
  }
  const session = await createPlatformBrowserSession(f.options, f.dependencies)
  await assert.rejects(session.close(), { code: 'browser_close_failed' })
  assert.equal(
    f.calls.some(([name]) => name === 'relay.close'),
    false,
  )
  await session.close()
  assert.equal(attempts, 2)
})

test('an already terminated browser releases resources and reports a state warning', async (t) => {
  const f = fixture(t)
  const session = await createPlatformBrowserSession(f.options, f.dependencies)
  f.child.signalCode = 'SIGKILL'
  await session.close()
  assert.equal(
    f.calls.some(([name]) => name === 'browser.close'),
    false,
  )
  assert.match(session.warning, /异常退出/)
  assert.deepEqual(
    f.calls.slice(-2).map(([name]) => name),
    ['relay.close', 'display.close'],
  )
})

test('relay or display failures retry only unfinished resource cleanup', async (t) => {
  for (const resource of ['relay', 'display']) {
    const f = fixture(t)
    let attempts = 0
    const close = async () => {
      if (++attempts === 1) throw new Error('resource still running')
    }
    if (resource === 'relay') f.dependencies.createRelay = async () => ({ url: 'http://127.0.0.1:54321', close })
    else f.dependencies.createDisplay = async () => ({ env: { DISPLAY: ':42' }, close })
    const session = await createPlatformBrowserSession(f.options, f.dependencies)
    await assert.rejects(session.close())
    await session.close()
    assert.equal(attempts, 2)
    assert.equal(f.calls.filter(([name]) => name === 'browser.close').length, 1)
  }
})

test('failed startup retains unfinished cleanup for the manager to retry', async (t) => {
  const f = fixture(t, {
    context: {
      cookies: async () => {
        throw new Error('Cookie read failed')
      },
    },
  })
  f.browser.close = async () => {
    throw new Error('close failed')
  }
  let pending
  await assert.rejects(
    createPlatformBrowserSession(
      { ...f.options, storageState: { cookies: [], cookies_pending: true } },
      f.dependencies,
    ),
    (error) => {
      pending = error.pendingSession
      return error.code === 'browser_close_failed' && Boolean(pending?.close)
    },
  )
  assert.equal(
    f.calls.some(([name]) => name === 'relay.close'),
    false,
  )
  f.child.exitCode = 0
  await pending.close()
  assert.deepEqual(
    f.calls.slice(-2).map(([name]) => name),
    ['relay.close', 'display.close'],
  )
})

test('launcher failure hides private diagnostics and closes supporting resources', async (t) => {
  const f = fixture(t, {
    launch: () => {
      throw new Error('private upstream diagnostics')
    },
  })
  await assert.rejects(
    createPlatformBrowserSession(f.options, f.dependencies),
    (error) => error.code === 'browser_start_failed' && !error.message.includes('private upstream'),
  )
  assert.deepEqual(
    f.calls.slice(-2).map(([name]) => name),
    ['relay.close', 'display.close'],
  )
})

test('loopback CONNECT relay authenticates to bound SOCKS and sends hostname for remote DNS', async (t) => {
  const events = []
  const peer = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write(Buffer.from([5, 2]))
      socket.once('data', (auth) => {
        const length = auth[1]
        events.push(auth.subarray(2, 2 + length).toString())
        socket.write(Buffer.from([1, 0]))
        socket.once('data', (req) => {
          events.push(req.subarray(5, 5 + req[4]).toString())
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          socket.once('data', (data) => socket.end(data))
        })
      })
    })
  })
  peer.listen(0, '127.0.0.1')
  await once(peer, 'listening')
  t.after(() => peer.close())
  const relay = await createBoundProxyRelay(`socks5://account:password@127.0.0.1:${peer.address().port}`)
  t.after(() => relay.close())
  const req = http.request(relay.url, { method: 'CONNECT', path: 'private-upstream.invalid:443' })
  req.end()
  const [response, socket] = await once(req, 'connect')
  assert.equal(response.statusCode, 200)
  socket.write('account-proxy-tunnel')
  const [reply] = await once(socket, 'data')
  assert.equal(reply.toString(), 'account-proxy-tunnel')
  socket.destroy()
  assert.deepEqual(events, ['account', 'private-upstream.invalid'])
})

test('relay returns 502 when the account proxy fails instead of opening direct connection', async (t) => {
  const peer = net.createServer()
  peer.listen(0, '127.0.0.1')
  await once(peer, 'listening')
  const port = peer.address().port
  await new Promise((resolve) => peer.close(resolve))
  const relay = await createBoundProxyRelay(`socks5://127.0.0.1:${port}`)
  t.after(() => relay.close())
  const req = http.request(relay.url, { method: 'CONNECT', path: 'private-upstream.invalid:443' })
  req.end()
  const [response, socket] = await once(req, 'connect')
  assert.equal(response.statusCode, 502)
  socket.destroy()
})

test('closing relay also closes an HTTP proxy socket waiting for CONNECT response', async (t) => {
  const peer = net.createServer()
  peer.listen(0, '127.0.0.1')
  await once(peer, 'listening')
  t.after(() => peer.close())
  const connected = once(peer, 'connection')
  const relay = await createBoundProxyRelay(`http://127.0.0.1:${peer.address().port}`)
  const req = http.request(relay.url, { method: 'CONNECT', path: 'private-upstream.invalid:443' })
  req.on('error', () => {})
  req.end()
  const [upstream] = await connected
  upstream.resume()
  const closed = once(upstream, 'close')
  await relay.close()
  await closed
  assert.equal(upstream.destroyed, true)
})

test('session exit notification follows the owned process exit rather than connection events', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 80)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  })
  const f = fixture(t, { child })
  const session = await createPlatformBrowserSession(f.options, f.dependencies)
  let resolved = false
  session.exited.then(() => {
    resolved = true
  })
  child.emit('disconnect')
  await Promise.resolve()
  assert.equal(resolved, false)
  assert.deepEqual(await session.exited, { code: 7, signal: null })
  await session.close()
  assert.match(session.warning, /异常退出/)
  assert.equal(
    f.calls.some(([name]) => name === 'browser.close'),
    false,
  )
})

test('session exit notification also handles a process that already exited', async (t) => {
  const child = Object.assign(new EventEmitter(), { exitCode: 9, signalCode: null })
  const f = fixture(t, { child })
  const session = await createPlatformBrowserSession(f.options, f.dependencies)
  assert.deepEqual(await session.exited, { code: 9, signal: null })
  assert.equal(child.listenerCount('exit'), 0)
  await session.close()
})
