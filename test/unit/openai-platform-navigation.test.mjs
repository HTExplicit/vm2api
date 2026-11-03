import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import {
  BILLING_CREDIT_GRANTS_URL,
  PlatformAdapter,
  navigatePlatformForObservation,
} from '../../src/lib/openai-api/platform-adapter.mjs'

const GENERAL_URL = 'https://platform.openai.com/settings/organization/general'
const BILLING_URL = 'https://platform.openai.com/settings/organization/billing/overview'
const nextTurn = () => new Promise(setImmediate)

function pageFixture() {
  const page = new EventEmitter()
  let currentUrl = 'https://platform.openai.com/api-keys'
  let closed = false
  const frame = { url: () => currentUrl }
  page.url = () => currentUrl
  page.mainFrame = () => frame
  page.isClosed = () => closed
  page.getByRole = () => ({ count: async () => 0 })
  page.navigate = (url) => {
    currentUrl = url
    page.emit('framenavigated', frame)
  }
  page.close = () => {
    closed = true
    page.emit('close')
  }
  page.goto = async (url) => page.navigate(url)
  return page
}

function billingResponse(organizationId = 'org-one', balance = '37.1234567890123456789') {
  const request = {
    url: () => BILLING_CREDIT_GRANTS_URL,
    method: () => 'GET',
    headers: () => ({
      authorization: 'Bearer offline-fixture-only',
      'user-agent': 'offline-desktop-fixture',
      'openai-organization': organizationId,
    }),
  }
  return {
    url: () => BILLING_CREDIT_GRANTS_URL,
    request: () => request,
    ok: () => true,
    headers: () => ({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ total_available: balance }),
  }
}

function adapterFixture(page = pageFixture()) {
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com', organizationId: 'org-one' })
  adapter.identity = {
    email: 'owner@example.com',
    organizations: [{ id: 'org-one', name: 'Personal' }],
    projects: [],
    organizationId: 'org-one',
  }
  return { page, adapter }
}

function publish(page, response) {
  page.emit('request', response.request())
  page.emit('response', response)
}

for (const continuation of [GENERAL_URL, 'https://auth.openai.com/log-in']) {
  test(`Firefox aborted entry accepts actual same-window continuation to ${continuation}`, async () => {
    const page = pageFixture()
    page.goto = async () => {
      setImmediate(() => page.navigate(continuation))
      throw new Error('page.goto: NS_BINDING_ABORTED')
    }
    await navigatePlatformForObservation(page, GENERAL_URL, { timeout: 100 })
    assert.equal(page.listenerCount('framenavigated'), 0)
    assert.equal(page.listenerCount('close'), 0)
  })
}

test('an old matching Platform page and unrelated frame navigation do not confirm aborted entry', async () => {
  const page = pageFixture()
  page.navigate(GENERAL_URL)
  page.goto = async () => {
    page.emit('framenavigated', { url: () => GENERAL_URL })
    throw new Error('NS_BINDING_ABORTED')
  }
  await assert.rejects(navigatePlatformForObservation(page, GENERAL_URL, { timeout: 15 }), {
    code: 'platform_navigation_timeout',
  })
  assert.equal(page.listenerCount('framenavigated'), 0)
})

test('a changed but unrelated main-frame URL does not confirm aborted entry', async () => {
  const page = pageFixture()
  page.goto = async () => {
    page.navigate('https://platform.openai.com/docs')
    throw new Error('NS_BINDING_ABORTED')
  }
  await assert.rejects(navigatePlatformForObservation(page, GENERAL_URL, { timeout: 15 }), {
    code: 'platform_navigation_timeout',
  })
})

test('other navigation errors propagate unchanged without another navigation', async () => {
  const page = pageFixture()
  const failure = new Error('NS_ERROR_PROXY_CONNECTION_REFUSED')
  let calls = 0
  page.goto = async () => {
    calls++
    throw failure
  }
  await assert.rejects(navigatePlatformForObservation(page, GENERAL_URL), (error) => error === failure)
  assert.equal(calls, 1)
  assert.equal(page.listenerCount('close'), 0)
})

for (const mode of ['cancel', 'close']) {
  test(`${mode} ends a pending aborted navigation and removes observers`, async () => {
    const page = pageFixture()
    const controller = new AbortController()
    page.goto = async () => {
      throw new Error('NS_BINDING_ABORTED')
    }
    const pending = navigatePlatformForObservation(page, GENERAL_URL, { signal: controller.signal })
    const rejected = assert.rejects(pending, mode === 'close' ? { code: 'platform_browser_closed' } : /cancel fixture/)
    await nextTurn()
    mode === 'close' ? page.close() : controller.abort(new Error('cancel fixture'))
    await rejected
    assert.equal(page.listenerCount('close'), 0)
    assert.equal(page.listenerCount('framenavigated'), 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
}

test('a Billing response arriving after the former 15 second limit uses the original 30 second deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-04T00:00:00Z') })
  const { page, adapter } = adapterFixture()
  let options
  page.goto = async (url, navigationOptions) => {
    options = navigationOptions
    page.navigate(url)
    setTimeout(() => publish(page, billingResponse()), 16_000)
  }
  const pending = adapter.readBalance()
  await nextTurn()
  assert.equal(options.timeout, 30_000)
  t.mock.timers.tick(16_000)
  const summary = await pending
  assert.equal(summary.balance, '37.1234567890123456789')
  assert.equal(adapter.billingSessionFor('org-one').headers['user-agent'], 'offline-desktop-fixture')
  assert.equal(page.listenerCount('response'), 1, 'only the adapter observer remains')
  adapter.dispose()
})

test('Billing aborted navigation accepts this read exact-org success and rechecks the account', async () => {
  const { page, adapter } = adapterFixture()
  let navigations = 0
  page.goto = async (url) => {
    navigations++
    setImmediate(() => {
      page.navigate(url)
      publish(page, billingResponse())
    })
    throw new Error('NS_BINDING_ABORTED')
  }
  assert.equal((await adapter.readBalance()).balance, '37.1234567890123456789')
  assert.equal(navigations, 1)
  adapter.dispose()
})

test('Billing cannot accept an earlier request that finishes during this read', async () => {
  const { page, adapter } = adapterFixture()
  const controller = new AbortController()
  const old = billingResponse()
  page.emit('request', old.request())
  let stillWaiting = true
  page.goto = async (url) => {
    page.navigate(url)
    page.emit('response', old)
  }
  const pending = adapter.readBalance({ signal: controller.signal }).then((result) => {
    stillWaiting = false
    return result
  })
  const rejected = assert.rejects(pending, /old request fixture/)
  await nextTurn()
  assert.equal(stillWaiting, true)
  controller.abort(new Error('old request fixture'))
  await rejected
  assert.equal(page.listenerCount('response'), 1)
  adapter.dispose()
})

for (const scenario of ['wrong organization', 'old sample', 'non-JSON response', 'login redirect']) {
  test(`Billing rejects ${scenario} without refreshing or reopening`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-04T00:00:00Z') })
    const { page, adapter } = adapterFixture()
    adapter.creditSummaries.set('org-one', { balance: '99' })
    let navigations = 0
    page.goto = async (url) => {
      navigations++
      page.navigate(scenario === 'login redirect' ? 'https://auth.openai.com/log-in' : url)
      if (scenario === 'wrong organization') publish(page, billingResponse('org-other'))
      if (scenario === 'non-JSON response') {
        const response = billingResponse()
        response.headers = () => ({ 'content-type': 'text/html' })
        publish(page, response)
      }
      throw new Error('NS_BINDING_ABORTED')
    }
    const rejected = assert.rejects(adapter.readBalance(), { code: 'platform_balance_unavailable' })
    await nextTurn()
    t.mock.timers.tick(30_000)
    await rejected
    assert.equal(navigations, 1)
    assert.equal(page.listenerCount('response'), 1)
    assert.equal(page.listenerCount('close'), 0)
    adapter.dispose()
  })
}

for (const scenario of ['different email', 'different organization', 'login page']) {
  test(`a fresh Billing result cannot authenticate a ${scenario}`, async () => {
    const { page, adapter } = adapterFixture()
    page.goto = async (url) => {
      page.navigate(scenario === 'login page' ? 'https://auth.openai.com/log-in' : url)
      if (scenario === 'different email') adapter.identity.email = 'different@example.com'
      if (scenario === 'different organization') adapter.identity.organizationId = 'org-other'
      publish(page, billingResponse())
    }
    await assert.rejects(adapter.readBalance(), {
      code:
        scenario === 'different email'
          ? 'platform_account_mismatch'
          : scenario === 'different organization'
            ? 'platform_organization_unconfirmed'
            : 'platform_login_required',
    })
    adapter.dispose()
  })
}

for (const mode of ['cancel', 'close']) {
  test(`${mode} ends Billing navigation and leaves no read observers`, async () => {
    const { page, adapter } = adapterFixture()
    const controller = new AbortController()
    page.goto = async () => {
      throw new Error('NS_BINDING_ABORTED')
    }
    const pending = adapter.readBalance({ signal: controller.signal })
    const rejected = assert.rejects(pending, mode === 'close' ? { code: 'platform_browser_closed' } : /cancel fixture/)
    await nextTurn()
    mode === 'close' ? page.close() : controller.abort(new Error('cancel fixture'))
    await rejected
    await nextTurn()
    assert.equal(page.listenerCount('response'), 1)
    assert.equal(page.listenerCount('framenavigated'), 0)
    assert.equal(page.listenerCount('close'), 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    adapter.dispose()
  })
}

test('the 30 second Billing limit includes a stalled response body after a slow navigation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-04T00:00:00Z') })
  const { page, adapter } = adapterFixture()
  let releaseBody
  page.goto = async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 20_000))
    page.navigate(url)
    const response = billingResponse()
    response.text = () => new Promise((resolve) => (releaseBody = resolve))
    publish(page, response)
  }
  const rejected = assert.rejects(adapter.readBalance(), { code: 'platform_balance_unavailable' })
  await nextTurn()
  t.mock.timers.tick(20_000)
  await nextTurn()
  t.mock.timers.tick(10_000)
  await rejected
  await nextTurn()
  assert.equal(page.listenerCount('close'), 0)
  assert.equal(page.listenerCount('response'), 1)
  releaseBody('{"total_available":"37"}')
  await adapter.settled()
  adapter.dispose()
})

test('a late body from an older request cannot replace the newer fresh read sample', async () => {
  const { page, adapter } = adapterFixture()
  const old = billingResponse('org-one', '99')
  page.emit('request', old.request())
  page.goto = async (url) => {
    page.navigate(url)
    publish(page, billingResponse('org-one', '37'))
  }
  assert.equal((await adapter.readBalance()).balance, '37')
  page.emit('response', old)
  await adapter.settled()
  assert.equal(adapter.creditSummaries.get('org-one').balance, '37')
  adapter.dispose()
})

test('an untracked old response arriving between fresh request and response cannot replace its balance or session', async () => {
  const { page, adapter } = adapterFixture()
  const untrackedOld = billingResponse('org-one', '99')
  const fresh = billingResponse('org-one', '37')
  page.goto = async (url) => {
    page.navigate(url)
    page.emit('request', fresh.request())
    page.emit('response', untrackedOld)
    await adapter.settled()
    assert.equal(adapter.creditSequence, 1, 'an unseen request cannot acquire a newer sequence at response time')
    assert.equal(adapter.creditSummaries.has('org-one'), false)
    assert.equal(adapter.billingSessionFor('org-one'), null)
    page.emit('response', fresh)
  }
  assert.equal((await adapter.readBalance()).balance, '37')
  assert.equal(adapter.creditSequences.get('org-one'), 1)
  assert.equal(adapter.billingSessionFor('org-one').organization_id, 'org-one')
  adapter.dispose()
})
