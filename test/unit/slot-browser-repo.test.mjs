import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../../src/lib/db/database.mjs'
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

test('slot profiles retain independent fixed identities and encrypt shared web state', (t) => {
  const { db } = fixture(t)
  const repo = new SlotBrowserRepo(db)
  const fpA = { config: { identity: 'random-a', screen: { width: 1440 } } }
  const fpB = { config: { identity: 'random-b', screen: { width: 1920 } } }
  const storage = { cookies: [{ name: 'session', value: 'web-secret-a' }], origins: [] }
  const first = repo.upsert('slot-a', { fingerprint: fpA, storage_state: storage })
  repo.upsert('slot-b', { fingerprint: fpB, account_id: 'account-b' })
  repo.upsert('slot-a', { account_id: 'account-a' })
  const raw = db.prepare('SELECT storage_state_enc FROM slot_browser_profiles WHERE vm_id = ?').get('slot-a')
  assert.match(raw.storage_state_enc, /^enc:v1:/)
  assert.ok(!raw.storage_state_enc.includes('web-secret-a'))
  assert.deepEqual(repo.get('slot-a').fingerprint, fpA)
  assert.deepEqual(repo.get('slot-a').storage_state, storage)
  assert.equal(repo.get('slot-a').created_at, first.created_at)
  const restored = new SlotBrowserRepo(db)
  assert.deepEqual(restored.get('slot-a'), repo.get('slot-a'))
  assert.deepEqual(restored.get('slot-b').fingerprint, fpB)
  assert.equal(restored.list().length, 2)
  assert.equal(restored.remove('slot-a'), true)
  assert.equal(restored.remove('slot-a'), false)
  assert.equal(restored.get('slot-a'), null)
  assert.deepEqual(restored.get('slot-b').fingerprint, fpB)
})

test('migration moves legacy encrypted storage only to its verified registered slot', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-browser-migration-'))
  const oldMigrations = path.join(directory, 'pre049')
  fs.mkdirSync(oldMigrations)
  for (const name of fs.readdirSync(migrations)) {
    if (Number(name.split('_')[0]) <= 48) fs.copyFileSync(path.join(migrations, name), path.join(oldMigrations, name))
  }
  const previous = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = 'test-slot-browser-migration-secret'
  let db = createDatabase({ dataDir: directory, migrationsDir: oldMigrations })
  t.after(() => {
    db.close()
    if (previous === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = previous
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const vms = new VmsRepo(db)
  vms.upsertFromVmJson({ id: 'slot-owned', family: 'codex', codex: { chatgpt_account_id: 'account-owned' } })
  vms.upsertFromVmJson({ id: 'slot-wrong', family: 'codex', codex: { chatgpt_account_id: 'account-current' } })
  vms.upsertFromVmJson({ id: 'slot-same-account', family: 'codex', codex: { chatgpt_account_id: 'account-owned' } })
  const fingerprint = JSON.stringify({ config: { identity: 'preserved-random' } })
  const encryptedStorage = maybeEncrypt(JSON.stringify({ cookies: [{ value: 'legacy-secret' }] }))
  const insert = db.prepare(`INSERT INTO openai_api_accounts
    (account_id, vm_id, claim_status, operation_id, fingerprint_json, storage_state_enc, created_at, updated_at)
    VALUES (?, ?, 'claimed', 'original-operation', ?, ?, 'created', 'updated')`)
  insert.run('account-owned', 'slot-owned', fingerprint, encryptedStorage)
  insert.run('account-old', 'slot-wrong', fingerprint, encryptedStorage)
  insert.run('account-orphan', 'slot-deleted', fingerprint, encryptedStorage)
  db.close()
  db = createDatabase({ dataDir: directory })
  const repo = new SlotBrowserRepo(db)
  assert.equal(repo.list().length, 1)
  assert.equal(repo.get('slot-owned').account_id, 'account-owned')
  assert.deepEqual(repo.get('slot-owned').fingerprint, JSON.parse(fingerprint))
  assert.deepEqual(repo.get('slot-owned').storage_state, { cookies: [{ value: 'legacy-secret' }] })
  assert.equal(repo.get('slot-same-account'), null)
  assert.equal(repo.get('slot-wrong'), null)
  assert.equal(repo.get('slot-deleted'), null)
  const legacy = db.prepare('SELECT * FROM openai_api_accounts WHERE account_id = ?').get('account-owned')
  assert.equal(legacy.fingerprint_json, null)
  assert.equal(legacy.storage_state_enc, null)
  assert.equal(legacy.claim_status, 'claimed')
  assert.equal(legacy.operation_id, 'original-operation')
  assert.equal(
    db.prepare('SELECT storage_state_enc FROM openai_api_accounts WHERE account_id = ?').get('account-old')
      .storage_state_enc,
    encryptedStorage,
  )
  assert.equal(
    db.prepare('SELECT storage_state_enc FROM openai_api_accounts WHERE account_id = ?').get('account-orphan')
      .storage_state_enc,
    encryptedStorage,
  )
  assert.equal(repo.migrateLegacyProfiles(), 0)
})

test('legacy migration never replaces a slot identity already generated for that account', (t) => {
  const { db } = fixture(t)
  new VmsRepo(db).upsertFromVmJson({ id: 'slot-a', codex: { chatgpt_account_id: 'account-a' } })
  const profiles = new SlotBrowserRepo(db)
  profiles.upsert('slot-a', { account_id: 'account-a', fingerprint: { generated: 'slot-identity' } })
  const api = new OpenaiApiRepo(db)
  api.upsertAccount('account-a', { vm_id: 'slot-a', fingerprint: { generated: 'legacy-identity' } })
  assert.equal(profiles.migrateLegacyProfiles(), 1)
  assert.deepEqual(profiles.get('slot-a').fingerprint, { generated: 'slot-identity' })
  assert.equal(api.getAccount('account-a').fingerprint, null)
})

test('legacy migration uses the current access-token account identity when the slot mirror differs', (t) => {
  const { directory, db } = fixture(t)
  new VmsRepo(db).upsertFromVmJson({ id: 'slot-a', codex: { chatgpt_account_id: 'user-legacy-id' } })
  const jwt = (payload) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
  fs.mkdirSync(path.join(directory, 'vms', 'slot-a'), { recursive: true })
  writeCodexAccounts(directory, 'slot-a', [
    {
      email: 'same-account@example.test',
      chatgpt_account_id: 'user-legacy-id',
      access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-current' } }),
    },
  ])
  const api = new OpenaiApiRepo(db)
  api.upsertAccount('account-current', {
    vm_id: 'slot-a',
    fingerprint: { generated: 'preserve-existing-browser-identity' },
    storage_state: { cookies: [{ value: 'preserved-platform-session' }] },
  })
  const profiles = new SlotBrowserRepo(db, { projectRoot: directory })
  assert.equal(profiles.get('slot-a').account_id, 'account-current')
  assert.deepEqual(profiles.get('slot-a').fingerprint, { generated: 'preserve-existing-browser-identity' })
  assert.deepEqual(profiles.get('slot-a').storage_state, { cookies: [{ value: 'preserved-platform-session' }] })
  assert.equal(api.getAccount('account-current').fingerprint, null)
})

test('legacy migration preserves a browser identity when the current slot mirror has no account field', (t) => {
  const { directory, db } = fixture(t)
  new VmsRepo(db).upsertFromVmJson({ id: 'slot-a', family: 'codex' })
  fs.mkdirSync(path.join(directory, 'vms', 'slot-a'), { recursive: true })
  const access = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-current' } })).toString('base64url')}.signature`
  writeCodexAccounts(directory, 'slot-a', [{ email: 'existing@example.test', access_token: access }])
  const api = new OpenaiApiRepo(db)
  api.upsertAccount('account-current', { vm_id: 'slot-a', fingerprint: { generated: 'legacy-existing' } })
  const profiles = new SlotBrowserRepo(db, { projectRoot: directory })
  assert.deepEqual(profiles.get('slot-a').fingerprint, { generated: 'legacy-existing' })
  assert.equal(profiles.get('slot-a').account_id, 'account-current')
  assert.equal(api.getAccount('account-current').fingerprint, null)
})

test('targeted cleanup may open the profile repository without migrating unrelated legacy identities', (t) => {
  const { db } = fixture(t)
  new VmsRepo(db).upsertFromVmJson({ id: 'slot-a', codex: { chatgpt_account_id: 'account-a' } })
  const api = new OpenaiApiRepo(db)
  api.upsertAccount('account-a', { vm_id: 'slot-a', fingerprint: { generated: 'legacy-identity' } })
  const profiles = new SlotBrowserRepo(db, { migrateLegacy: false })
  assert.equal(profiles.get('slot-a'), null)
  profiles.rebind(db)
  assert.equal(profiles.get('slot-a'), null)
  assert.deepEqual(api.getAccount('account-a').fingerprint, { generated: 'legacy-identity' })
  profiles.rebind(db, { migrateLegacy: true })
  assert.deepEqual(profiles.get('slot-a').fingerprint, { generated: 'legacy-identity' })
  assert.equal(api.getAccount('account-a').fingerprint, null)
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
    fingerprint: { old: true },
    storage_state: { cookies: [{ value: 'old-session' }] },
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
  assert.equal(account.fingerprint, null)
  assert.equal(account.storage_state, null)
  assert.equal(account.claim_status, 'claimed')
  assert.equal(account.operation_id, 'never-repeat-operation')
  assert.equal(repo.getAccount('account-b').key_id, other.id)
  assert.equal(repo.getOrg('org-shared').balance, '37.00')
  assert.equal(repo.getOrg('org-shared').endpoint_id, shared.id)
  assert.equal(repo.getOrg('org-alone').balance, '1.00')
  assert.equal(repo.getOrg('org-alone').endpoint_id, '')
  assert.deepEqual(repo.cleanupForVm('slot-a'), { accounts: 0, keys: 0, endpoints: 0 })
})
