import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  PlatformAdapter,
  createdPlatformKey,
  parsePlatformCreditBalance,
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

test('Billing parser reads the explicitly labelled total without rounding or mistaking grant offers for balance', () => {
  assert.equal(
    parsePlatformCreditBalance('Pay as you go\nCredit balance\n$37.00000010\nAdd to credit balance'),
    '37.00000010',
  )
  assert.equal(parsePlatformCreditBalance('Credit balance: USD $1,234.50'), '1234.50')
  assert.equal(parsePlatformCreditBalance('Credit balance\n$0.00'), '0.00')
  assert.equal(parsePlatformCreditBalance('Credit balance\n-$0.01'), '-0.01')
  assert.equal(parsePlatformCreditBalance('Credit balance\n$-0.01'), '-0.01')
  assert.throws(() => parsePlatformCreditBalance('Monthly API credits $100\nClaimable now $37'), {
    code: 'platform_balance_unavailable',
  })
  assert.throws(() => parsePlatformCreditBalance('Credit balance $10\nAvailable credits $20'), {
    code: 'platform_balance_unavailable',
  })
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
