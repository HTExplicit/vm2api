import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ApiScheduler,
  stripPrefix,
  resolveUpstreamPool,
  modelIdsForEndpoint,
} from '../../src/lib/pool/api-scheduler.mjs'

const ep = (over = {}) => ({
  id: 'ep1',
  name: 'one',
  disabled: false,
  prefix: 'team',
  priority: 0,
  disable_cooling: false,
  models: [
    { name: 'claude-sonnet-4-6', alias: 'sonnet' },
    { name: 'claude-opus-4-6', alias: 'opus' },
    { name: 'upstream-a', alias: 'pool' },
    { name: 'upstream-b', alias: 'pool' },
  ],
  api_key_entries: [
    { id: 'k1', api_key: 'aaaa', disabled: false },
    { id: 'k2', api_key: 'bbbb', disabled: false },
  ],
  ...over,
})

test('prefix strip and catalog ids', () => {
  assert.equal(stripPrefix('team/sonnet', 'team'), 'sonnet')
  const ids = modelIdsForEndpoint(ep())
  assert.ok(ids.includes('sonnet'))
  assert.ok(ids.includes('team/sonnet'))
})

test('same alias builds upstream name pool', () => {
  assert.deepEqual(resolveUpstreamPool(ep(), 'pool'), ['upstream-a', 'upstream-b'])
  assert.deepEqual(resolveUpstreamPool(ep(), 'team/pool'), ['upstream-a', 'upstream-b'])
})

test('grouped round-robin walks keys then endpoints', () => {
  const s = new ApiScheduler()
  const a = ep({
    id: 'a',
    prefix: '',
    models: [{ name: 'u1', alias: 'm' }],
    api_key_entries: [{ id: 'a1', api_key: '1', disabled: false }],
  })
  const b = ep({
    id: 'b',
    prefix: '',
    models: [{ name: 'u2', alias: 'm' }],
    api_key_entries: [{ id: 'b1', api_key: '2', disabled: false }],
  })
  s.reload([a, b])
  const first = s.pick('m')
  const second = s.pick('m')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.notEqual(first.endpoint.id, second.endpoint.id)
})

test('catalog is unique aliases', () => {
  const s = new ApiScheduler()
  s.reload([ep({ prefix: '' }), ep({ id: 'ep2', prefix: '', name: 'two' })])
  const cat = s.catalog()
  const ids = cat.data.map((x) => x.id)
  assert.equal(ids.filter((id) => id === 'sonnet').length, 1)
})

test('account API-key picker and catalog use the same explicit account scope', () => {
  const a = { id: 'a', api_key: 'secret-a', source_vm_id: 'vm-a', source_account_id: 'acct-a' }
  const b = { id: 'b', api_key: 'secret-b', source_vm_id: 'vm-b', source_account_id: 'acct-b' }
  const runtime = new Map([
    ['vm-a', { accountId: 'acct-a', enabled: true, proxyUrl: 'socks5h://proxy-a:1080' }],
    ['vm-b', { accountId: 'acct-b', enabled: true, proxyUrl: 'socks5h://proxy-b:1080' }],
  ])
  const s = new ApiScheduler({ resolveAccountKey: (key) => runtime.get(key.source_vm_id) })
  s.reload([
    ep({ kind: 'openai', id: 'a', prefix: '', models: [{ name: 'gpt-a', alias: 'a' }], api_key_entries: [a] }),
    ep({ kind: 'openai', id: 'b', prefix: '', models: [{ name: 'gpt-b', alias: 'b' }], api_key_entries: [b] }),
    ep({ id: 'plain', prefix: '', models: [{ name: 'plain', alias: 'plain' }] }),
  ])
  const scope = { group_type: 'openai_apikey', allowed_vms: ['vm-a'] }
  assert.deepEqual(
    s.catalog(scope).data.map((model) => model.id),
    ['a'],
  )
  assert.equal(s.pick('a', Date.now(), scope).key.id, 'a')
  assert.equal(s.pick('b', Date.now(), scope).ok, false)
  assert.equal(s.pick('plain', Date.now(), scope).ok, false)
  assert.deepEqual(
    s.catalog().data.map((model) => model.id),
    ['plain'],
  )
  assert.equal(s.pick('a').ok, false)
  runtime.get('vm-a').proxyUrl = 'socks5h://new-proxy:1080'
  assert.equal(s.pick('a', Date.now(), scope).key.proxy_url, 'socks5h://new-proxy:1080')
  runtime.get('vm-a').accountId = 'different-account'
  assert.equal(s.pick('a', Date.now(), scope).ok, false)
  assert.deepEqual(s.catalog(scope).data, [])
})

test('API readiness is independent of OAuth lifecycle and requires a live bound proxy', () => {
  let source = {
    accountId: 'acct-a',
    enabled: true,
    proxyUrl: 'socks5h://proxy-a:1080',
    status: 'stopped',
    schedulable: false,
    platform_session: null,
    plan: 'free',
  }
  const s = new ApiScheduler({ resolveAccountKey: () => source })
  s.reload([
    ep({
      kind: 'openai',
      api_key_entries: [{ id: 'a', api_key: 'secret', source_vm_id: 'vm-a', source_account_id: 'acct-a' }],
    }),
  ])
  const scope = { group_type: 'openai_apikey', allowed_vms: ['vm-a'] }
  assert.equal(s.pick('sonnet', Date.now(), scope).ok, true)
  source = { ...source, enabled: false }
  assert.equal(s.pick('sonnet', Date.now(), scope).ok, false)
  source = { ...source, enabled: true, proxyUrl: '' }
  assert.equal(s.pick('sonnet', Date.now(), scope).ok, false)
  source = null
  assert.equal(s.pick('sonnet', Date.now(), scope).ok, false)
})

test('balance exhaustion is not bypassed by endpoint disable_cooling', () => {
  const s = new ApiScheduler({
    resolveAccountKey: () => ({ accountId: 'acct-a', enabled: true, proxyUrl: 'socks5h://proxy:1080' }),
  })
  s.reload([
    ep({
      kind: 'openai',
      disable_cooling: true,
      api_key_entries: [
        {
          id: 'a',
          api_key: 'secret',
          source_vm_id: 'vm-a',
          source_account_id: 'acct-a',
          cooldown_until: '9999-12-31T23:59:59.999Z',
        },
      ],
    }),
  ])
  const scope = { group_type: 'openai_apikey', allowed_vms: ['vm-a'] }
  assert.equal(s.pick('sonnet', Date.now(), scope).ok, false)
  assert.deepEqual(s.catalog(scope).data, [])
})
