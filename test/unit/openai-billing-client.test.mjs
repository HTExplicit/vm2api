import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import fetch from 'node-fetch'
import { fetchBillingBalance } from '../../src/lib/openai-api/billing-client.mjs'
import { createBillingCookieJar } from '../../src/lib/openai-api/billing-cookies.mjs'
import { createProxyAgent } from '../../src/lib/vm/proxy-agent.mjs'
import { BILLING_CREDIT_GRANTS_URL } from '../../src/lib/openai-api/platform-adapter.mjs'

const session = {
  organization_id: 'org-one',
  headers: {
    authorization: 'Bearer fixture-billing-session',
    'openai-organization': 'org-one',
    'user-agent': 'fixture-fixed-desktop-identity',
    'accept-language': 'en-US,en;q=0.9',
    origin: 'https://platform.openai.com',
    referer: 'https://platform.openai.com/',
  },
}
const cookie = (name, value, extra = {}) => ({
  name,
  value,
  domain: 'api.openai.com',
  path: '/',
  expires: -1,
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
  ...extra,
})

async function fixture(t, handler) {
  const calls = { connects: 0, gets: 0, destroyed: 0 }
  const sockets = new Set()
  const server = http.createServer(handler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connect', (req, socket, head) => {
    calls.connects++
    assert.equal(req.url, 'billing.fixture:80')
    const upstream = net.connect(server.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(resolve)
      }),
  )
  const options = {
    session,
    organizationId: 'org-one',
    proxyUrl: `http://127.0.0.1:${server.address().port}`,
    createAgent(url) {
      assert.equal(url, options.proxyUrl)
      const agent = createProxyAgent(url)
      const destroy = agent.destroy.bind(agent)
      agent.destroy = () => {
        calls.destroyed++
        destroy()
      }
      return agent
    },
    fetchImpl(url, opts) {
      calls.gets++
      assert.equal(url, BILLING_CREDIT_GRANTS_URL)
      assert.equal(opts.redirect, 'manual')
      assert.equal(opts.method, 'GET')
      assert.ok(opts.signal instanceof AbortSignal)
      return fetch(url.replace('https://api.openai.com', 'http://billing.fixture'), opts)
    },
  }
  return { options, calls }
}

test('Billing HTTP uses the bound proxy, exact money parser and browser Cookie identity', async (t) => {
  let received = 0
  const { options, calls } = await fixture(t, (req, res) => {
    received++
    assert.equal(req.url, '/v1/dashboard/billing/credit_grants')
    for (const name of ['authorization', 'user-agent', 'openai-organization', 'accept-language'])
      assert.equal(req.headers[name], session.headers[name])
    assert.match(req.headers.cookie, /billing-cookie=preserved-cookie/)
    assert.doesNotMatch(req.headers.cookie, /other-path|other-host|expired/)
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': 'refreshed=updated-cookie; Path=/; HttpOnly; Secure',
    })
    res.end('{"total_available":-0.000000000000000000123,"total_paid_available":1.234500000000000000009}')
  })
  const unrelated = cookie('other-host', 'keep', {
    domain: 'auth.openai.com',
    priority: 'High',
    sourceScheme: 'Secure',
    sourcePort: 443,
    size: 14,
  })
  const storageState = {
    cookies: [
      cookie('billing-cookie', 'preserved-cookie'),
      cookie('other-path', 'keep', { path: '/other' }),
      unrelated,
      cookie('expired', 'drop', { expires: 1 }),
    ],
  }
  const before = structuredClone(storageState)
  const result = await fetchBillingBalance({ ...options, storageState })
  assert.equal(received, 1)
  assert.equal(calls.connects, 1)
  assert.equal(calls.gets, 1)
  assert.equal(result.summary.balance, '-0.000000000000000000123')
  assert.equal(result.summary.paid_balance, '1.234500000000000000009')
  assert.ok(
    result.cookies.some((c) => c.name === 'refreshed' && c.value === 'updated-cookie' && c.httpOnly && c.secure),
  )
  assert.deepEqual(
    result.cookies.find((c) => c.name === 'other-host'),
    unrelated,
  )
  assert.ok(result.cookies.some((c) => c.name === 'other-path'))
  assert.ok(!result.cookies.some((c) => c.name === 'expired'))
  assert.deepEqual(storageState, before)
  assert.equal(calls.destroyed, 1)
})

test('Cookie response merge preserves untouched metadata, applies expiry and deletion, and keeps empty values', async () => {
  const untouched = cookie('untouched', 'value', {
    domain: '.openai.com',
    path: '/settings',
    priority: 'High',
    sourceScheme: 'Secure',
    sourcePort: 443,
    partitionKey: { sourceOrigin: 'https://other.example', hasCrossSiteAncestor: true },
  })
  const jar = await createBillingCookieJar([
    cookie('deleted', 'value'),
    untouched,
    cookie('expiry', 'old', { sameSite: 'Strict' }),
  ])
  const before = Date.now() / 1000
  await jar.update(
    [
      'deleted=; Max-Age=0; Path=/; Secure',
      'empty=; Path=/; Secure',
      'expiry=new; Max-Age=60; Expires=Sat, 01 Jan 2000 00:00:00 GMT; Path=/; Secure; HttpOnly; SameSite=None; Priority=High',
      'wrong-domain=drop; Domain=another.example; Path=/; Secure',
      '__Host-invalid=drop; Domain=openai.com; Path=/; Secure',
      'insecure-none=drop; Path=/; SameSite=None',
    ],
    BILLING_CREDIT_GRANTS_URL,
  )
  const cookies = jar.cookies()
  assert.deepEqual(
    cookies.find((c) => c.name === 'untouched'),
    untouched,
  )
  assert.ok(!cookies.some((c) => ['deleted', 'wrong-domain', '__Host-invalid', 'insecure-none'].includes(c.name)))
  assert.equal(cookies.find((c) => c.name === 'empty').value, '')
  const refreshed = cookies.find((c) => c.name === 'expiry')
  assert.equal(refreshed.value, 'new')
  assert.equal(refreshed.sameSite, 'None')
  assert.equal(refreshed.priority, 'High')
  assert.equal(refreshed.session, false)
  assert.ok(refreshed.expires >= before + 59 && refreshed.expires <= Date.now() / 1000 + 61)
})

test('partitioned cookies use the Platform site without colliding with ordinary or other-site cookies', async () => {
  const partitionKey = { sourceOrigin: 'https://openai.com', hasCrossSiteAncestor: false }
  const other = cookie('shared', 'other-site', {
    partitionKey: { sourceOrigin: 'https://other.example', hasCrossSiteAncestor: false },
    priority: 'High',
  })
  const opaque = cookie('opaque', 'opaque-secret', { partitionKeyOpaque: true })
  const crossSite = cookie('cross', 'cross-secret', { partitionKey: { ...partitionKey, hasCrossSiteAncestor: true } })
  const jar = await createBillingCookieJar([
    cookie('shared', 'ordinary'),
    cookie('shared', 'platform', { partitionKey }),
    other,
    opaque,
    crossSite,
  ])
  const sent = await jar.header(BILLING_CREDIT_GRANTS_URL)
  assert.match(sent, /shared=ordinary/)
  assert.match(sent, /shared=platform/)
  assert.doesNotMatch(sent, /other-site|opaque-secret|cross-secret/)
  await jar.update(
    [
      'shared=refreshed-partition; Path=/; Secure; Partitioned',
      'shared=; Max-Age=0; Path=/; Secure',
      'invalid=drop; Path=/; Partitioned',
    ],
    BILLING_CREDIT_GRANTS_URL,
  )
  const cookies = jar.cookies()
  assert.deepEqual(
    cookies.find((c) => c.value === 'other-site'),
    other,
  )
  assert.deepEqual(
    cookies.find((c) => c.name === 'opaque'),
    opaque,
  )
  assert.deepEqual(
    cookies.find((c) => c.name === 'cross'),
    crossSite,
  )
  assert.ok(!cookies.some((c) => c.value === 'ordinary' || c.name === 'invalid'))
  assert.deepEqual(cookies.find((c) => c.value === 'refreshed-partition').partitionKey, partitionKey)
})

test('organization, credentials, proxy and early cancellation are checked before connecting', async () => {
  let opened = 0
  const base = {
    session,
    organizationId: 'org-one',
    proxyUrl: 'http://bound.fixture',
    createAgent: () => {
      opened++
      throw Error('must not connect')
    },
  }
  await assert.rejects(fetchBillingBalance({ ...base, organizationId: 'org-other' }), {
    code: 'platform_organization_unavailable',
  })
  await assert.rejects(fetchBillingBalance({ ...base, session: null }), { code: 'platform_login_required' })
  await assert.rejects(fetchBillingBalance({ ...base, proxyUrl: null }), { code: 'proxy_required' })
  await assert.rejects(fetchBillingBalance({ ...base, signal: AbortSignal.abort() }), { code: 'api_task_cancelled' })
  assert.equal(opened, 0)
})

test('only authentication errors request browser recovery; HTTP errors never leak response secrets', async (t) => {
  for (const [status, payload, expected] of [
    [401, {}, 'platform_login_required'],
    [403, { error: { code: 'session_expired' } }, 'platform_login_required'],
    [403, { error: { code: 'permission_denied', message: session.headers.authorization } }, 'billing_http_error'],
    [429, {}, 'billing_http_error'],
    [503, {}, 'billing_http_error'],
    [200, { total_used: 3 }, 'platform_balance_missing'],
  ]) {
    const { options, calls } = await fixture(t, (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
    await assert.rejects(fetchBillingBalance(options), (error) => {
      assert.equal(error.code, expected)
      assert.equal(String(error).includes(session.headers.authorization), false)
      return true
    })
    assert.equal(calls.gets, 1)
    assert.equal(calls.connects, 1)
    assert.equal(calls.destroyed, 1)
  }
})

test('invalid JSON is a balance error and redirects are returned without a follow-up request', async (t) => {
  for (const status of [200, 302]) {
    const { options, calls } = await fixture(t, (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', location: 'http://must-not-follow.invalid/' })
      res.end('not-json')
    })
    await assert.rejects(fetchBillingBalance(options), {
      code: status === 200 ? 'platform_balance_missing' : 'billing_http_error',
    })
    assert.equal(calls.gets, 1)
    assert.equal(calls.connects, 1)
  }
})

test('network exceptions cannot leak Authorization and SOCKS targets retain remote DNS', async () => {
  let destroyed = 0
  let seenProxy
  await assert.rejects(
    fetchBillingBalance({
      session,
      organizationId: 'org-one',
      proxyUrl: 'socks5://user:private@bound.fixture:1080',
      createAgent(url) {
        seenProxy = url
        return {
          destroy() {
            destroyed++
          },
        }
      },
      fetchImpl() {
        throw Object.assign(new Error(`Call log Authorization ${session.headers.authorization}`), {
          code: 'ECONNRESET',
        })
      },
    }),
    (error) => {
      assert.equal(error.code, 'billing_network_error')
      assert.equal(JSON.stringify({ message: error.message, ...error }).includes(session.headers.authorization), false)
      return true
    },
  )
  assert.equal(seenProxy, 'socks5h://user:private@bound.fixture:1080')
  assert.equal(destroyed, 1)
})

test('one deadline covers streaming bodies and cancellation also releases the proxy', async (t) => {
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    const { options, calls } = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"total_available":')
      if (cancel) controller.abort()
    })
    await assert.rejects(fetchBillingBalance({ ...options, signal: controller.signal, timeoutMs: 80 }), {
      code: cancel ? 'api_task_cancelled' : 'billing_timeout',
    })
    assert.ok(calls.destroyed >= 1)
    assert.equal(calls.gets, 1)
  }
})

test('cancellation ends a pending HTTP CONNECT handshake', async (t) => {
  const controller = new AbortController()
  let connected
  const accepted = new Promise((resolve) => {
    connected = resolve
  })
  const sockets = new Set()
  const proxy = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', () => {
      connected()
      controller.abort()
    })
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        proxy.close(resolve)
      }),
  )
  const call = fetchBillingBalance({
    session,
    organizationId: 'org-one',
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    signal: controller.signal,
  })
  await accepted
  await assert.rejects(call, { code: 'api_task_cancelled' })
  for (const socket of sockets) await once(socket, 'close')
  assert.equal(sockets.size, 0)
})

test('SOCKS cancellation returns promptly and its pending handshake stays bounded by the request deadline', async (t) => {
  const controller = new AbortController()
  let acceptedSocket
  const proxy = net.createServer((socket) => {
    acceptedSocket = socket
    socket.on('error', () => {})
    socket.once('data', (data) => {
      assert.equal(data[0], 5)
      controller.abort()
    })
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(
    () =>
      new Promise((resolve) => {
        acceptedSocket?.destroy()
        proxy.close(resolve)
      }),
  )
  await assert.rejects(
    fetchBillingBalance({
      session,
      organizationId: 'org-one',
      proxyUrl: `socks5://127.0.0.1:${proxy.address().port}`,
      signal: controller.signal,
      timeoutMs: 120,
    }),
    { code: 'api_task_cancelled' },
  )
  if (!acceptedSocket.destroyed) await once(acceptedSocket, 'close', { signal: AbortSignal.timeout(500) })
  assert.equal(acceptedSocket.destroyed, true)
})

test('SOCKS5 sends the Billing hostname to the proxy and refuses without direct fallback', async (t) => {
  let connections = 0
  let destination
  const sockets = new Set()
  const proxy = net.createServer((socket) => {
    connections++
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let greeting = true
    socket.on('data', (data) => {
      if (greeting) {
        assert.equal(data[0], 5)
        greeting = false
        socket.write(Buffer.from([5, 0]))
        return
      }
      assert.deepEqual([...data.subarray(0, 4)], [5, 1, 0, 3])
      destination = data.subarray(5, 5 + data[4]).toString()
      assert.equal(data.readUInt16BE(5 + data[4]), 443)
      socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]))
    })
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        proxy.close(resolve)
      }),
  )
  await assert.rejects(
    fetchBillingBalance({
      session,
      organizationId: 'org-one',
      proxyUrl: `socks5://127.0.0.1:${proxy.address().port}`,
    }),
    { code: 'billing_network_error' },
  )
  assert.equal(destination, 'api.openai.com')
  assert.equal(connections, 1)
})
