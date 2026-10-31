import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
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

function jsonResponse(path, payload, { method = 'GET', headers = {} } = {}) {
  return {
    url: () => `https://api.openai.com${path}`,
    ok: () => true,
    headers: () => ({ 'content-type': 'application/json' }),
    request: () => ({ method: () => method, headers: () => headers }),
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  }
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

test('Billing observations require the exact official GET and organization header', async () => {
  const adapter = new PlatformAdapter({ page: pageFixture(), email: 'owner@example.com' })
  const path = '/v1/dashboard/billing/credit_grants'
  await adapter.observe(jsonResponse(path, { total_available: '12.3' }))
  await adapter.observe(
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
  await adapter.observe(
    jsonResponse(path, '{"total_available":12.1234567890123456789}', {
      headers: { 'openai-organization': 'org-one' },
    }),
  )
  await adapter.observe(
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
  let resolveObserved
  page.waitForResponse = (predicate) => {
    assert.equal(predicate(response), true)
    return new Promise((resolve) => {
      resolveObserved = resolve
    })
  }
  adapter.goto = async () => {
    assert.equal(adapter.creditSummaries.has('org-one'), false)
    await adapter.observe(response)
    resolveObserved(response)
  }
  const result = await adapter.readBalance()
  assert.equal(result.balance, '37')
  assert.equal(result.paid_balance, '2')
  assert.equal(result.displayName, 'Personal')
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
  const pending = adapter.observe(earlier)
  await adapter.observe(jsonResponse(path, { total_available: '30' }, { headers }))
  finishEarlier('{"total_available":37}')
  await pending
  assert.equal(adapter.creditSummaries.get('org-one').balance, '30')
  adapter.dispose()
})

test('key capture awaits the save callback before reporting the new key and does not capture twice', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  const saved = []
  adapter.keyCallback = async (key) => saved.push(key)
  const response = jsonResponse(
    '/dashboard/api_keys',
    { api_key: { id: 'key_one', secret: 'sk-proj-test-only-long-secret' } },
    { method: 'POST' },
  )
  await adapter.observe(response)
  await adapter.observe(response)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].remoteKeyId, 'key_one')
  assert.equal(adapter.createdKey.apiKey, saved[0].apiKey)
  adapter.dispose()
})

test('a failed local secret save remains a task failure instead of silently succeeding', async () => {
  const page = pageFixture()
  const adapter = new PlatformAdapter({ page, email: 'owner@example.com' })
  adapter.keyCallback = async () => {
    throw new Error('fixture storage failure')
  }
  await assert.rejects(
    adapter.observe(
      jsonResponse('/dashboard/api_keys', { secret: 'sk-proj-test-only-long-secret' }, { method: 'POST' }),
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

test('project reuse checks both the persisted project ID and the current organization', async () => {
  const adapter = new PlatformAdapter({ page: pageFixture(), email: 'owner@example.com' })
  adapter.identity.organizationId = 'org-one'
  adapter.projectLists.add('org-one')
  adapter.identity.projects = [
    { id: 'proj_one', name: 'vm2api', organizationId: 'org-one' },
    { id: 'proj_other', name: 'vm2api', organizationId: 'org-other' },
  ]
  adapter.goto = async () => {}
  assert.equal((await adapter.ensureProject('')).id, 'proj_one')
  assert.equal((await adapter.ensureProject('proj_one')).id, 'proj_one')
  await assert.rejects(adapter.ensureProject('proj_other'), { code: 'platform_project_unavailable' })
  adapter.identity.projects.push({ id: 'proj_duplicate', name: 'vm2api', organizationId: 'org-one' })
  await assert.rejects(adapter.ensureProject(''), { code: 'platform_project_ambiguous' })
  adapter.dispose()
})
