import test from 'node:test'
import assert from 'node:assert/strict'
import { accountApiModels } from '../../src/lib/openai-api/model-catalog.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'

test('account catalog shares enabled models, plain aliases and routing mappings without generated Fast', () => {
  const policy = {
    models: {
      'gpt-a': {
        enabled: true,
        aliases: ['friendly', 'gpt-off'],
        expose_fast: true,
        catalog: { service_tiers: [{ id: 'priority' }] },
      },
      'gpt-b': { enabled: true, aliases: ['other'] },
      'gpt-off': { enabled: false },
      'gpt-real-fast': { enabled: true },
      'gpt-image-2': { enabled: true },
    },
  }
  const models = accountApiModels(policy, {
    codex: {
      model_mappings: {
        friendly: 'gpt-b',
        fast: 'gpt-a-fast',
        disabled: 'gpt-off',
        'gpt-a': 'gpt-b',
        'gpt-off': 'gpt-b',
        literal: 'gpt-real-fast',
      },
    },
  })
  const map = new Map(models.map((row) => [row.alias, row.name]))
  assert.equal(map.get('gpt-a'), 'gpt-a')
  assert.equal(map.get('friendly'), 'gpt-b')
  assert.equal(map.get('other'), 'gpt-b')
  assert.equal(map.get('literal'), 'gpt-real-fast')
  assert.equal(map.has('gpt-off'), false)
  assert.equal(map.has('disabled'), false)
  assert.equal(map.has('fast'), false)
  assert.equal(map.has('gpt-a-fast'), false)
  assert.equal(map.has('gpt-image-2'), false)
})

test('an explicit unavailable mapping does not fall back to a plain alias', () => {
  const models = accountApiModels(
    {
      models: {
        'gpt-a': { aliases: ['friendly'] },
        'gpt-off': { enabled: false },
      },
    },
    { codex: { model_mappings: { friendly: 'gpt-off' } } },
  )
  assert.equal(
    models.some((row) => row.alias === 'friendly'),
    false,
  )
})

test('account catalog and picker read policy changes live and preserve raw endpoint models', () => {
  const policy = { models: { 'gpt-a': { enabled: true, aliases: ['friendly'] } } }
  const scheduler = new ApiScheduler({
    getAccountModels: () => accountApiModels(policy),
    resolveAccountKey: (key) => ({ accountId: key.source_account_id, enabled: true, proxyUrl: 'socks5h://proxy:1080' }),
  })
  const raw = {
    id: 'ep-a',
    kind: 'openai',
    models: [{ name: 'old-model', alias: 'old-model' }],
    api_key_entries: [{ id: 'key-a', api_key: 'secret-a', source_account_id: 'acct-a', source_vm_id: 'vm-a' }],
  }
  scheduler.reload([raw])
  const scope = { group_type: 'openai_apikey', allowed_vms: ['vm-a'] }
  assert.equal(scheduler.pick('friendly', Date.now(), scope).upstream_model, 'gpt-a')
  assert.deepEqual(
    scheduler.catalog(scope).data.map((row) => row.id),
    ['gpt-a', 'friendly'],
  )
  assert.equal(scheduler.pick('old-model', Date.now(), scope).ok, false)
  assert.equal(raw.models[0].name, 'old-model')
  policy.models['gpt-a'].enabled = false
  assert.deepEqual(scheduler.catalog(scope).data, [])
  assert.equal(scheduler.pick('friendly', Date.now(), scope).ok, false)
})

test('bounded attempts can exclude an account without widening the selected slots', () => {
  const scheduler = new ApiScheduler({
    getAccountModels: () => [{ name: 'gpt-a', alias: 'gpt-a' }],
    resolveAccountKey: (key) => ({ accountId: key.source_account_id, enabled: true, proxyUrl: 'socks5h://proxy:1080' }),
  })
  scheduler.reload(
    ['a', 'b', 'c'].map((id) => ({
      id: `ep-${id}`,
      kind: 'openai',
      models: [],
      api_key_entries: [
        {
          id: `key-${id}`,
          source_account_id: `acct-${id}`,
          source_vm_id: `vm-${id}`,
        },
      ],
    })),
  )
  const scope = { group_type: 'openai_apikey', allowed_vms: ['vm-a', 'vm-b'] }
  assert.equal(scheduler.pick('gpt-a', Date.now(), scope, { excludedAccountIds: new Set(['acct-a']) }).key.id, 'key-b')
  assert.equal(scheduler.pick('gpt-a', Date.now(), scope, { excludedKeyIds: new Set(['key-a', 'key-b']) }).ok, false)
})
