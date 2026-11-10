import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { createClaudeAuthDiagnostics } from '../../src/lib/oauth/claude-auth-diagnostics.mjs'

const PATH = '/api/auth/verify_magic_link'
const TIME = Date.parse('2026-11-10T10:11:12.000Z')

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(t, options = {}) {
  const page = new EventEmitter()
  const sent = []
  const diagnostics = createClaudeAuthDiagnostics({
    page,
    onDiagnostic: options.onDiagnostic || ((diagnostic) => sent.push(diagnostic)),
    now: () => TIME,
  })
  t.after(() => diagnostics.stop())
  return { page, sent, diagnostics }
}

function response({
  url = `https://claude.ai${PATH}`,
  status = 400,
  body = {},
  headers = {},
  json,
  headerValue,
  request,
  startTime = 0,
} = {}) {
  const authRequest = request || { url: () => url, timing: () => ({ startTime }) }
  return {
    request: () => authRequest,
    status: () => status,
    json: json || (async () => body),
    headerValue: headerValue || (async (name) => headers[name] || null),
  }
}

const settle = () => setImmediate()

test('failed Claude auth response exposes only short identifiers and an exact endpoint', async (t) => {
  const f = fixture(t)
  f.page.emit(
    'response',
    response({
      url: `https://claude.ai${PATH}?email=private@example.test&code=123456&token=private`,
      body: {
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'private@example.test code=123456',
          details: { error_code: 'invalid_magic_link', email: 'private@example.test' },
        },
        request_id: 'req_123-ABC',
        cookie: 'session-private',
      },
    }),
  )
  await settle()
  assert.deepEqual(f.diagnostics.current(), {
    endpoint: PATH,
    status: 400,
    errorType: 'authentication_error',
    errorCode: 'invalid_magic_link',
    requestId: 'req_123-ABC',
    timestamp: '2026-11-10T10:11:12.000Z',
    transportFailure: false,
  })
  assert.doesNotMatch(JSON.stringify(f.sent), /private|123456|cookie|message|https:/)
})

test('host, protocol and exact path filtering never parses unrelated response bodies', async (t) => {
  const f = fixture(t)
  let bodies = 0
  for (const url of [
    `http://claude.ai${PATH}`,
    `https://claude.ai.attacker.test${PATH}`,
    `https://claude.ai:444${PATH}`,
    `https://claude.com${PATH}`,
    `https://claude.ai${PATH}/extra`,
    'https://claude.ai/api/organizations',
    'invalid-url',
  ]) {
    f.page.emit(
      'response',
      response({
        url,
        json: async () => {
          bodies++
          return {}
        },
      }),
    )
  }
  await settle()
  assert.equal(bodies, 0)
  assert.equal(f.diagnostics.current(), null)
  assert.deepEqual(f.sent, [])
  for (const path of ['/api/auth/send_magic_link', '/api/auth/verify_google']) {
    f.page.emit('response', response({ url: `https://claude.ai${path}` }))
    await settle()
    assert.equal(f.diagnostics.current().endpoint, path)
  }
})

test('malformed identifiers are omitted and a validated request-id header can fill the request id', async (t) => {
  const f = fixture(t)
  f.page.emit(
    'response',
    response({
      body: {
        error: { type: 'private@example.test', details: { error_code: 'x'.repeat(101) } },
        request_id: 'private URL https://claude.ai',
      },
      headers: { 'request-id': 'also invalid', 'x-request-id': 'req_valid-123' },
    }),
  )
  await settle()
  assert.equal(f.diagnostics.current().errorType, null)
  assert.equal(f.diagnostics.current().errorCode, null)
  assert.equal(f.diagnostics.current().requestId, 'req_valid-123')
})

test('a newer successful auth response clears failure and invalidates an older pending body', async (t) => {
  const f = fixture(t)
  const oldBody = deferred()
  f.page.emit('response', response({ json: () => oldBody.promise }))
  const success = response({
    status: 200,
    json: () => {
      throw Error('success body must not be read')
    },
  })
  f.page.emit('response', success)
  oldBody.resolve({ error: { type: 'old_failure' } })
  await settle()
  assert.deepEqual(f.sent, [null])
  assert.equal(f.diagnostics.current(), null)
})

test('a slower older request failure arriving after a newer request succeeds cannot revive the failure', async (t) => {
  const f = fixture(t)
  let oldBodies = 0
  f.page.emit('response', response({ status: 200, startTime: 200 }))
  f.page.emit(
    'response',
    response({
      startTime: 100,
      json: async () => {
        oldBodies++
        return { error: { type: 'old_failure' } }
      },
    }),
  )
  await settle()
  assert.equal(oldBodies, 0)
  assert.equal(f.diagnostics.current(), null)
  assert.deepEqual(f.sent, [null])
})

test('a redirect does not clear a prior failure but invalidates an older pending response body', async (t) => {
  const f = fixture(t)
  f.page.emit('response', response({ startTime: 100, body: { error: { type: 'retained_failure' } } }))
  await settle()
  const pending = deferred()
  f.page.emit('response', response({ startTime: 200, json: () => pending.promise }))
  f.page.emit(
    'response',
    response({
      status: 302,
      startTime: 300,
      json: () => {
        throw Error('redirect body must not be read')
      },
    }),
  )
  pending.resolve({ error: { type: 'stale_failure' } })
  await settle()
  assert.equal(f.diagnostics.current().errorType, 'retained_failure')
  assert.deepEqual(
    f.sent.map((item) => item?.errorType ?? null),
    ['retained_failure'],
  )
})

test('slow old failure parsing cannot replace a newer failure and duplicate responses cannot revive it', async (t) => {
  const f = fixture(t)
  const oldBody = deferred()
  const older = response({ json: () => oldBody.promise })
  f.page.emit('response', older)
  const latest = response({ status: 403, body: { error: { type: 'latest_failure' } } })
  f.page.emit('response', latest)
  await settle()
  oldBody.resolve({ error: { type: 'old_failure' } })
  await settle()
  assert.equal(f.diagnostics.current().errorType, 'latest_failure')
  assert.equal(f.diagnostics.current().status, 403)
  f.page.emit('response', response({ status: 204 }))
  f.page.emit('response', older)
  f.page.emit('response', latest)
  await settle()
  assert.equal(f.diagnostics.current(), null)
  assert.deepEqual(
    f.sent.map((item) => item?.errorType ?? null),
    ['latest_failure', null],
  )
})

test('requestfailed records generic transport failure and never reads browser error text or request data', async (t) => {
  const f = fixture(t)
  const request = {
    url: () => `https://claude.ai${PATH}?token=private`,
    failure: () => {
      throw Error('must not read signed URL from failure')
    },
    postData: () => {
      throw Error('must not read code/email')
    },
    headers: () => {
      throw Error('must not read cookies')
    },
  }
  f.page.emit('requestfailed', request)
  f.page.emit('requestfailed', request)
  assert.deepEqual(f.sent, [
    {
      endpoint: PATH,
      status: null,
      errorType: null,
      errorCode: null,
      requestId: null,
      timestamp: '2026-11-10T10:11:12.000Z',
      transportFailure: true,
    },
  ])
  f.page.emit('response', response({ status: 200 }))
  f.page.emit('requestfailed', request)
  await settle()
  assert.equal(f.diagnostics.current(), null)
})

test('a body transport failure after successful response headers reports a generic failure for the same request', async (t) => {
  const f = fixture(t)
  const request = { url: () => `https://claude.ai${PATH}`, timing: () => ({ startTime: 100 }) }
  f.page.emit('response', response({ request, status: 200 }))
  assert.equal(f.diagnostics.current(), null)
  f.page.emit('requestfailed', request)
  assert.equal(f.diagnostics.current().transportFailure, true)
  assert.equal(f.diagnostics.current().status, null)
  assert.deepEqual(
    f.sent.map((item) => item?.transportFailure ?? null),
    [null, true],
  )
})

test('a body transport failure invalidates an already pending HTTP error body for the same request', async (t) => {
  const f = fixture(t)
  const body = deferred()
  const request = { url: () => `https://claude.ai${PATH}`, timing: () => ({ startTime: 100 }) }
  f.page.emit('response', response({ request, status: 400, json: () => body.promise }))
  f.page.emit('requestfailed', request)
  body.resolve({ error: { type: 'stale_http_failure' } })
  await settle()
  assert.equal(f.diagnostics.current().transportFailure, true)
  assert.equal(f.diagnostics.current().errorType, null)
  assert.equal(f.sent.length, 1)
})

test('duplicate failed events and a late response from that request cannot replace a newer success', async (t) => {
  const f = fixture(t)
  const request = { url: () => `https://claude.ai${PATH}`, timing: () => ({ startTime: 100 }) }
  f.page.emit('requestfailed', request)
  f.page.emit('response', response({ status: 200, startTime: 200 }))
  f.page.emit('requestfailed', request)
  f.page.emit(
    'response',
    response({
      request,
      status: 400,
      json: () => {
        throw Error('late body must not be read')
      },
    }),
  )
  await settle()
  assert.equal(f.diagnostics.current(), null)
  assert.deepEqual(
    f.sent.map((item) => item?.transportFailure ?? null),
    [true, null],
  )
})

test('an unavailable response body and headers retain only safe HTTP failure metadata', async (t) => {
  const f = fixture(t)
  f.page.emit(
    'response',
    response({
      status: 502,
      json: async () => {
        throw Error('page closed while https://claude.ai/?token=private')
      },
      headerValue: async () => {
        throw Error('browser closed')
      },
    }),
  )
  await settle()
  assert.deepEqual(f.diagnostics.current(), {
    endpoint: PATH,
    status: 502,
    errorType: null,
    errorCode: null,
    requestId: null,
    timestamp: '2026-11-10T10:11:12.000Z',
    transportFailure: false,
  })
})

test('stop removes its listeners, clears diagnostics and ignores pending body completion', async (t) => {
  const f = fixture(t)
  const body = deferred()
  f.page.emit('response', response({ body: { error: { type: 'first_failure' } } }))
  await settle()
  f.page.emit('response', response({ json: () => body.promise }))
  assert.equal(f.page.listenerCount('response'), 1)
  assert.equal(f.page.listenerCount('requestfailed'), 1)
  f.diagnostics.stop()
  f.diagnostics.stop()
  body.resolve({ error: { type: 'late_failure' } })
  await settle()
  assert.equal(f.page.listenerCount('response'), 0)
  assert.equal(f.page.listenerCount('requestfailed'), 0)
  assert.equal(f.diagnostics.current(), null)
  assert.deepEqual(
    f.sent.map((item) => item?.errorType ?? null),
    ['first_failure', null],
  )
  f.page.emit('requestfailed', { url: () => `https://claude.ai${PATH}` })
  assert.equal(f.sent.length, 2)
})

test('a closing diagnostic consumer never rejects the passive listener or cleanup', async (t) => {
  let calls = 0
  const f = fixture(t, {
    onDiagnostic: () => {
      calls++
      throw Error('WebSocket closed')
    },
  })
  f.page.emit('response', response({ status: 403 }))
  await settle()
  assert.equal(f.diagnostics.current().status, 403)
  assert.doesNotThrow(() => f.diagnostics.stop())
  assert.equal(calls, 2)
})
