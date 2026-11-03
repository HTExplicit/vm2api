import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import {
  PlatformAdapter,
  createdPlatformKey,
  parsePlatformCreditSummary,
  platformIdentityObservation,
} from '../../src/lib/openai-api/platform-adapter.mjs'

test('profile observation does not accept another member email as the logged-in identity', () => {
  assert.equal(
    platformIdentityObservation('https://api.openai.com/dashboard/organizations/org-one/members', {
      user: { email: 'someone-else@example.com' },
      email: 'someone-else@example.com',
    }).email,
    null,
  )
  const profile = platformIdentityObservation('https://api.openai.com/dashboard/onboarding', {
    user: { email: 'owner@example.com', access_token: 'not-retained' },
    orgs: { data: [{ id: 'org-one', name: 'Personal' }] },
  })
  assert.deepEqual(profile, {
    email: 'owner@example.com',
    organizations: [{ id: 'org-one', name: 'Personal' }],
    projects: [],
    projectOrganizationIds: [],
    organizationId: null,
  })
})

test('observed project identities retain the organization of the real request', () => {
  assert.deepEqual(
    platformIdentityObservation(
      'https://api.openai.com/dashboard/organizations/org-one/projects',
      {
        data: [
          { id: 'proj_one', name: 'vm2api' },
          { id: 'not-a-project', name: 'other' },
        ],
      },
      'org-one',
    ).projects,
    [{ id: 'proj_one', name: 'vm2api', organizationId: 'org-one' }],
  )
})

test('project observation retains the official default marker without retaining unrelated fields', () => {
  assert.deepEqual(
    platformIdentityObservation(
      'https://api.openai.com/dashboard/organizations/org-one/projects',
      { data: [{ id: 'proj_default', name: 'Renamed default', is_default: true, secret: 'not-retained' }] },
      'org-one',
    ).projects,
    [{ id: 'proj_default', name: 'Renamed default', is_default: true, organizationId: 'org-one' }],
  )
})

test('the real POST onboarding organization projects preserve their owner, display title and initial marker', async () => {
  const adapter = new PlatformAdapter({ page: pageFixture(), email: 'owner@example.com' })
  const payload = {
    user: {
      email: 'owner@example.com',
      orgs: {
        data: [
          {
            id: 'org-one',
            name: 'internal-user-name',
            title: 'Personal',
            projects: { object: 'list', data: [], has_more: false },
          },
          {
            id: 'org-other',
            title: 'Other organization',
            projects: { data: [{ id: 'proj_other', title: 'Default project', is_initial: true }] },
          },
        ],
      },
    },
  }
  await adapter.observe(jsonResponse('/v1/dashboard/onboarding/login', payload, { method: 'POST' }))
  assert.equal(adapter.identity.organizations[0].name, 'Personal')
  assert.equal(adapter.identity.organizationId, null, 'organization membership does not select the active organization')
  assert.ok(adapter.projectLists.has('org-one'))
  payload.user.orgs.data[0].projects.data.push({
    id: 'proj_default',
    title: 'Default project',
    organization_id: 'org-one',
    is_initial: true,
  })
  await adapter.observe(jsonResponse('/v1/dashboard/onboarding/login', payload, { method: 'POST' }))
  adapter.identity.organizationId = 'org-one'
  assert.deepEqual(await adapter.ensureProject(), {
    id: 'proj_default',
    name: 'Default project',
    is_initial: true,
    organizationId: 'org-one',
  })
  adapter.dispose()
})

test('project permission arrays are not treated as an organization project list', async () => {
  const adapter = new PlatformAdapter({ page: pageFixture(), email: 'owner@example.com' })
  await adapter.observe(
    jsonResponse('/v1/dashboard/projects/proj_default/permissions', ['api.keys.read', 'api.keys.write'], {
      headers: { 'openai-organization': 'org-one' },
    }),
  )
  assert.equal(adapter.projectLists.has('org-one'), false)
  assert.deepEqual(adapter.identity.projects, [])
  adapter.dispose()
})

test('Billing JSON preserves decimal tokens, signed balances and unknown values without inferring totals', () => {
  const summary = parsePlatformCreditSummary(
    '{"total_available":37.12345678901234567890100,"total_paid_available":0.000}',
  )
  assert.equal(summary.balance, '37.123456789012345678901')
  assert.equal(summary.paid_balance, '0')
  assert.equal(parsePlatformCreditSummary('{"total_available":-0.000000100}').balance, '-0.0000001')
  assert.equal(parsePlatformCreditSummary('{"total_available":3.7e-9}').balance, '0.0000000037')
  assert.equal(parsePlatformCreditSummary('{"total_available":"-0.000"}').balance, '0')
  assert.equal(parsePlatformCreditSummary('{"total_granted":100,"total_used":63}').balance, null)
  assert.equal(parsePlatformCreditSummary('{"total_available":null}').paid_balance, null)
})

test('valid grant remainders retain precision and only current usable grants contribute expiry information', () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const seconds = (value) => Date.parse(value) / 1000
  const base = {
    id: 'grant-one',
    grant_amount: '10.000000000000000001',
    used_amount: '0.1',
    effective_at: seconds('2026-10-01T00:00:00Z'),
    expires_at: seconds('2026-11-12T00:00:00Z'),
  }
  const summary = parsePlatformCreditSummary(
    JSON.stringify({
      total_available: '37.0000',
      total_paid_available: '2.3400',
      grants: {
        data: [
          base,
          { ...base, id: 'grant-two', grant_amount: '1.100000000000000009', used_amount: '0' },
          { ...base, id: 'future', effective_at: seconds('2026-12-01T00:00:00Z') },
          { ...base, id: 'expired', expires_at: seconds('2026-10-31T00:00:00Z') },
          { ...base, id: 'scheduled', is_scheduled: true },
          { ...base, id: 'held', is_held_for_prepaid_transition: true },
          { ...base, id: 'exhausted', used_amount: base.grant_amount },
          { ...base, id: 'invalid-date', expires_at: 'not-a-time' },
          { ...base, id: 'permanent', expires_at: null },
        ],
      },
    }),
    now,
  )
  assert.equal(summary.balance, '37')
  assert.equal(summary.paid_balance, '2.34')
  assert.deepEqual(
    summary.grants.map((row) => row.id),
    ['grant-one', 'grant-two', 'permanent'],
  )
  assert.equal(summary.grants[0].remaining, '9.900000000000000001')
  assert.equal(summary.next_expiring_at, '2026-11-12T00:00:00.000Z')
  assert.equal(summary.next_expiring_amount, '11.00000000000000001')
})

test('new key capture requires a creation response and a complete unmasked secret', () => {
  const secret = 'sk-proj-fixture-only-full-secret-value'
  const url = 'https://api.openai.com/dashboard/organizations/org-one/api_keys'
  assert.deepEqual(createdPlatformKey(url, 'POST', { api_key: { id: 'key_one', secret } }), {
    apiKey: secret,
    remoteKeyId: 'key_one',
  })
  assert.equal(createdPlatformKey(url, 'GET', { api_key: { secret } }), null)
  assert.equal(createdPlatformKey(url, 'POST', { api_key: { secret: 'sk-proj-***last' } }), null)
  assert.equal(createdPlatformKey('https://api.openai.com/v1/responses', 'POST', { key: secret }), null)
})

function pageFixture() {
  const page = new EventEmitter()
  page.off = page.removeListener.bind(page)
  page.url = () => 'https://platform.openai.com/api-keys'
  page.getByRole = () => ({ count: async () => 0 })
  return page
}

function jsonResponse(path, payload, { method = 'GET', headers = {}, body } = {}) {
  const request = {
    url: () => `https://api.openai.com${path}`,
    method: () => method,
    headers: () => headers,
    postDataJSON: () => body,
  }
  return {
    url: () => `https://api.openai.com${path}`,
    ok: () => true,
    headers: () => ({ 'content-type': 'application/json' }),
    request: () => request,
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  }
}

function observeRequestResponse(adapter, response) {
  adapter.page.emit('request', response.request())
  return adapter.observe(response)
}

function beginCapture(adapter, options = {}) {
  adapter.identity = { ...adapter.identity, email: 'owner@example.com', organizationId: 'org-one' }
  return adapter.beginKeySetup({
    organizationId: 'org-one',
    projectId: 'proj_default',
    keyName: 'vm2api-account',
    ...options,
  })
}

const keyRequestOptions = {
  method: 'POST',
  headers: { 'openai-organization': 'org-one' },
  body: { name: 'vm2api-account', project_id: 'proj_default' },
}

function observeCreation(adapter, response) {
  adapter.page.emit('request', response.request())
  return adapter.observe(response)
}

for (const suffix of ['', '/']) {
  test(`key creation captures the official organization/project URL scope${suffix ? ' with a trailing slash' : ''} without body project fields`, async () => {
    const page = pageFixture()
    const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
    const saved = []
    const setup = beginCapture(adapter, { onKey: (key) => saved.push(key) })
    const response = jsonResponse(
      `/dashboard/organizations/org-one/projects/proj_default/api_keys${suffix}`,
      {
        result: 'success',
        key: {
          sensitive_id: 'sk-proj-scoped-url-fixture-secret',
          name: 'vm2api-account',
          organization: 'org-one',
          project: 'proj_default',
        },
      },
      {
        method: 'POST',
        headers: { 'openai-organization': 'org-one' },
        body: {
          action: 'create',
          name: 'vm2api-account',
          scopes: ['api.all'],
          admin_key: false,
          creation_source: 'platform',
        },
      },
    )
    await observeCreation(adapter, response)
    await adapter.observe(response)
    assert.equal(setup.request, response.request())
    assert.equal(setup.responseConfirmed, true)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].apiKey, 'sk-proj-scoped-url-fixture-secret')
    assert.equal(saved[0].organizationId, 'org-one')
    assert.equal(saved[0].projectId, 'proj_default')
    adapter.dispose()
  })
}

for (const variant of [
  { name: 'another URL organization', path: '/dashboard/organizations/org-other/projects/proj_default/api_keys' },
  { name: 'another URL project', path: '/dashboard/organizations/org-one/projects/proj_other/api_keys' },
  { name: 'conflicting organization header', headers: { 'openai-organization': 'org-other' } },
  { name: 'conflicting project header', headers: { 'openai-project': 'proj_other' } },
  { name: 'conflicting body organization', body: { organization_id: 'org-other' } },
  { name: 'conflicting body project', body: { project_id: 'proj_other' } },
  {
    name: 'an extra scoped path component',
    path: '/dashboard/organizations/org-one/projects/proj_default/other/api_keys',
  },
  { name: 'an invalid organization path ID', path: '/dashboard/organizations/other/projects/proj_default/api_keys' },
  { name: 'an invalid project path ID', path: '/dashboard/organizations/org-one/projects/other/api_keys' },
  { name: 'encoded scope separators', path: '/dashboard/organizations/org-one%2Fother/projects/proj_default/api_keys' },
]) {
  test(`key creation refuses scoped URL evidence with ${variant.name}`, async () => {
    const page = pageFixture()
    const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
    const saved = []
    const setup = beginCapture(adapter, { onKey: (key) => saved.push(key) })
    const response = jsonResponse(
      variant.path || '/dashboard/organizations/org-one/projects/proj_default/api_keys',
      { result: 'success', key: { sensitive_id: 'sk-proj-scoped-conflict-fixture-secret' } },
      {
        method: 'POST',
        headers: { 'openai-organization': 'org-one', ...variant.headers },
        body: {
          action: 'create',
          name: 'vm2api-account',
          project_id: 'proj_default',
          organization_id: 'org-one',
          ...variant.body,
        },
      },
    )
    await observeCreation(adapter, response)
    assert.equal(setup.request, null)
    assert.equal(setup.responseConfirmed, false)
    assert.equal(setup.domTainted, true)
    assert.equal(saved.length, 0)
    adapter.dispose()
  })
}

test('inspect verifies the observed user and rejects a different signed-in account', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  assert.equal((await adapter.inspect()).authenticated, false)
  await adapter.observe(jsonResponse('/dashboard/onboarding', { user: { email: 'owner@example.com' } }))
  assert.equal((await adapter.inspect()).authenticated, true)
  await adapter.observe(jsonResponse('/dashboard/onboarding', { user: { email: 'different@example.com' } }))
  await assert.rejects(adapter.inspect(), { code: 'platform_account_mismatch' })
  adapter.dispose()
  assert.equal(page.listenerCount('response'), 0)
})

function generalOrganizationFixture(options = {}) {
  const page = pageFixture()
  const state = {
    url: 'https://platform.openai.com/settings/organization/general',
    email: 'owner@example.com',
    value: 'org-one',
    currentOrganization: null,
    count: 1,
    visible: true,
    readOnly: true,
    tagName: 'INPUT',
    known: true,
    ...options,
  }
  const calls = { menus: 0, reads: 0 }
  const input = {
    isVisible: async () => state.visible,
    evaluate: async (fn) => fn({ tagName: state.tagName, readOnly: state.readOnly }),
    inputValue: async () => {
      calls.reads++
      return state.value
    },
  }
  page.url = () => state.url
  page.getByRole = (role, { name } = {}) => {
    if (role === 'textbox')
      return {
        count: async () => (name.test('Organization ID') ? state.count : 0),
        nth: () => input,
      }
    calls.menus++
    assert.fail('matching General organization must not open the organization/user menu')
  }
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  adapter.identity = {
    email: state.email,
    organizationId: state.currentOrganization,
    organizations: state.known
      ? [
          { id: 'org-one', name: 'Personal' },
          { id: 'org-two', name: 'Other' },
        ]
      : [],
    projects: [],
  }
  return { adapter, page, state, calls }
}

for (const currentOrganization of [null, 'org-two']) {
  test(`General page uniquely labelled readonly Organization ID confirms current organization over ${currentOrganization || 'missing metadata'}`, async () => {
    const f = generalOrganizationFixture({ currentOrganization })
    assert.equal((await f.adapter.inspect()).organizationId, 'org-one')
    await f.adapter.selectOrganization('org-one')
    assert.equal(f.calls.menus, 0)
    f.adapter.dispose()
  })
}

for (const variant of [
  { name: 'unverified email', email: null },
  { name: 'editable field', readOnly: false },
  { name: 'non-input field', tagName: 'DIV' },
  { name: 'multiple visible fields', count: 2 },
  { name: 'hidden field', visible: false },
  { name: 'invalid organization value', value: 'not-an-org' },
  { name: 'unknown organization', known: false },
  { name: 'another route', url: 'https://platform.openai.com/settings/organization/members' },
  { name: 'lookalike route', url: 'https://platform.openai.com/settings/organization/general/other' },
  { name: 'insecure origin', url: 'http://platform.openai.com/settings/organization/general' },
  { name: 'another origin', url: 'https://example.test/settings/organization/general' },
]) {
  test(`General organization evidence excludes ${variant.name}`, async () => {
    const f = generalOrganizationFixture(variant)
    assert.equal((await f.adapter.inspect()).organizationId ?? null, null)
    f.adapter.dispose()
  })
}

test('General organization evidence cannot authenticate a different signed-in email', async () => {
  const f = generalOrganizationFixture({ email: 'other@example.com' })
  await assert.rejects(f.adapter.inspect(), { code: 'platform_account_mismatch' })
  assert.equal(f.calls.reads, 0)
  assert.equal(f.adapter.identity.organizationId, null)
  f.adapter.dispose()
})

test('organization selection waits for a delayed General field before touching any menu', async () => {
  const f = generalOrganizationFixture({ count: 0 })
  const ready = setTimeout(() => {
    f.state.count = 1
  }, 20)
  try {
    await f.adapter.selectOrganization('org-one')
    assert.equal(f.adapter.identity.organizationId, 'org-one')
    assert.equal(f.calls.menus, 0)
    assert.equal(f.page.listenerCount('close'), 0)
  } finally {
    clearTimeout(ready)
    f.adapter.dispose()
  }
})

test('organization selection also accepts delayed network metadata before touching any menu', async () => {
  const f = generalOrganizationFixture({ count: 0 })
  const ready = setTimeout(() => {
    void f.adapter.observe(jsonResponse('/dashboard/projects', [], { headers: { 'openai-organization': 'org-one' } }))
  }, 20)
  try {
    await f.adapter.selectOrganization('org-one')
    assert.equal(f.calls.menus, 0)
    assert.equal(f.page.listenerCount('close'), 0)
  } finally {
    clearTimeout(ready)
    f.adapter.dispose()
  }
})

for (const stop of ['abort', 'close']) {
  test(`${stop} ends General organization readiness polling without a menu action or listeners`, async () => {
    const f = generalOrganizationFixture({ count: 0 })
    const abort = new AbortController()
    const waiting = f.adapter.selectOrganization('org-one', { signal: abort.signal })
    const reason = new Error('fixture configuration cancelled')
    const rejected =
      stop === 'abort'
        ? assert.rejects(waiting, (error) => error === reason)
        : assert.rejects(waiting, { code: 'platform_browser_closed' })
    await new Promise(setImmediate)
    assert.equal(f.page.listenerCount('close'), 1)
    if (stop === 'abort') abort.abort(reason)
    else f.page.emit('close')
    await rejected
    assert.equal(f.calls.menus, 0)
    assert.equal(f.page.listenerCount('close'), 0)
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
    f.adapter.dispose()
  })
}

test('General organization readiness has a bounded timeout and releases its listeners', async () => {
  const f = generalOrganizationFixture({ count: 0 })
  const abort = new AbortController()
  assert.equal(await f.adapter.waitForGeneralOrganization('org-one', { signal: abort.signal, timeout: 15 }), false)
  assert.equal(f.calls.menus, 0)
  assert.equal(f.page.listenerCount('close'), 0)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
  f.adapter.dispose()
})

test('initial identity inspection waits for a response that arrives after DOMContentLoaded', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  const abort = new AbortController()
  let completed = false
  const inspection = adapter.inspect({ timeout: 1000, signal: abort.signal }).then((state) => {
    completed = true
    return state
  })
  await new Promise(setImmediate)
  assert.equal(completed, false)
  page.emit('response', jsonResponse('/dashboard/organizations/org-one/members', { email: 'other@example.com' }))
  await new Promise(setImmediate)
  assert.equal(completed, false, 'unrelated member responses cannot complete identity verification')
  page.emit(
    'response',
    jsonResponse('/v1/dashboard/onboarding/login', {
      user: { email: 'owner@example.com', orgs: { data: [{ id: 'org-one', title: 'Personal' }] } },
    }),
  )
  const state = await inspection
  assert.equal(state.authenticated, true)
  assert.equal(state.email, 'owner@example.com')
  assert.deepEqual(state.organizations, [{ id: 'org-one', name: 'Personal' }])
  assert.equal(page.listenerCount('response'), 1, 'only the normal observer should remain')
  assert.equal(page.listenerCount('framenavigated'), 0)
  assert.equal(page.listenerCount('close'), 0)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
  adapter.dispose()
})

test('identity waiting returns unauthenticated for an actual login redirect', async () => {
  for (const target of ['https://auth.openai.com/log-in', 'https://platform.openai.com/auth/login']) {
    const page = pageFixture()
    const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
    const inspection = adapter.inspect({ timeout: 1000 })
    await new Promise(setImmediate)
    page.url = () => target
    page.emit('framenavigated')
    assert.deepEqual(await inspection, { authenticated: false, email: null, organizations: [] })
    assert.equal(page.listenerCount('framenavigated'), 0)
    adapter.dispose()
  }
})

test('identity timeout is a missing observation rather than proof of an expired session', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  await assert.rejects(adapter.inspect({ timeout: 15 }), { code: 'platform_identity_unavailable' })
  assert.equal(page.listenerCount('response'), 1)
  assert.equal(page.listenerCount('framenavigated'), 0)
  adapter.dispose()
})

test('identity waiting still rejects a delayed response for a different account', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  const inspection = adapter.inspect({ timeout: 1000 })
  const rejected = assert.rejects(inspection, { code: 'platform_account_mismatch' })
  await new Promise(setImmediate)
  page.emit('response', jsonResponse('/dashboard/onboarding', { user: { email: 'different@example.com' } }))
  await rejected
  assert.equal(page.listenerCount('framenavigated'), 0)
  adapter.dispose()
})

test('closing the browser ends identity waiting and releases its listeners', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  const inspection = adapter.inspect({ timeout: 1000 })
  const rejected = assert.rejects(inspection, { code: 'platform_browser_closed' })
  page.emit('close')
  await rejected
  assert.equal(page.listenerCount('close'), 0)
  assert.equal(page.listenerCount('framenavigated'), 0)
  adapter.dispose()
})

test('aborting identity waiting releases the retained browser without waiting for its timeout', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  const abort = new AbortController()
  const reason = new Error('background balance task promoted')
  const inspection = adapter.inspect({ timeout: 30_000, signal: abort.signal })
  const rejected = assert.rejects(inspection, (error) => error === reason)
  await new Promise(setImmediate)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1)
  abort.abort(reason)
  await rejected
  assert.equal(page.listenerCount('response'), 1)
  assert.equal(page.listenerCount('framenavigated'), 0)
  assert.equal(page.listenerCount('close'), 0)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
  assert.equal((await adapter.inspect()).authenticated, false, 'the same page remains available after cancellation')
  adapter.dispose()
})

test('an already aborted task never begins waiting or attaches browser listeners', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  const abort = new AbortController()
  const reason = new Error('task already cancelled')
  abort.abort(reason)
  await assert.rejects(adapter.inspect({ timeout: 30_000, signal: abort.signal }), (error) => error === reason)
  assert.equal(page.listenerCount('response'), 1)
  assert.equal(page.listenerCount('framenavigated'), 0)
  assert.equal(page.listenerCount('close'), 0)
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
  adapter.dispose()
})

test('Billing observations require the exact official GET and organization header', async () => {
  const adapter = new PlatformAdapter({ page: pageFixture(), email: 'owner@example.com' })
  const path = '/v1/dashboard/billing/credit_grants'
  await observeRequestResponse(adapter, jsonResponse(path, { total_available: '12.3' }))
  await observeRequestResponse(
    adapter,
    jsonResponse(
      path,
      { total_available: '12.3' },
      {
        method: 'POST',
        headers: { 'openai-organization': 'org-one' },
      },
    ),
  )
  assert.equal(adapter.creditSummaries.size, 0)
  await observeRequestResponse(
    adapter,
    jsonResponse(path, '{"total_available":12.1234567890123456789}', {
      headers: { 'openai-organization': 'org-one' },
    }),
  )
  await observeRequestResponse(
    adapter,
    jsonResponse(
      path,
      { total_available: '-1.20' },
      {
        headers: { 'openai-organization': 'org-two' },
      },
    ),
  )
  assert.equal(adapter.creditSummaries.get('org-one').balance, '12.1234567890123456789')
  assert.equal(adapter.creditSummaries.get('org-two').balance, '-1.2')
  assert.equal(adapter.identity.organizationId, null, 'a balance response does not change the selected identity')
  adapter.dispose()
})

test('Billing credentials come only from the successful exact request and require the matching observed identity', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({
    page,
    email: 'owner@example.com',
    now: () => Date.parse('2026-11-01T00:00:00Z'),
  })
  const headers = {
    authorization: 'Bearer fixture-billing-only-secret',
    'user-agent': 'fixture-fixed-desktop-ua',
    'openai-organization': 'org-one',
    accept: 'application/json',
    cookie: 'must-remain-in-canonical-cookie-storage',
    'content-length': 'not-a-billing-get-header',
  }
  await adapter.observe(jsonResponse('/dashboard/onboarding', { user: { email: 'owner@example.com' } }, { headers }))
  assert.equal(adapter.billingSessionFor('org-one'), null, 'onboarding authentication is not Billing authentication')
  adapter.identity.email = null
  const response = jsonResponse('/v1/dashboard/billing/credit_grants', '{"total_available":1.000000000000000000009}', {
    headers: { 'openai-organization': 'org-one' },
  })
  const request = {
    url: response.url,
    method: () => 'GET',
    headers: () => ({ 'openai-organization': 'org-one' }),
    allHeaders: async () => headers,
  }
  response.request = () => request
  await observeRequestResponse(adapter, response)
  assert.equal(
    adapter.billingSessionFor('org-one'),
    null,
    'credentials cannot be saved before account identity is known',
  )
  await adapter.observe(jsonResponse('/dashboard/onboarding', { user: { email: 'owner@example.com' } }))
  const saved = adapter.billingSessionFor('org-one')
  assert.deepEqual(saved, {
    organization_id: 'org-one',
    headers: {
      authorization: headers.authorization,
      'user-agent': headers['user-agent'],
      'openai-organization': 'org-one',
      accept: 'application/json',
    },
    captured_at: '2026-11-01T00:00:00.000Z',
    recovery_attempted: false,
  })
  saved.headers.authorization = 'changed-copy'
  assert.equal(adapter.billingSessionFor('org-one').headers.authorization, headers.authorization)
  assert.equal(adapter.billingSessionFor('org-other'), null)
  assert.equal(adapter.creditSummaries.get('org-one').balance, '1.000000000000000000009')
  adapter.identity.email = 'different@example.com'
  assert.equal(adapter.billingSessionFor('org-one'), null)
  adapter.identity.email = 'owner@example.com'
  adapter.dispose()
  assert.equal(adapter.billingSessionFor('org-one'), null, 'dispose releases retained authentication headers')
})

test('an unsuccessful, unscoped or incomplete Billing response cannot supply saved authentication', async () => {
  const adapter = new PlatformAdapter({ page: pageFixture(), email: 'owner@example.com' })
  adapter.identity.email = 'owner@example.com'
  const headers = { authorization: 'Bearer fixture-only', 'user-agent': 'fixture-ua', 'openai-organization': 'org-one' }
  const failed = jsonResponse('/v1/dashboard/billing/credit_grants', { total_available: '3' }, { headers })
  failed.ok = () => false
  await observeRequestResponse(adapter, failed)
  await observeRequestResponse(
    adapter,
    jsonResponse('/v1/dashboard/billing/credit_grants', { total_available: '3' }, { method: 'POST', headers }),
  )
  await observeRequestResponse(
    adapter,
    jsonResponse('/v1/dashboard/billing/credit_grants', { total_available: null }, { headers }),
  )
  await observeRequestResponse(
    adapter,
    jsonResponse(
      '/v1/dashboard/billing/credit_grants',
      { total_available: '3' },
      {
        headers: { authorization: headers.authorization, 'openai-organization': 'org-one' },
      },
    ),
  )
  assert.equal(adapter.billingSessionFor('org-one'), null)
  adapter.dispose()
})

test('readBalance waits for this organization and cannot reuse an earlier cached sample', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com', organizationId: 'org-one' })
  adapter.identity = {
    email: 'owner@example.com',
    organizations: [{ id: 'org-one', name: 'Personal' }],
    projects: [],
    organizationId: 'org-one',
  }
  adapter.creditSummaries.set('org-one', { balance: '99' })
  const response = jsonResponse(
    '/v1/dashboard/billing/credit_grants',
    { total_available: '37', total_paid_available: '2' },
    {
      headers: { 'openai-organization': 'org-one' },
    },
  )
  page.goto = async (url) => {
    assert.equal(adapter.creditSummaries.has('org-one'), false)
    page.url = () => url
    page.emit('request', response.request())
    page.emit('response', response)
  }
  const result = await adapter.readBalance()
  assert.equal(result.balance, '37')
  assert.equal(result.paid_balance, '2')
  assert.equal(result.displayName, 'Personal')
  adapter.dispose()
})

test('Billing can confirm the bound organization before a selected organization has been observed', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com', organizationId: 'org-one' })
  await adapter.observe(
    jsonResponse('/dashboard/onboarding', {
      user: { email: 'owner@example.com' },
      orgs: { data: [{ id: 'org-one', name: 'Personal' }] },
    }),
  )
  assert.equal(adapter.identity.organizationId, null)
  const response = jsonResponse('/v1/dashboard/billing/credit_grants', '{"total_available":36.999999999999999999}', {
    headers: { 'openai-organization': 'org-one' },
  })
  adapter.selectOrganization = async () => assert.fail('an unobserved selected organization cannot require a UI switch')
  page.goto = async (url) => {
    assert.equal(url, 'https://platform.openai.com/settings/organization/billing/overview')
    page.url = () => url
    const wrongOrganization = jsonResponse(
      '/v1/dashboard/billing/credit_grants',
      { total_available: '99' },
      {
        headers: { 'openai-organization': 'org-other' },
      },
    )
    page.emit('request', wrongOrganization.request())
    page.emit('response', wrongOrganization)
    page.emit('request', response.request())
    page.emit('response', response)
  }
  assert.equal((await adapter.readBalance()).balance, '36.999999999999999999')
  adapter.dispose()
})

test('a slower earlier response cannot overwrite the later organization balance', async () => {
  const adapter = new PlatformAdapter({ page: pageFixture(), email: 'owner@example.com' })
  const path = '/v1/dashboard/billing/credit_grants'
  const headers = { 'openai-organization': 'org-one' }
  const earlier = jsonResponse(path, null, { headers })
  let finishEarlier
  earlier.text = () =>
    new Promise((resolve) => {
      finishEarlier = resolve
    })
  const pending = observeRequestResponse(adapter, earlier)
  await observeRequestResponse(adapter, jsonResponse(path, { total_available: '30' }, { headers }))
  finishEarlier('{"total_available":37}')
  await pending
  assert.equal(adapter.creditSummaries.get('org-one').balance, '30')
  adapter.dispose()
})

test('key capture awaits the save callback before reporting the new key and does not capture twice', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  const saved = []
  beginCapture(adapter, { onKey: async (key) => saved.push(key) })
  const response = jsonResponse(
    '/dashboard/api_keys',
    { api_key: { id: 'key_one', secret: 'sk-proj-test-only-long-secret' } },
    keyRequestOptions,
  )
  await observeCreation(adapter, response)
  await adapter.observe(response)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].remoteKeyId, 'key_one')
  assert.equal(adapter.createdKey.apiKey, saved[0].apiKey)
  adapter.dispose()
})

test('a failed local secret save remains a task failure instead of silently succeeding', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  beginCapture(adapter, {
    onKey: async () => {
      throw new Error('fixture storage failure')
    },
  })
  await assert.rejects(
    observeCreation(
      adapter,
      jsonResponse('/dashboard/api_keys', { secret: 'sk-proj-test-only-long-secret' }, keyRequestOptions),
    ),
    /fixture storage failure/,
  )
  await assert.rejects(adapter.keySave, /fixture storage failure/)
  adapter.dispose()
})

test('an unobserved project list cannot be mistaken for an empty organization', async () => {
  const adapter = new PlatformAdapter({ page: pageFixture(), email: 'owner@example.com' })
  adapter.identity.organizationId = 'org-one'
  adapter.goto = async () => {}
  await assert.rejects(adapter.ensureProject(''), { code: 'platform_projects_unavailable' })
  adapter.dispose()
})

test('default project selection is scoped to the current organization and never picks the vm2api project', async () => {
  const adapter = new PlatformAdapter({ page: pageFixture(), email: 'owner@example.com' })
  adapter.identity.organizationId = 'org-one'
  adapter.projectLists.add('org-one')
  adapter.identity.projects = [
    { id: 'proj_vm2api', name: 'vm2api', organizationId: 'org-one' },
    { id: 'proj_one', name: 'Default project', organizationId: 'org-one' },
    { id: 'proj_other', name: 'Default project', organizationId: 'org-other' },
  ]
  adapter.goto = async () => {}
  assert.equal((await adapter.ensureProject()).id, 'proj_one')
  adapter.identity.organizationId = 'org-other'
  adapter.projectLists.add('org-other')
  assert.equal((await adapter.ensureProject()).id, 'proj_other')
  adapter.dispose()
})

test('the official default marker takes precedence over the display name', async () => {
  const adapter = new PlatformAdapter({ page: pageFixture(), email: 'owner@example.com' })
  adapter.identity.organizationId = 'org-one'
  adapter.projectLists.add('org-one')
  adapter.identity.projects = [
    { id: 'proj_named', name: 'Default project', organizationId: 'org-one' },
    { id: 'proj_default', name: 'Renamed default', is_default: true, organizationId: 'org-one' },
  ]
  adapter.goto = async () => {}
  assert.equal((await adapter.ensureProject()).id, 'proj_default')
  adapter.dispose()
})

test('missing or ambiguous default projects cannot trigger project creation', async () => {
  const page = pageFixture()
  page.getByRole = () => {
    throw new Error('project creation controls must never be queried')
  }
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  adapter.identity.organizationId = 'org-one'
  adapter.projectLists.add('org-one')
  adapter.identity.projects = [{ id: 'proj_vm2api', name: 'vm2api', organizationId: 'org-one' }]
  adapter.goto = async () => {}
  await assert.rejects(adapter.ensureProject(), { code: 'platform_default_project_unavailable' })
  adapter.identity.projects.push({ id: 'proj_first', name: 'DEFAULT PROJECT', organizationId: 'org-one' })
  assert.equal((await adapter.ensureProject()).id, 'proj_first')
  adapter.identity.projects.push({ id: 'proj_duplicate', name: 'Default project', organizationId: 'org-one' })
  await assert.rejects(adapter.ensureProject(), { code: 'platform_project_ambiguous' })
  adapter.dispose()
})

test('key configuration waits for a delayed entry, dialog and projects before targeting unlabelled fields', async () => {
  const page = pageFixture()
  const calls = []
  const one = (value) =>
    Object.assign(value, {
      count: async () => 1,
      nth: () => value,
      first: () => value,
      filter: (options) => {
        assert.deepEqual(options, { visible: true })
        return value
      },
      isVisible: async () => true,
      waitFor: async (options) => assert.ok([3_000, 15_000].includes(options.timeout)),
    })
  const projectButton = one({
    evaluate: async () => false,
    innerText: async () => 'Default project',
    click: async () => assert.fail('the already selected default project should not be reopened'),
  })
  const nameInput = one({ fill: async (value) => calls.push(['name', value]) })
  const fieldLabel = (control, selector) =>
    one({
      locator: (parent) => {
        assert.equal(parent, '..')
        return {
          locator: (actual) => {
            assert.equal(actual, selector)
            return control
          },
        }
      },
    })
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com', organizationId: 'org-one' })
  adapter.identity = {
    email: 'owner@example.com',
    organizations: [{ id: 'org-one', name: 'Personal' }],
    organizationId: 'org-one',
    projects: [],
  }
  adapter.goto = async (url) => calls.push(['goto', url])
  let neverSelected = false
  const dialog = one({
    getByText: (name) => {
      if (name.test('Loading projects...'))
        return {
          waitFor: async (options) => {
            assert.equal(options.state, 'hidden')
            calls.push(['projects-ready'])
            await adapter.observe(
              jsonResponse('/v1/dashboard/onboarding/login', {
                user: {
                  email: 'owner@example.com',
                  orgs: {
                    data: [
                      {
                        id: 'org-one',
                        title: 'Personal',
                        projects: { data: [{ id: 'proj_default', title: 'Default project', is_initial: true }] },
                      },
                    ],
                  },
                },
              }),
            )
          },
        }
      // Text lookup resolves the inner Name/Project div. Its immediate parent
      // is a label row, not the field container containing the control.
      if (name.test('Name') || name.test('Project'))
        return one({ locator: () => ({ locator: () => ({ count: async () => 0 }) }) })
      assert.fail('unexpected dialog label')
    },
    locator: (selector) => {
      assert.equal(selector, 'label')
      return {
        filter: ({ hasText }) => {
          if (hasText.test('NameOptional')) return fieldLabel(nameInput, 'input[type="text"]')
          if (hasText.test('Project')) return fieldLabel(projectButton, 'select, [role="button"]')
          if (hasText.test('Expiration')) return { filter: () => ({ count: async () => 0 }) }
          assert.fail('unexpected field label')
        },
      }
    },
    getByRole: (role, { name }) => {
      if (role === 'combobox') return { filter: () => ({ count: async () => 0 }) }
      assert.equal(role, 'button', 'Name must not be confused with the Expiration textbox')
      if (name.test('Expiration'))
        return one({
          click: async () => calls.push(['open-expiration']),
          evaluate: async () => false,
          innerText: async () => (neverSelected ? 'Never' : 'Expiration'),
        })
      return one({
        click: async () => {
          assert.equal(neverSelected, true, 'the required expiration must be selected before submitting')
          calls.push(['submit'])
          await observeCreation(
            adapter,
            jsonResponse(
              '/dashboard/api_keys',
              { api_key: { secret: 'sk-proj-default-fixture-secret' } },
              keyRequestOptions,
            ),
          )
        },
      })
    },
  })
  let dialogReady = false
  dialog.count = async () => (dialogReady ? 1 : 0)
  dialog.waitFor = async (options) => {
    assert.equal(options.state, 'visible')
    await Promise.resolve()
    dialogReady = true
    calls.push(['dialog-ready'])
  }
  let createReady = false
  const createButton = one({ click: async () => calls.push(['open-dialog']) })
  createButton.count = async () => (createReady ? 1 : 0)
  createButton.waitFor = async (options) => {
    assert.equal(options.state, 'visible')
    if (options.timeout < 20_000) throw new Error('the cold page is still loading')
    assert.equal(options.timeout, 30_000)
    await Promise.resolve()
    createReady = true
    calls.push(['create-ready'])
  }
  page.getByRole = (role, options) => {
    if (role === 'textbox') return { count: async () => 0 }
    if (role === 'row') assert.fail('remote key records must not decide whether a new local key can be configured')
    if (role === 'dialog') return dialog
    if (role === 'button') return createButton
    if (role === 'option') {
      assert.equal(options.name.test('Never'), true)
      return one({
        waitFor: async (options) => assert.equal(options.timeout, 3_000),
        click: async () => {
          neverSelected = true
          calls.push(['expiration', 'Never'])
        },
      })
    }
    assert.fail('unexpected page role')
  }
  const saved = []
  const result = await adapter.configure({ keyName: 'vm2api-account', onKey: async (value) => saved.push(value) })
  assert.equal(result.projectId, 'proj_default')
  assert.equal(saved[0].projectId, 'proj_default')
  assert.deepEqual(calls, [
    ['goto', 'https://platform.openai.com/api-keys'],
    ['create-ready'],
    ['open-dialog'],
    ['dialog-ready'],
    ['projects-ready'],
    ['name', 'vm2api-account'],
    ['open-expiration'],
    ['expiration', 'Never'],
    ['submit'],
  ])
  adapter.dispose()
})

function keyEntryFixture({ visible = [true], remoteKeys = [], timeout = false } = {}) {
  const page = pageFixture()
  const calls = []
  const entries = visible.map((shown, index) => ({
    shown,
    isVisible: async () => shown,
    waitFor: async (options) => {
      assert.equal(options.timeout, 30_000)
      if (timeout) throw new Error('entry wait timed out')
      assert.equal(shown, true, 'a hidden matching entry must never be awaited')
      calls.push(['ready', index])
    },
    click: async () => calls.push(['click', index]),
  }))
  const buttons = {
    first: () => assert.fail('filter out hidden entries before selecting the first match'),
    filter: (options) => {
      assert.deepEqual(options, { visible: true })
      const shown = entries.filter((entry) => entry.shown)
      return { count: async () => shown.length, nth: (index) => shown[index], first: () => shown[0] }
    },
  }
  page.getByRole = (role, options) => {
    if (role === 'textbox') return { count: async () => 0 }
    if (role === 'button') {
      assert.equal(options.name.test('Create new secret key'), true)
      assert.equal(options.name.test('Other Create new secret key action'), false)
      return buttons
    }
    if (role === 'row')
      assert.fail(`remote key records must be retained without gating creation: ${remoteKeys.join(', ')}`)
    if (role === 'dialog') throw new Error('fixture reached the creation dialog')
    assert.fail(`unexpected role ${role}`)
  }
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com', organizationId: 'org-one' })
  adapter.identity = {
    email: 'owner@example.com',
    organizations: [{ id: 'org-one', name: 'Personal' }],
    organizationId: 'org-one',
    projects: [],
  }
  adapter.goto = async () => {}
  return { adapter, calls, configure: () => adapter.configure({ keyName: 'vm2api-account' }) }
}

test('key entry ignores a hidden first match and clicks the unique visible control', async () => {
  const f = keyEntryFixture({ visible: [false, true] })
  await assert.rejects(f.configure(), /fixture reached the creation dialog/)
  assert.deepEqual(f.calls, [
    ['ready', 1],
    ['click', 1],
  ])
  f.adapter.dispose()
})

test('key entry rejects multiple visible controls without choosing or creating a key', async () => {
  const f = keyEntryFixture({ visible: [true, true] })
  await assert.rejects(f.configure(), {
    code: 'platform_page_changed',
    message: '官方页面的操作入口不唯一，请核对后重试配置',
  })
  assert.deepEqual(f.calls, [['ready', 0]])
  f.adapter.dispose()
})

for (const remoteKeys of [['Active'], ['Revoked'], ['Active', 'Revoked'], ['Unknown'], ['', 'Revoked']]) {
  test(`remote account key records (${remoteKeys.join(', ')}) do not block a new key when local secret is missing`, async () => {
    const f = keyEntryFixture({ remoteKeys })
    await assert.rejects(f.configure(), /fixture reached the creation dialog/)
    assert.deepEqual(f.calls, [
      ['ready', 0],
      ['click', 0],
    ])
    f.adapter.dispose()
  })
}

test('key entry timeout explains that configuration can be retried in the current window', async () => {
  const f = keyEntryFixture({ timeout: true })
  await assert.rejects(f.configure(), {
    code: 'platform_page_changed',
    message: '等待官方创建 API key 入口超时，可在当前窗口重试配置',
  })
  assert.deepEqual(f.calls, [])
  f.adapter.dispose()
})

function expirationFixture({
  native = false,
  combo = false,
  label = 'Expiration',
  linked = true,
  initial = '30 days',
  duplicate = false,
  confirm = true,
  choices = ['30 days', 'Never'],
} = {}) {
  let selected = initial
  let opened = false
  const calls = []
  const matches = (pattern, value) => (typeof pattern === 'string' ? pattern === value : pattern.test(value))
  const options = choices.map((value) => ({ textContent: value, visible: true }))
  const control = {
    tagName: native ? 'SELECT' : combo ? 'DIV' : 'BUTTON',
    visible: true,
    getAttribute: () => (combo ? 'combobox' : null),
    get selectedOptions() {
      return [{ textContent: selected }]
    },
    get textContent() {
      return selected
    },
    click: () => {
      opened = true
      calls.push('open')
    },
    selectOption: ({ label: value }) => {
      calls.push(value)
      if (confirm) selected = value
    },
  }
  const field = { textContent: label, visible: true, control }
  function locator(rows) {
    return {
      count: async () => rows.length,
      nth: (index) => locator(rows.slice(index, index + 1)),
      first: () => locator(rows.slice(0, 1)),
      filter: ({ visible, hasText }) =>
        locator(rows.filter((row) => (!visible || row.visible) && (!hasText || matches(hasText, row.textContent)))),
      evaluate: async (fn) => fn(rows[0]),
      innerText: async () => rows[0].textContent,
      locator: (selector) =>
        selector === '..' ? locator(rows) : locator(rows.map((row) => row.control).filter(Boolean)),
      getByRole: (role, { name }) =>
        locator(role === 'option' ? options.filter((option) => matches(name, option.textContent)) : []),
      waitFor: async () => {
        if (!rows.length) throw new Error('fixture option absent')
      },
      selectOption: async (value) => rows[0].selectOption(value),
      click: async () => {
        if (rows[0] === control) control.click()
        else {
          calls.push(rows[0].textContent)
          if (confirm) selected = rows[0].textContent
        }
      },
    }
  }
  const dialog = {
    getByLabel: (name) => locator(linked && matches(name, label) ? (duplicate ? [control, control] : [control]) : []),
    locator: () => locator([field]),
    getByRole: () => locator([]),
  }
  const page = pageFixture()
  page.getByRole = (role, { name }) =>
    locator(role === 'option' && opened ? options.filter((option) => matches(name, option.textContent)) : [])
  return { adapter: new PlatformAdapter({ page, email: 'owner@example.com' }), dialog, calls, selected: () => selected }
}

for (const variant of [
  { name: 'native select', native: true },
  { name: 'labelled combobox', combo: true },
  { name: 'label sibling value button', linked: false },
  { name: 'Chinese expiration field', native: true, label: '有效期限', choices: ['30 天', '永不过期'] },
  { name: 'Japanese expiration field', label: '有効期限', choices: ['30日', '期限なし'] },
]) {
  test(`expiration selection supports the ${variant.name} and verifies the result`, async () => {
    const f = expirationFixture(variant)
    await f.adapter.selectExpiration(f.dialog)
    assert.equal(f.selected(), variant.choices?.[1] || 'Never')
    assert.equal(f.calls.filter((value) => value !== 'open').length, 1)
    f.adapter.dispose()
  })
}

test('an already selected Never expiration is left in place', async () => {
  const f = expirationFixture({ initial: 'Never' })
  await f.adapter.selectExpiration(f.dialog)
  assert.deepEqual(f.calls, [])
  f.adapter.dispose()
})

for (const variant of [
  { name: 'ambiguous controls', duplicate: true },
  { name: 'unconfirmed selection', confirm: false },
  { name: 'organization policy without Never', native: true, choices: ['30 days', '90 days'] },
]) {
  test(`expiration selection yields to manual input for ${variant.name}`, async () => {
    const f = expirationFixture(variant)
    await assert.rejects(f.adapter.selectExpiration(f.dialog), { code: 'platform_expiration_required' })
    f.adapter.dispose()
  })
}

test('an unrelated complete secret in a dialog cannot be saved without a matching successful creation response', async () => {
  const page = pageFixture()
  page.getByRole = () => ({ evaluateAll: async () => ['sk-proj-unrelated-fixture-secret'] })
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  const saved = []
  beginCapture(adapter, { onKey: (key) => saved.push(key) })
  await adapter.continueKeySetup()
  assert.deepEqual(saved, [])
  adapter.dispose()
})

test('a delayed creation response from an ended setup cannot contaminate a newer setup', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  const saved = []
  const previous = beginCapture(adapter, { onKey: (key) => saved.push(key) })
  let finish
  const response = jsonResponse('/dashboard/api_keys', null, keyRequestOptions)
  response.json = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  page.emit('request', response.request())
  const observing = adapter.observe(response)
  adapter.endKeySetup(previous)
  const next = beginCapture(adapter, { onKey: (key) => saved.push(key) })
  finish({ secret: 'sk-proj-previous-setup-fixture-secret' })
  await observing
  assert.equal(next.responseConfirmed, false)
  assert.deepEqual(saved, [])
  adapter.dispose()
})

test('a response cannot claim an old request which predates the current setup', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  const response = jsonResponse(
    '/dashboard/api_keys',
    { secret: 'sk-proj-old-request-fixture-secret' },
    keyRequestOptions,
  )
  page.emit('request', response.request())
  const saved = []
  const setup = beginCapture(adapter, { onKey: (key) => saved.push(key) })
  await adapter.observe(response)
  assert.equal(setup.request, null)
  assert.equal(setup.responseConfirmed, false)
  assert.deepEqual(saved, [])
  adapter.dispose()
})
