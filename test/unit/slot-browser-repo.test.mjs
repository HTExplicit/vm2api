import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase, vacuumInto } from '../../src/lib/db/database.mjs'
import { SlotBrowserRepo } from '../../src/lib/db/repos/slot-browser-repo.mjs'
import { OpenaiApiRepo } from '../../src/lib/db/repos/openai-api-repo.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { maybeEncrypt } from '../../src/lib/db/secure.mjs'
import { writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'

const migrations = fileURLToPath(new URL('../../src/lib/db/migrations/', import.meta.url))

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-browser-repo-'))
  const previous = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = 'test-slot-browser-database-secret'
  const db = createDatabase({ dataDir: directory })
  t.after(() => {
    db.close()
    if (previous === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = previous
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { directory, db }
}

test('slot web state is isolated, encrypted and rebinds to a reopened database', (t) => {
  const { directory, db } = fixture(t)
  const repo = new SlotBrowserRepo(db)
  const storage = { cookies: [{ name: 'session', value: 'web-secret-a' }], origins: [] }
  const first = repo.upsert('slot-a', { storage_state: storage })
  repo.upsert('slot-b', { account_id: 'account-b', storage_state: { cookies: [] } })
  repo.upsert('slot-a', { account_id: 'account-a' })
  const raw = db.prepare('SELECT storage_state_enc FROM slot_browser_profiles WHERE vm_id = ?').get('slot-a')
  assert.match(raw.storage_state_enc, /^enc:v1:/)
  assert.ok(!raw.storage_state_enc.includes('web-secret-a'))
  assert.equal(Object.hasOwn(repo.get('slot-a'), 'fingerprint'), false)
  assert.deepEqual(repo.get('slot-a').storage_state, storage)
  assert.equal(repo.get('slot-a').created_at, first.created_at)

  const reopened = createDatabase({ dataDir: directory })
  try {
    assert.equal(repo.rebind(reopened), repo)
    assert.deepEqual(repo.get('slot-a').storage_state, storage)
    assert.deepEqual(repo.get('slot-b').storage_state, { cookies: [] })
    assert.equal(repo.list().length, 2)
    assert.equal(repo.remove('slot-a'), true)
    assert.equal(repo.remove('slot-a'), false)
    assert.equal(repo.get('slot-a'), null)
    assert.equal(repo.get('slot-b').account_id, 'account-b')
  } finally {
    reopened.close()
  }
})

test('Billing session is encrypted and survives database restart and the existing snapshot path', (t) => {
  const { directory, db } = fixture(t)
  const repo = new SlotBrowserRepo(db)
  const billing = {
    organization_id: 'org-a',
    headers: { authorization: 'Bearer billing-secret', 'user-agent': 'fixed-slot-ua' },
    captured_at: '2026-11-01T00:00:00Z',
    recovery_attempted: false,
  }
  repo.upsert('slot-a', { account_id: 'account-a', billing_session: billing })
  const raw = db.prepare('SELECT billing_session_enc FROM slot_browser_profiles WHERE vm_id = ?').get('slot-a')
  assert.match(raw.billing_session_enc, /^enc:v1:/)
  assert.equal(raw.billing_session_enc.includes('billing-secret'), false)
  assert.deepEqual(repo.get('slot-a').billing_session, billing)

  const reopened = createDatabase({ dataDir: directory })
  try {
    assert.deepEqual(new SlotBrowserRepo(reopened).get('slot-a').billing_session, billing)
  } finally {
    reopened.close()
  }
  const snapshot = path.join(directory, 'snapshot', 'kin.db')
  vacuumInto(db, snapshot)
  const restored = createDatabase({ dbPath: snapshot })
  try {
    assert.deepEqual(new SlotBrowserRepo(restored).get('slot-a').billing_session, billing)
  } finally {
    restored.close()
  }
  assert.equal(repo.remove('slot-a'), true)
  assert.equal(repo.get('slot-a'), null)
})

test('first account binding retains web and Billing sessions while replacing an account clears both', (t) => {
  const { db } = fixture(t)
  const repo = new SlotBrowserRepo(db)
  const storage = { cookies: [{ name: 'session', value: 'web-secret' }], origins: [] }
  const billing = { organization_id: 'org-a', headers: { authorization: 'Bearer billing-secret' } }
  repo.upsert('slot-a', { storage_state: storage, billing_session: billing })
  repo.upsert('slot-a', { account_id: 'account-a' })
  assert.deepEqual(repo.get('slot-a').storage_state, storage)
  assert.deepEqual(repo.get('slot-a').billing_session, billing)
  repo.upsert('slot-a', { account_id: 'account-a', billing_session: undefined })
  assert.deepEqual(repo.get('slot-a').billing_session, billing)
  repo.upsert('slot-a', { account_id: 'account-b' })
  assert.equal(repo.get('slot-a').storage_state, null)
  assert.equal(repo.get('slot-a').billing_session, null)
  assert.equal(repo.get('slot-a').account_id, 'account-b')
  repo.upsert('slot-a', { billing_session: billing })
  repo.upsert('slot-a', { billing_session: null })
  assert.equal(repo.get('slot-a').billing_session, null)
})

test('CloakBrowser migration clears Firefox web state once and preserves credentials and business records', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cloakbrowser-migration-'))
  const oldMigrations = path.join(directory, 'pre056')
  fs.mkdirSync(oldMigrations)
  for (const name of fs.readdirSync(migrations)) {
    if (Number(name.split('_')[0]) <= 55) fs.copyFileSync(path.join(migrations, name), path.join(oldMigrations, name))
  }
  const previous = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = 'test-cloakbrowser-migration-secret'
  let db = createDatabase({ dataDir: directory, migrationsDir: oldMigrations })
  t.after(() => {
    db.close()
    if (previous === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = previous
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const credentials = [{ email: 'account@example.test', access_token: 'access-keep', refresh_token: 'refresh-keep' }]
  fs.mkdirSync(path.join(directory, 'vms', 'slot-a'), { recursive: true })
  writeCodexAccounts(directory, 'slot-a', credentials)
  const credentialFile = path.join(directory, 'vms', 'slot-a', 'codex-credentials.json')
  const credentialBytes = fs.readFileSync(credentialFile)
  new VmsRepo(db).upsertFromVmJson({
    id: 'slot-a',
    family: 'codex',
    codex: { chatgpt_account_id: 'account-a' },
    schedulable: true,
    policy: { maxConcurrency: 3 },
  })
  const api = new OpenaiApiRepo(db)
  const store = new ApiEndpointStore({ db })
  const endpoint = store.create({ kind: 'openai', name: 'keep-endpoint' })
  const key = store.addKey(endpoint.id, {
    api_key: 'sk-platform-keep',
    source_vm_id: 'slot-a',
    source_account_id: 'account-a',
  })
  api.upsertOrg('org-a', {
    balance: '12.3456789',
    paid_balance: '10.0000001',
    endpoint_id: endpoint.id,
    grants: [{ id: 'grant-keep', remaining: '2.3456788' }],
  })
  api.upsertAccount('account-a', {
    vm_id: 'slot-a',
    organization_id: 'org-a',
    key_id: key.id,
    enabled: true,
    claim_status: 'claimed',
    operation_id: 'never-repeat-claim',
    setup_status: 'ready',
    offer: { receipt: 'keep' },
    benefit: { amount: '12.3456789' },
  })
  api.upsertAccount('account-orphan', {
    vm_id: 'slot-deleted',
  })
  for (const id of ['account-a', 'account-orphan']) {
    db.prepare('UPDATE openai_api_accounts SET fingerprint_json = ?, storage_state_enc = ? WHERE account_id = ?').run(
      JSON.stringify({ firefox: 'legacy-account' }),
      maybeEncrypt(JSON.stringify({ cookies: [{ value: 'legacy-account-secret' }] })),
      id,
    )
  }
  const storage = maybeEncrypt(JSON.stringify({ cookies: [{ value: 'legacy-slot-secret' }] }))
  const billing = maybeEncrypt(JSON.stringify({ headers: { authorization: 'Bearer legacy-billing' } }))
  db.prepare(`INSERT INTO slot_browser_profiles
    (vm_id, account_id, fingerprint_json, storage_state_enc, billing_session_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'created', 'updated')`).run(
    'slot-a',
    'account-a',
    JSON.stringify({ firefox: 'legacy-slot' }),
    storage,
    billing,
  )
  const beforeVm = db.prepare('SELECT * FROM vms WHERE id = ?').get('slot-a')
  const beforeAccount = db.prepare('SELECT * FROM openai_api_accounts WHERE account_id = ?').get('account-a')
  const beforeOrg = db.prepare('SELECT * FROM openai_api_orgs WHERE organization_id = ?').get('org-a')
  const beforeKey = db.prepare('SELECT * FROM api_endpoint_keys WHERE id = ?').get(key.id)
  const beforeEndpoint = db.prepare('SELECT * FROM api_endpoints WHERE id = ?').get(endpoint.id)
  db.close()

  db = createDatabase({ dataDir: directory })
  const repo = new SlotBrowserRepo(db)
  const migrated = repo.get('slot-a')
  assert.equal(migrated.account_id, 'account-a')
  assert.equal(migrated.storage_state, null)
  assert.equal(migrated.billing_session, null)
  assert.equal(migrated.created_at, 'created')
  assert.equal(migrated.updated_at, 'updated')
  assert.equal(
    db.prepare('SELECT fingerprint_json FROM slot_browser_profiles WHERE vm_id = ?').get('slot-a').fingerprint_json,
    null,
  )
  assert.deepEqual(db.prepare('SELECT * FROM vms WHERE id = ?').get('slot-a'), beforeVm)
  assert.deepEqual(
    { ...db.prepare('SELECT * FROM openai_api_accounts WHERE account_id = ?').get('account-a') },
    {
      ...beforeAccount,
      fingerprint_json: null,
      storage_state_enc: null,
    },
  )
  assert.deepEqual(db.prepare('SELECT * FROM openai_api_orgs WHERE organization_id = ?').get('org-a'), beforeOrg)
  assert.deepEqual(db.prepare('SELECT * FROM api_endpoint_keys WHERE id = ?').get(key.id), beforeKey)
  assert.deepEqual(db.prepare('SELECT * FROM api_endpoints WHERE id = ?').get(endpoint.id), beforeEndpoint)
  assert.deepEqual(fs.readFileSync(credentialFile), credentialBytes)
  assert.equal(new OpenaiApiRepo(db).getKey(key.id).api_key, 'sk-platform-keep')
  const orphan = new OpenaiApiRepo(db).getAccount('account-orphan')
  assert.equal(Object.hasOwn(orphan, 'fingerprint'), false)
  assert.equal(Object.hasOwn(orphan, 'storage_state'), false)
  assert.equal(repo.get('slot-deleted'), null, 'legacy account storage must not recreate a slot profile')
  const migration = db.prepare('SELECT * FROM schema_migrations WHERE version = ?').get('056')
  assert.ok(migration)

  const currentStorage = { cookies: [{ name: 'session', value: 'new-chromium-session' }], origins: [] }
  const currentBilling = { organization_id: 'org-a', headers: { authorization: 'Bearer new-billing' } }
  repo.upsert('slot-a', { storage_state: currentStorage, billing_session: currentBilling })
  db.close()
  db = createDatabase({ dataDir: directory })
  repo.rebind(db)
  assert.deepEqual(repo.get('slot-a').storage_state, currentStorage)
  assert.deepEqual(repo.get('slot-a').billing_session, currentBilling)
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version = ?').get('056'), migration)
  assert.deepEqual(fs.readFileSync(credentialFile), credentialBytes)
})

test('organization money and grant observations round-trip without losing decimal precision', (t) => {
  const { db } = fixture(t)
  const repo = new OpenaiApiRepo(db)
  const grants = [{ id: 'grant-a', remaining: '0.123456789012345678901', expires_at: '2099-01-01T00:00:00Z' }]
  repo.upsertOrg('org-a', {
    balance: '-0.000000000000000000001',
    paid_balance: '123456789012345678901.234500',
    grants,
    next_expiring_amount: '0.123456789012345678901',
    next_expiring_at: '2099-01-01T00:00:00Z',
    balance_checked_at: '2026-11-01T00:00:00Z',
  })
  repo.upsertAccount('account-a', { offer_checked_at: 'offer-time', link_checked_at: 'link-time' })
  const org = repo.getOrg('org-a')
  assert.equal(org.balance, '-0.000000000000000000001')
  assert.equal(org.paid_balance, '123456789012345678901.234500')
  assert.equal(org.next_expiring_amount, '0.123456789012345678901')
  assert.deepEqual(org.grants, grants)
  assert.deepEqual(repo.listOrgs()[0], org)
  assert.equal(repo.getAccount('account-a').offer_checked_at, 'offer-time')
  assert.equal(repo.getAccount('account-a').link_checked_at, 'link-time')
})

test('slot API cleanup removes owned secrets while preserving other keys, shared org and claim receipt', (t) => {
  const { db } = fixture(t)
  const repo = new OpenaiApiRepo(db)
  const store = new ApiEndpointStore({ db })
  const shared = store.create({ kind: 'openai', name: 'shared' })
  const dedicated = store.create({
    kind: 'openai',
    name: 'dedicated',
    models: [{ name: 'gpt-test', alias: 'gpt-test' }],
  })
  const owned = store.addKey(shared.id, { api_key: 'sk-owned', source_vm_id: 'slot-a', source_account_id: 'account-a' })
  const other = store.addKey(shared.id, { api_key: 'sk-other', source_vm_id: 'slot-b', source_account_id: 'account-b' })
  const alone = store.addKey(dedicated.id, {
    api_key: 'sk-alone',
    source_vm_id: 'slot-a',
    source_account_id: 'account-a',
  })
  const ordinary = store.create({ kind: 'openai', name: 'ordinary' })
  const ordinaryKey = store.addKey(ordinary.id, { api_key: 'sk-normal' })
  repo.upsertOrg('org-shared', { balance: '37.00', endpoint_id: shared.id })
  repo.upsertOrg('org-alone', { balance: '1.00', endpoint_id: dedicated.id })
  repo.upsertAccount('account-a', {
    vm_id: 'slot-a',
    organization_id: 'org-shared',
    key_id: owned.id,
    enabled: true,
    claim_status: 'claimed',
    operation_id: 'never-repeat-operation',
  })
  repo.upsertAccount('account-b', { vm_id: 'slot-b', organization_id: 'org-shared', key_id: other.id, enabled: true })
  assert.deepEqual(repo.cleanupForVm('slot-a'), { accounts: 1, keys: 2, endpoints: 1 })
  assert.equal(repo.getKey(owned.id), null)
  assert.equal(repo.getKey(alone.id), null)
  assert.ok(repo.getKey(other.id))
  assert.ok(repo.getKey(ordinaryKey.id))
  assert.equal(store.getRaw(dedicated.id), null)
  assert.ok(store.getRaw(shared.id))
  const account = repo.getAccount('account-a')
  assert.equal(account.vm_id, '')
  assert.equal(account.key_id, '')
  assert.equal(account.enabled, false)
  assert.equal(Object.hasOwn(account, 'fingerprint'), false)
  assert.equal(Object.hasOwn(account, 'storage_state'), false)
  assert.equal(account.claim_status, 'claimed')
  assert.equal(account.operation_id, 'never-repeat-operation')
  assert.equal(repo.getAccount('account-b').key_id, other.id)
  assert.equal(repo.getOrg('org-shared').balance, '37.00')
  assert.equal(repo.getOrg('org-shared').endpoint_id, shared.id)
  assert.equal(repo.getOrg('org-alone').balance, '1.00')
  assert.equal(repo.getOrg('org-alone').endpoint_id, '')
  assert.deepEqual(repo.cleanupForVm('slot-a'), { accounts: 0, keys: 0, endpoints: 0 })
})
