import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { request } from 'playwright-core'
import { fetchBillingBalance } from '../../src/lib/openai-api/billing-client.mjs'
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
  captured_at: '2026-11-01T00:00:00Z',
}

async function fixture(t, handler) {
  const server = http.createServer(handler)
  server.on('connect', (req, socket, head) => {
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
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const calls = { contexts: 0, disposed: 0, relayClosed: 0, gets: 0 }
  const options = {
    session,
    organizationId: 'org-one',
    proxyUrl: 'socks5h://bound-account.fixture:1080',
    async createRelay(proxyUrl) {
      assert.equal(proxyUrl, options.proxyUrl)
      return {
        url: `http://127.0.0.1:${server.address().port}`,
        async close() {
          calls.relayClosed++
        },
      }
    },
    requestImpl: {
      async newContext(contextOptions) {
        calls.contexts++
        calls.options = contextOptions
        const context = await request.newContext(contextOptions)
        return {
          async get(url, getOptions) {
            calls.gets++
            assert.equal(url, BILLING_CREDIT_GRANTS_URL)
            assert.equal(getOptions.timeout, 30_000)
            assert.equal(getOptions.maxRedirects, 0)
            assert.equal(getOptions.maxRetries, 0)
            return context.get(url.replace('https://api.openai.com', 'http://billing.fixture'), getOptions)
          },
          storageState: () => context.storageState(),
          async dispose() {
            calls.disposed++
            await context.dispose()
          },
        }
      },
    },
  }
  return { options, calls }
}

test('standalone Billing HTTP restores identity and cookies through the bound proxy and keeps exact money', async (t) => {
  let received = 0
  const { options, calls } = await fixture(t, (req, res) => {
    received++
    assert.equal(req.url, '/v1/dashboard/billing/credit_grants')
    assert.equal(req.headers.authorization, session.headers.authorization)
    assert.equal(req.headers['user-agent'], session.headers['user-agent'])
    assert.equal(req.headers['openai-organization'], 'org-one')
    assert.equal(req.headers['accept-language'], session.headers['accept-language'])
    assert.match(req.headers.cookie, /billing-cookie=preserved-cookie/)
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'refreshed=updated-cookie; Path=/' })
    res.end('{"total_available":-0.000000000000000000123,"total_paid_available":1.234500000000000000009}')
  })
  const storageState = {
    cookies: [
      {
        name: 'billing-cookie',
        value: 'preserved-cookie',
        domain: 'billing.fixture',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [{ origin: 'https://platform.openai.com', localStorage: [{ name: 'site-state', value: 'retained' }] }],
    sessionStorage: [{ origin: 'https://platform.openai.com', entries: [['session-key', 'retained']] }],
  }
  const result = await fetchBillingBalance({ ...options, storageState })
  assert.equal(received, 1)
  assert.equal(result.summary.balance, '-0.000000000000000000123')
  assert.equal(result.summary.paid_balance, '1.234500000000000000009')
  assert.ok(result.cookies.some((cookie) => cookie.name === 'refreshed' && cookie.value === 'updated-cookie'))
  assert.deepEqual(storageState.origins[0].localStorage, [{ name: 'site-state', value: 'retained' }])
  assert.deepEqual(calls.options.storageState.origins, [])
  assert.equal(calls.disposed, 1)
  assert.equal(calls.relayClosed, 1)
})

test('the current organization must match the captured Billing session before any connection is opened', async () => {
  let opened = false
  await assert.rejects(
    fetchBillingBalance({
      session,
      organizationId: 'org-other',
      proxyUrl: 'http://bound.fixture',
      createRelay: async () => {
        opened = true
      },
    }),
    { code: 'platform_organization_unavailable' },
  )
  assert.equal(opened, false)
})

test('missing Billing credentials or proxy do not silently connect directly', async () => {
  await assert.rejects(fetchBillingBalance({ organizationId: 'org-one' }), { code: 'platform_login_required' })
  await assert.rejects(fetchBillingBalance({ session, organizationId: 'org-one' }), { code: 'proxy_required' })
})

test('only authentication failures request browser recovery and every HTTP failure releases resources', async (t) => {
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
    assert.equal(calls.disposed, 1)
    assert.equal(calls.relayClosed, 1)
  }
})

test('raw Playwright network exceptions cannot leak Billing Authorization even when they contain a code', async () => {
  let disposed = 0
  let relayClosed = 0
  const options = {
    session,
    organizationId: 'org-one',
    proxyUrl: 'http://bound.fixture',
    createRelay: async () => ({
      url: 'http://relay.fixture',
      async close() {
        relayClosed++
      },
    }),
    requestImpl: {
      async newContext() {
        return {
          async get() {
            throw Object.assign(new Error(`Call log: Authorization: ${session.headers.authorization}`), {
              code: 'ECONNRESET',
            })
          },
          async dispose() {
            disposed++
          },
        }
      },
    },
  }
  await assert.rejects(fetchBillingBalance(options), (error) => {
    assert.equal(error.code, 'billing_network_error')
    assert.equal(JSON.stringify({ message: error.message, ...error }).includes(session.headers.authorization), false)
    return true
  })
  assert.equal(disposed, 1)
  assert.equal(relayClosed, 1)
})

test('timeouts and cancellation are short safe errors and close the HTTP context and relay', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    let disposed = 0
    let closed = 0
    const options = {
      session,
      organizationId: 'org-one',
      proxyUrl: 'http://bound.fixture',
      signal: controller.signal,
      createRelay: async () => ({
        url: 'http://relay.fixture',
        async close() {
          closed++
        },
      }),
      requestImpl: {
        async newContext() {
          return {
            async get() {
              if (cancel) controller.abort()
              throw Object.assign(new Error(`Authorization ${session.headers.authorization}`), {
                name: cancel ? 'Error' : 'TimeoutError',
              })
            },
            async dispose() {
              disposed++
            },
          }
        },
      },
    }
    await assert.rejects(fetchBillingBalance(options), { code: cancel ? 'api_task_cancelled' : 'billing_timeout' })
    assert.ok(disposed >= 1)
    assert.equal(closed, 1)
  }
})
