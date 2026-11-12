import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { createBoundProxyRelay, createPlatformBrowserSession } from '../../src/lib/openai-api/platform-browser.mjs'

function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-browser-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const calls = []
  const page = { url: () => 'about:blank' }
  const context = {
    pages: () => [page],
    clearCookies: async () => calls.push(['clearCookies']),
    addCookies: async (cookies) => calls.push(['addCookies', cookies]),
    storageState: async (options) => ({ cookies: [], origins: [], options }),
    close: async () => calls.push(['context.close']),
    ...changes.context,
  }
  const report = () => ({ removed: 0, failed: [], skipped: [], warning: null })
  const options = {
    profileDir: path.join(root, 'profile'),
    cacheDir: path.join(root, 'runtime'),
    licenseKey: 'fixture-license',
    proxyUrl: 'socks5h://127.0.0.1:1080',
  }
  const dependencies = {
    runtime: async (cacheDir) => {
      calls.push(['runtime', cacheDir])
      return {
        executable: '/fixture/chrome',
        version: 'fixture-version',
        launchPersistentContext: async (value) => {
          calls.push(['launch', value])
          await changes.launch?.()
          return context
        },
      }
    },
    createRelay: async (proxy) => {
      calls.push(['relay', proxy])
      return { url: 'http://127.0.0.1:54321', close: async () => calls.push(['relay.close']) }
    },
    createDisplay: async () => {
      calls.push(['display'])
      return { env: { DISPLAY: ':42' }, close: async () => calls.push(['display.close']) }
    },
    tempCleanup: { enabled: true, cleanup: async () => report(), snapshot: () => new Set(), createdSince: () => [] },
  }
  return { options, dependencies, calls, context, page }
}

test('headed persistent launch leaves seed and viewport to CloakBrowser and replaces the HTTP cookie snapshot', async (t) => {
  const f = fixture(t)
  const cookies = [
    { name: 'session', value: 'fresh', domain: 'example.test', path: '/', expires: -1 },
    { name: 'live', value: 'value', domain: 'example.test', path: '/', expires: 2001 },
    { name: 'expired', value: 'old', domain: 'example.test', path: '/', expires: 2000 },
  ]
  const session = await createPlatformBrowserSession(
    {
      ...f.options,
      storageState: {
        cookies,
        cookies_pending: true,
        origins: [{ origin: 'https://example.test' }],
        sessionStorage: { old: true },
      },
    },
    { ...f.dependencies, now: () => 2_000_000 },
  )
  assert.deepEqual(f.calls.find(([name]) => name === 'launch')[1], {
    userDataDir: f.options.profileDir,
    licenseKey: 'fixture-license',
    headless: false,
    geoip: true,
    proxy: 'http://127.0.0.1:54321',
    launchOptions: { env: { DISPLAY: ':42' } },
  })
  assert.deepEqual(f.calls.slice(-2), [['clearCookies'], ['addCookies', cookies.slice(0, 2)]])
  assert.equal(session.page, f.page)
  assert.equal(session.context, f.context)
  assert.equal(session.version, 'fixture-version')
  assert.deepEqual(await session.storageState(), { cookies: [], origins: [], options: { indexedDB: true } })
  await session.close()
  assert.deepEqual(
    f.calls.slice(-3).map(([name]) => name),
    ['context.close', 'relay.close', 'display.close'],
  )
})

test('ordinary DB snapshots cannot overwrite newer native profile cookies', async (t) => {
  const cookies = [{ name: 'session', value: 'old-db-value', domain: 'example.test', path: '/', expires: -1 }]
  for (const storageState of [undefined, { cookies: [] }, { cookies }, { cookies, cookies_pending: false }]) {
    const f = fixture(t)
    const session = await createPlatformBrowserSession({ ...f.options, storageState }, f.dependencies)
    assert.equal(f.calls.filter(([name]) => name === 'clearCookies').length, 0)
    assert.equal(f.calls.filter(([name]) => name === 'addCookies').length, 0)
    await session.close()
  }
})

test('a pending empty HTTP snapshot clears cookies removed by the server', async (t) => {
  const f = fixture(t)
  const session = await createPlatformBrowserSession(
    { ...f.options, storageState: { cookies: [], cookies_pending: true } },
    f.dependencies,
  )
  assert.equal(f.calls.filter(([name]) => name === 'clearCookies').length, 1)
  assert.equal(f.calls.filter(([name]) => name === 'addCookies').length, 0)
  await session.close()
})

test('required proxy, key and directories are checked before loading runtime resources', async (t) => {
  const f = fixture(t)
  for (const [patch, code] of [
    [{ proxyUrl: '' }, 'proxy_required'],
    [{ proxyUrl: 'ftp://127.0.0.1' }, 'proxy_unsupported'],
    [{ licenseKey: '' }, 'browser_key_required'],
    [{ profileDir: 'relative' }, 'browser_path_required'],
    [{ cacheDir: '' }, 'browser_path_required'],
  ]) {
    await assert.rejects(createPlatformBrowserSession({ ...f.options, ...patch }, f.dependencies), { code })
  }
  assert.deepEqual(f.calls, [])
})

test('cancellation during launch closes the context before its relay and display', async (t) => {
  const controller = new AbortController()
  const f = fixture(t, { launch: () => controller.abort() })
  await assert.rejects(createPlatformBrowserSession({ ...f.options, signal: controller.signal }, f.dependencies), {
    name: 'AbortError',
  })
  assert.deepEqual(
    f.calls.slice(-3).map(([name]) => name),
    ['context.close', 'relay.close', 'display.close'],
  )
})

test('a failed context close retains relay and display until a successful retry', async (t) => {
  const f = fixture(t)
  let attempts = 0
  f.context.close = async () => {
    f.calls.push(['context.close'])
    if (++attempts === 1) throw new Error('fixture')
  }
  const session = await createPlatformBrowserSession(f.options, f.dependencies)
  await assert.rejects(session.close(), { code: 'browser_close_failed' })
  assert.equal(
    f.calls.some(([name]) => name === 'relay.close' || name === 'display.close'),
    false,
  )
  await session.close()
  await session.close()
  assert.equal(attempts, 2)
  assert.equal(f.calls.filter(([name]) => name === 'relay.close').length, 1)
  assert.equal(f.calls.filter(([name]) => name === 'display.close').length, 1)
})

test('startup failure exposes unfinished cleanup so the shared manager can retry it', async (t) => {
  const f = fixture(t)
  let closeFailed = true
  f.context.clearCookies = async () => {
    throw new Error('fixture cookie failure')
  }
  f.context.close = async () => {
    if (closeFailed) throw new Error('fixture close failure')
    f.calls.push(['context.close'])
  }
  let pending
  await assert.rejects(
    createPlatformBrowserSession(
      { ...f.options, storageState: { cookies: [], cookies_pending: true } },
      f.dependencies,
    ),
    (error) => {
      assert.equal(error.code, 'browser_close_failed')
      pending = error.pendingSession
      return !!pending?.close
    },
  )
  assert.equal(
    f.calls.some(([name]) => name === 'relay.close'),
    false,
  )
  closeFailed = false
  await pending.close()
  assert.deepEqual(
    f.calls.slice(-3).map(([name]) => name),
    ['context.close', 'relay.close', 'display.close'],
  )
})

test('launcher failures do not expose private diagnostics and release supporting processes', async (t) => {
  const f = fixture(t, {
    launch: () => {
      throw new Error('fixture-license private upstream diagnostics')
    },
  })
  await assert.rejects(createPlatformBrowserSession(f.options, f.dependencies), (error) => {
    assert.equal(error.code, 'browser_start_failed')
    assert.equal(error.message.includes('fixture-license'), false)
    return true
  })
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
