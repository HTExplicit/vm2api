import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { once } from 'node:events'
import vm from 'node:vm'
import {
  createBoundProxyRelay,
  createPlatformBrowserSession,
  fingerprintAtLocation,
  fingerprintFromLaunch,
  localeForLocation,
} from '../../src/lib/openai-api/platform-browser.mjs'

const original = {
  config: {
    'navigator.userAgent': 'Mozilla/5.0 Linux Firefox/156',
    'navigator.hardwareConcurrency': 4,
    'screen.width': 1920,
    'screen.height': 1080,
    'webGl:renderer': 'independent-device',
    'audio:seed': 18973,
    fonts: ['Arial', 'Noto Sans'],
    voices: [],
    timezone: 'America/New_York',
    'locale:language': 'en',
    'locale:region': 'US',
    'webrtc:ipv4': '192.0.2.1',
  },
  firefoxUserPrefs: { 'webgl.force-enabled': true },
}
const location = {
  ip: '198.51.100.1',
  country_code: 'GB',
  timezone: 'Europe/London',
  latitude: 51.5,
  longitude: -0.1,
}

test('location locale uses a launcher-supported language-region without an inferred script', async () => {
  const { normalizeLocale } = await import('camoufox/dist/locales.js')
  for (const requested of [undefined, 'C', 'en-Latn-US', 'en-US', 'de-DE']) {
    const result = localeForLocation({ country_code: 'US' }, undefined, requested)
    assert.equal(result, 'en-US')
    assert.equal(normalizeLocale(result).asString, 'en-US')
  }
  assert.equal(localeForLocation({ country_code: 'TW' }, undefined, 'zh-Hant-TW'), 'zh-TW')
})

test('concrete identity storage excludes proxy, environment and machine paths', () => {
  const json = JSON.stringify({ ...original.config, addons: ['/absolute/addon'] })
  const split = Math.floor(json.length / 3)
  const result = fingerprintFromLaunch({
    env: {
      CAMOU_CONFIG_3: json.slice(split * 2),
      HOME: 'private',
      CAMOU_CONFIG_1: json.slice(0, split),
      CAMOU_CONFIG_2: json.slice(split, split * 2),
    },
    proxy: { server: 'socks5://secret:secret@host' },
    executablePath: '/machine/path',
    firefoxUserPrefs: original.firefoxUserPrefs,
  })
  assert.deepEqual(result, original)
})

test('changing exit location preserves the full hardware identity and original record', () => {
  const result = fingerprintAtLocation(original, location, 'en-US')
  assert.equal(original.config.timezone, 'America/New_York')
  assert.equal(result.config.timezone, 'Europe/London')
  assert.equal(result.config['locale:region'], 'GB')
  assert.equal(result.config['webrtc:ipv4'], location.ip)
  assert.equal(result.config['audio:seed'], original.config['audio:seed'])
  assert.equal(result.config['screen.width'], 1920)
  assert.deepEqual(result.config.fonts, original.config.fonts)
  assert.equal(result.config['webGl:renderer'], 'independent-device')
  assert.equal(result.firefoxUserPrefs['network.proxy.socks_remote_dns'], true)
})

test('restoring the account uses saved identity and storage state before any navigation', async () => {
  const calls = []
  const storageState = { cookies: [], origins: [] }
  const context = {
    newPage: async () => ({ name: 'page' }),
    storageState: async (options) => ({ ...storageState, options }),
  }
  const overrides = {
    runtime: async () => ({
      executable: 'paired-browser',
      launchOptions() {
        throw new Error('must not regenerate saved identity')
      },
      getEnvVars: () => ({ CAMOU_CONFIG_1: '{}' }),
      getPrefEnvVars: () => ({}),
      Camoufox: async (options) => {
        calls.push(['launch', options])
        return {
          newContext: async (opts) => {
            calls.push(['context', opts])
            return context
          },
          close: async () => {
            calls.push(['browser.close'])
          },
        }
      },
    }),
    proxyLocation: async (proxy) => {
      calls.push(['location', proxy])
      return location
    },
    createRelay: async (proxy) => ({
      url: 'http://127.0.0.1:12345',
      close: async () => calls.push(['relay.close', proxy]),
    }),
  }
  const session = await createPlatformBrowserSession(
    {
      fingerprint: original,
      storageState,
      proxyUrl: 'socks5://bound:password@proxy.invalid:1080',
      onFingerprint: async (fp) => calls.push(['save', fp]),
    },
    overrides,
  )
  assert.equal(calls[0][1], 'socks5h://bound:password@proxy.invalid:1080')
  assert.deepEqual(
    calls.map((x) => x[0]),
    ['location', 'save', 'launch', 'context'],
  )
  const launch = calls.find((x) => x[0] === 'launch')[1].from_options
  assert.equal(launch.executablePath, 'paired-browser')
  assert.equal(launch.headless, true)
  assert.deepEqual(launch.proxy, { server: 'http://127.0.0.1:12345' })
  assert.deepEqual(calls.at(-1)[1].storageState, storageState)
  assert.deepEqual(await session.storageState(), { ...storageState, options: { indexedDB: true } })
  await session.close()
  await session.close()
  assert.deepEqual(
    calls.slice(-2).map((x) => x[0]),
    ['browser.close', 'relay.close'],
  )
})

test('failed identity persistence closes the relay without launching an unrecorded browser', async () => {
  let closed = false
  await assert.rejects(
    createPlatformBrowserSession(
      {
        fingerprint: original,
        proxyUrl: 'socks5://127.0.0.1:1080',
        onFingerprint: () => {
          throw new Error('save failed')
        },
      },
      {
        runtime: async () => ({
          Camoufox: () => {
            throw new Error('must not launch')
          },
        }),
        proxyLocation: async () => location,
        createRelay: async () => ({
          close: async () => {
            closed = true
          },
        }),
      },
    ),
    /save failed/,
  )
  assert.equal(closed, true)
})

test('new slots request complete randomly selected desktop identities while restored slots never regenerate', async () => {
  const generated = []
  const deps = {
    runtime: async () => ({
      executable: 'paired-browser',
      async launchOptions(options) {
        generated.push(options)
        return {
          env: { CAMOU_CONFIG_1: JSON.stringify({ ...original.config, identity: generated.length }) },
          firefoxUserPrefs: {},
        }
      },
      getEnvVars: () => ({}),
      getPrefEnvVars: () => ({}),
      Camoufox: async () => ({
        newContext: async () => ({
          newPage: async () => ({}),
          storageState: async () => ({ cookies: [], origins: [] }),
        }),
        close: async () => {},
      }),
    }),
    proxyLocation: async () => location,
    createRelay: async () => ({ url: 'http://127.0.0.1:12345', close: async () => {} }),
  }
  let saved
  const a = await createPlatformBrowserSession(
    {
      proxyUrl: 'socks5h://127.0.0.1:1080',
      onFingerprint: (fp) => {
        saved = fp
      },
    },
    deps,
  )
  const b = await createPlatformBrowserSession({ proxyUrl: 'socks5h://127.0.0.1:1081' }, deps)
  const restored = await createPlatformBrowserSession(
    { proxyUrl: 'socks5h://127.0.0.1:1080', fingerprint: saved },
    deps,
  )
  assert.equal(generated.length, 2)
  assert.deepEqual(generated[0].os, ['windows', 'macos', 'linux'])
  assert.notDeepEqual(a.fingerprint, b.fingerprint)
  assert.deepEqual(a.fingerprint, restored.fingerprint)
  await Promise.all([a.close(), b.close(), restored.close()])
})

test('cancellation during launch closes browser and relay before any page can open', async () => {
  const controller = new AbortController()
  const calls = []
  await assert.rejects(
    createPlatformBrowserSession(
      { fingerprint: original, proxyUrl: 'socks5h://127.0.0.1:1080', signal: controller.signal },
      {
        runtime: async () => ({
          executable: 'paired-browser',
          getEnvVars: () => ({}),
          getPrefEnvVars: () => ({}),
          Camoufox: async () => {
            controller.abort(new Error('cancelled'))
            return {
              newContext: () => {
                throw Error('must not create context')
              },
              close: async () => calls.push('browser'),
            }
          },
        }),
        proxyLocation: async () => location,
        createRelay: async () => ({ close: async () => calls.push('relay') }),
      },
    ),
    /cancelled/,
  )
  assert.deepEqual(calls, ['browser', 'relay'])
})

test('session storage is restored only for matching origins and saved with the encrypted browser state', async () => {
  let script
  let values
  let observed
  let restored
  const state = { cookies: [], origins: [], sessionStorage: { 'https://auth.openai.com': { step: 'same-slot' } } }
  const page = { evaluate: async () => ({ origin: 'https://platform.openai.com', values: { project: 'selected' } }) }
  const context = {
    exposeBinding: async (_name, callback) => {
      observed = callback
    },
    addInitScript: async (callback, argument) => {
      script = callback
      values = argument
    },
    newPage: async () => page,
    storageState: async () => ({ cookies: [], origins: [] }),
    pages: () => [page],
  }
  const session = await createPlatformBrowserSession(
    { fingerprint: original, storageState: state, proxyUrl: 'socks5h://127.0.0.1:1080' },
    {
      runtime: async () => ({
        executable: 'paired-browser',
        getEnvVars: () => ({}),
        getPrefEnvVars: () => ({}),
        Camoufox: async () => ({
          newContext: async (options) => {
            restored = options.storageState
            return context
          },
          close: async () => {},
        }),
      }),
      proxyLocation: async () => location,
      createRelay: async () => ({ close: async () => {} }),
    },
  )
  assert.equal(typeof script, 'function')
  assert.deepEqual(values, state.sessionStorage)
  assert.deepEqual(restored, { cookies: [], origins: [] })
  const webStorage = new Map()
  const storage = {
    get length() {
      return webStorage.size
    },
    setItem(key, value) {
      webStorage.set(key, value)
    },
  }
  const execute = (origin) =>
    vm.runInNewContext(`(${script.toString()})(origins)`, {
      origins: values,
      location: { origin, protocol: 'https:' },
      sessionStorage: storage,
      addEventListener() {},
    })
  execute('https://unrelated.example')
  assert.equal(webStorage.size, 0)
  execute('https://auth.openai.com')
  assert.equal(webStorage.get('step'), 'same-slot')
  webStorage.set('step', 'new-step-written-by-page')
  execute('https://auth.openai.com')
  assert.equal(webStorage.get('step'), 'new-step-written-by-page')
  const frame = { url: () => 'https://auth.openai.com/log-in' }
  await observed({ page: { mainFrame: () => frame }, frame }, 'https://auth.openai.com', { step: 'updated' })
  await observed({ page: { mainFrame: () => frame }, frame }, 'https://wrong-account.test', { private: 'rejected' })
  const saved = await session.storageState()
  assert.deepEqual(saved.sessionStorage, {
    'https://auth.openai.com': { step: 'updated' },
    'https://platform.openai.com': { project: 'selected' },
  })
  assert.deepEqual(state.sessionStorage, { 'https://auth.openai.com': { step: 'same-slot' } })
  await session.close()
})

test('a missing or unsupported account proxy never starts browser resources', async () => {
  for (const proxyUrl of ['', 'ftp://127.0.0.1']) {
    await assert.rejects(
      createPlatformBrowserSession(
        { proxyUrl },
        {
          runtime: () => {
            throw new Error('must not load runtime')
          },
        },
      ),
      (error) => ['proxy_required', 'proxy_unsupported'].includes(error.code),
    )
  }
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
