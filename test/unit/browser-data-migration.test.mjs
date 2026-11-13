import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { OpenaiApiRepo } from '../../src/lib/db/repos/openai-api-repo.mjs'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { migrateBrowserData, SHARD_BROWSER_MIGRATION_SETTING } from '../../src/lib/browser/browser-data-migration.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shard-migration-'))
  const projectRoot = path.join(root, 'project')
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(projectRoot)
  fs.mkdirSync(dataDir)
  const settings = new Map()
  const beforeCleanup = []
  const settingsRepo = { get: (key) => settings.get(key), set: (key, value) => settings.set(key, value) }
  t.after(() => {
    for (const close of beforeCleanup) close()
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const put = (relative, value = 'keep') => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
    return file
  }
  return { root, projectRoot, dataDir, settingsRepo, put, beforeCleanup }
}

test('only known slot web profiles and the old runtime are removed, once', (t) => {
  const f = fixture(t)
  const oldProfile = f.put('project/vms/slot-a/browser-profile/Default/Cookies', 'old-web')
  const oldRuntime = f.put('data/browser-runtime/cloakbrowser/chrome', 'old-binary')
  const preserved = [
    f.put('project/vms/slot-a/codex-credentials.json', 'oauth-keep'),
    f.put('project/vms/slot-a.json', 'vm-keep'),
    f.put('project/vms/unregistered/browser-profile/Default/Cookies', 'unknown-keep'),
    f.put('data/browser-runtime/shardbrowser/chrome', 'new-binary-keep'),
    f.put('data/backups/old-profile/Default/Cookies', 'backup-keep'),
  ]
  const original = preserved.map((file) => fs.readFileSync(file))
  const input = { ...f, vmIds: ['slot-a', 'slot-empty', 'slot-a'] }
  migrateBrowserData(input)
  assert.equal(fs.existsSync(oldProfile), false)
  assert.equal(fs.existsSync(oldRuntime), false)
  assert.equal(f.settingsRepo.get(SHARD_BROWSER_MIGRATION_SETTING), true)
  preserved.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), original[index]))

  const shardProfile = f.put('project/vms/slot-a/browser-profile/Default/Cookies', 'new-shard-web')
  migrateBrowserData(input)
  assert.equal(fs.readFileSync(shardProfile, 'utf8'), 'new-shard-web')
})

test('invalid slot ids are rejected before any removal', (t) => {
  const f = fixture(t)
  const profile = f.put('project/vms/slot-a/browser-profile/Cookies')
  assert.throws(() => migrateBrowserData({ ...f, vmIds: ['slot-a', '../outside'] }), {
    code: 'browser_data_migration_failed',
    status: 503,
  })
  assert.equal(fs.existsSync(profile), true)
  assert.notEqual(f.settingsRepo.get(SHARD_BROWSER_MIGRATION_SETTING), true)
})

test('a failed removal stays pending and succeeds on the next explicit attempt', (t) => {
  const f = fixture(t)
  f.put('project/vms/slot-a/browser-profile/Cookies', 'old-web')
  const oldRuntime = f.put('data/browser-runtime/cloakbrowser/chrome', 'old-binary')
  const remove = fs.rmSync
  const failure = t.mock.method(fs, 'rmSync', (target, options) => {
    if (target === path.dirname(oldRuntime))
      throw Object.assign(new Error('private path must not leak'), { code: 'EACCES' })
    return remove(target, options)
  })
  assert.throws(
    () => migrateBrowserData({ ...f, vmIds: ['slot-a'] }),
    (error) => {
      assert.equal(error.code, 'browser_data_migration_failed')
      assert.equal(error.publicMessage, error.message)
      assert.equal(error.message.includes('private path'), false)
      return true
    },
  )
  assert.notEqual(f.settingsRepo.get(SHARD_BROWSER_MIGRATION_SETTING), true)
  assert.equal(fs.existsSync(oldRuntime), true)
  failure.mock.restore()
  migrateBrowserData({ ...f, vmIds: ['slot-a'] })
  assert.equal(f.settingsRepo.get(SHARD_BROWSER_MIGRATION_SETTING), true)
  assert.equal(fs.existsSync(oldRuntime), false)
})

test('a slot parent redirected outside the project is not traversed', (t) => {
  const f = fixture(t)
  const outside = f.put('outside/browser-profile/Cookies', 'unrelated-browser')
  fs.mkdirSync(path.join(f.projectRoot, 'vms'))
  const link = path.join(f.projectRoot, 'vms', 'slot-a')
  fs.symlinkSync(path.join(f.root, 'outside'), link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => migrateBrowserData({ ...f, vmIds: ['slot-a'] }), { code: 'browser_data_migration_failed' })
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unrelated-browser')
  assert.notEqual(f.settingsRepo.get(SHARD_BROWSER_MIGRATION_SETTING), true)
})

test('SQL migration clears only old web state and license, preserving credentials and business rows', (t) => {
  const f = fixture(t)
  const oldMigrations = path.join(f.root, 'pre057')
  const migrations = fileURLToPath(new URL('../../src/lib/db/migrations/', import.meta.url))
  fs.mkdirSync(oldMigrations)
  for (const name of fs.readdirSync(migrations)) {
    if (Number(name.split('_')[0]) <= 56) fs.copyFileSync(path.join(migrations, name), path.join(oldMigrations, name))
  }
  let db = createDatabase({ dataDir: f.dataDir, migrationsDir: oldMigrations })
  f.beforeCleanup.push(() => db.close())
  const store = new ApiEndpointStore({ db })
  const endpoint = store.create({ kind: 'openai', name: 'keep-endpoint' })
  const key = store.addKey(endpoint.id, {
    api_key: 'sk-fixture-keep',
    source_vm_id: 'slot-a',
    source_account_id: 'account-a',
  })
  const api = new OpenaiApiRepo(db)
  api.upsertAccount('account-a', {
    vm_id: 'slot-a',
    organization_id: 'org-a',
    key_id: key.id,
    enabled: true,
    claim_status: 'claimed',
    operation_id: 'keep-operation',
    setup_status: 'ready',
  })
  api.upsertOrg('org-a', { balance: '12.3456789', endpoint_id: endpoint.id, grants: [{ id: 'keep-grant' }] })
  db.prepare('UPDATE openai_api_accounts SET fingerprint_json = ?, storage_state_enc = ? WHERE account_id = ?').run(
    '{"legacy":true}',
    'old-account-web',
    'account-a',
  )
  db.prepare(`INSERT INTO slot_browser_profiles (vm_id, account_id, fingerprint_json, storage_state_enc, billing_session_enc, created_at, updated_at)
    VALUES ('slot-a', 'account-a', 'old-device', 'old-cookie', 'old-billing', 'created', 'updated')`).run()
  db.prepare(`INSERT INTO vms (id, vm_json, access_token, refresh_token, schedulable)
    VALUES ('slot-a', '{"id":"slot-a"}', 'keep-oauth-access', 'keep-oauth-refresh', 1)`).run()
  db.prepare(
    "INSERT INTO usage_logs (id, created_at, vm_id, status) VALUES ('keep-request', 'before', 'slot-a', 200)",
  ).run()
  const settings = new SettingsRepo(db)
  settings.set('account_browser_cloakbrowser_key', 'encrypted-fixture-key')
  settings.set('unrelated', { keep: true })
  const tables = ['vms', 'openai_api_accounts', 'openai_api_orgs', 'api_endpoints', 'api_endpoint_keys', 'usage_logs']
  const before = Object.fromEntries(tables.map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()]))
  const oauthFile = f.put('project/vms/slot-a/codex-credentials.json', '{"refresh_token":"keep-file-token"}')
  const oauth = fs.readFileSync(oauthFile)
  db.close()
  db = createDatabase({ dataDir: f.dataDir })
  const migratedSettings = new SettingsRepo(db)
  assert.equal(migratedSettings.has('account_browser_cloakbrowser_key'), false)
  assert.equal(migratedSettings.get(SHARD_BROWSER_MIGRATION_SETTING), false)
  assert.deepEqual(migratedSettings.get('unrelated'), { keep: true })
  const state = db.prepare('SELECT * FROM slot_browser_profiles').get()
  assert.deepEqual(
    { ...state },
    {
      vm_id: 'slot-a',
      account_id: 'account-a',
      fingerprint_json: null,
      storage_state_enc: null,
      billing_session_enc: null,
      created_at: 'created',
      updated_at: 'updated',
    },
  )
  for (const table of tables) {
    const actual = db.prepare(`SELECT * FROM ${table}`).all()
    const expected =
      table === 'openai_api_accounts'
        ? before[table].map((row) =>
            Object.assign(Object.create(null), row, { fingerprint_json: null, storage_state_enc: null }),
          )
        : before[table]
    assert.deepEqual(actual, expected, table)
  }
  assert.deepEqual(fs.readFileSync(oauthFile), oauth)
  migrateBrowserData({ ...f, settingsRepo: migratedSettings, vmIds: ['slot-a'] })
  db.prepare("UPDATE slot_browser_profiles SET storage_state_enc = 'new-shard-cookies'").run()
  const stamp = db.prepare("SELECT * FROM schema_migrations WHERE version = '057'").get()
  db.close()
  db = createDatabase({ dataDir: f.dataDir })
  assert.equal(
    db.prepare('SELECT storage_state_enc FROM slot_browser_profiles').get().storage_state_enc,
    'new-shard-cookies',
  )
  assert.equal(new SettingsRepo(db).get(SHARD_BROWSER_MIGRATION_SETTING), true)
  assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version = '057'").get(), stamp)
})
