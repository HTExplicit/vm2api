import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-ep-'))
}

test('create endpoint with keys and models, list masks keys', () => {
  const store = new ApiEndpointStore({ dataDir: tmpDir() })
  const rec = store.create({
    name: 'openrouter',
    base_url: 'https://example.com',
    prefix: 'or',
    api_key_entries: [{ api_key: 'sk-or-secret-key-one' }],
    models: [{ name: 'moonshotai/kimi', alias: 'kimi' }],
  })
  assert.equal(rec.base_url, 'https://example.com')
  assert.equal(rec.api_key_entries.length, 1)
  assert.equal(rec.models[0].alias, 'kimi')
  const listed = store.list()
  assert.ok(listed[0].api_key_entries[0].api_key.includes('…'))
  assert.ok(!listed[0].api_key_entries[0].api_key.includes('secret-key'))
})

test('create strips trailing /v1 from base_url', () => {
  const store = new ApiEndpointStore({ dataDir: tmpDir() })
  const rec = store.create({
    name: 'a',
    base_url: 'https://example.com/v1/',
    api_key_entries: [{ api_key: 'sk-or-xxxx' }],
    models: [{ name: 'm', alias: 'm' }],
  })
  assert.equal(rec.base_url, 'https://example.com')
})

test('official kinds lock base_url', () => {
  const store = new ApiEndpointStore({ dataDir: tmpDir() })
  const claude = store.create({ kind: 'claude', api_key_entries: [{ api_key: 'sk-ant-xxxx' }] })
  assert.equal(claude.kind, 'claude')
  assert.equal(claude.base_url, 'https://api.anthropic.com')
  assert.equal(claude.protocol, 'anthropic')
  const openai = store.create({ kind: 'openai', name: 'oai', api_key_entries: [{ api_key: 'sk-oai-xxxx' }] })
  assert.equal(openai.kind, 'openai')
  assert.equal(openai.base_url, 'https://api.openai.com')
  assert.equal(openai.protocol, 'openai')
})

test('sk-kin category defaults oauth and can switch to api', () => {
  const keys = new ApiKeyStore({ dataDir: tmpDir() })
  const rec = keys.create({ name: 'c' })
  assert.equal(rec.category, 'oauth')
  const updated = keys.update(rec.id, { category: 'api' })
  assert.equal(updated.category, 'api')
  assert.equal(keys.list()[0].category, 'api')
})

test('account API keys keep source identity and encrypt through reload and edit', () => {
  const previousSecret = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = 'api-endpoint-unit-secret'
  let store
  try {
    store = new ApiEndpointStore({ dataDir: tmpDir() })
    const endpoint = store.create({
      kind: 'openai',
      api_key_entries: [
        {
          api_key: 'sk-project-account-secret-1234',
          source_vm_id: 'vm-account-a',
          source_account_id: 'account-a',
        },
      ],
    })
    const keyId = endpoint.api_key_entries[0].id
    const rawKey = () => store.db.prepare('SELECT api_key FROM api_endpoint_keys WHERE id = ?').get(keyId).api_key
    assert.match(rawKey(), /^enc:v1:/)
    assert.ok(!rawKey().includes('account-secret'))

    const reloaded = new ApiEndpointStore({ db: store.db })
    assert.equal(reloaded.getKey(keyId).api_key, 'sk-project-account-secret-1234')
    assert.equal(reloaded.getKey(keyId).source_vm_id, 'vm-account-a')
    assert.equal(reloaded.getKey(keyId).source_account_id, 'account-a')
    const visible = reloaded.list()[0].api_key_entries[0]
    assert.equal(visible.key_suffix, '1234')
    assert.equal(visible.source_vm_id, 'vm-account-a')
    assert.equal(visible.source_account_id, 'account-a')
    assert.ok(!visible.api_key.includes('account-secret'))

    reloaded.updateKey(keyId, { proxy_url: 'socks5h://127.0.0.1:1080', disabled: true })
    assert.match(rawKey(), /^enc:v1:/)
    assert.equal(reloaded.getKey(keyId).api_key, 'sk-project-account-secret-1234')
    assert.equal(reloaded.getKey(keyId).source_account_id, 'account-a')

    reloaded.updateKey(keyId, {
      api_key: 'sk-project-replacement-5678',
      source_vm_id: 'vm-account-b',
      source_account_id: 'account-b',
    })
    assert.match(rawKey(), /^enc:v1:/)
    assert.equal(reloaded.getRaw(endpoint.id).api_key_entries[0].api_key, 'sk-project-replacement-5678')
    assert.equal(reloaded.getKey(keyId).source_vm_id, 'vm-account-b')
    assert.equal(reloaded.getKey(keyId).source_account_id, 'account-b')
  } finally {
    store?.db.close()
    if (previousSecret === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = previousSecret
  }
})

test('legacy plaintext API keys remain readable when DB encryption is enabled', () => {
  const previousSecret = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = 'api-endpoint-unit-secret'
  let store
  try {
    store = new ApiEndpointStore({ dataDir: tmpDir() })
    const endpoint = store.create({ kind: 'openai', api_key_entries: [{ api_key: 'sk-old-key-1234' }] })
    const keyId = endpoint.api_key_entries[0].id
    store.db.prepare('UPDATE api_endpoint_keys SET api_key = ? WHERE id = ?').run('sk-legacy-plaintext-1234', keyId)

    const reloaded = new ApiEndpointStore({ db: store.db })
    assert.equal(reloaded.getKey(keyId).api_key, 'sk-legacy-plaintext-1234')
    assert.equal(reloaded.getKey(keyId).source_vm_id, '')
    assert.equal(reloaded.getKey(keyId).source_account_id, '')
    reloaded.updateKey(keyId, { disabled: true })
    assert.match(store.db.prepare('SELECT api_key FROM api_endpoint_keys WHERE id = ?').get(keyId).api_key, /^enc:v1:/)
    assert.equal(reloaded.getKey(keyId).api_key, 'sk-legacy-plaintext-1234')
  } finally {
    store?.db.close()
    if (previousSecret === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = previousSecret
  }
})
