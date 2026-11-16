import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { preflightVmRename, renameVmId, retargetVmId } from '../../src/lib/vm/vm-rename.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { SlotBrowserRepo } from '../../src/lib/db/repos/slot-browser-repo.mjs'
import { encryptString } from '../../src/lib/db/secure.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

function seed(root, id, extra = {}) {
  const dir = path.join(root, 'vms', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'marker.txt'), id)
  const vm = { id, name: '槽', status: 'stopped', ...extra }
  fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm))
  return vm
}

test('renameVmId moves the record and slot directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-'))
  try {
    seed(root, 'slot-a')
    fs.writeFileSync(path.join(root, 'vms', 'active.json'), JSON.stringify({ active_vm: 'slot-a' }))
    const renamed = renameVmId(root, 'slot-a', 'slot-b')
    assert.equal(renamed.ok, true)
    assert.equal(renamed.id, 'slot-b')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-a.json')), false)
    assert.equal(fs.readFileSync(path.join(root, 'vms', 'slot-b', 'marker.txt'), 'utf8'), 'slot-a')
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'slot-b.json'), 'utf8'))
    assert.equal(saved.id, 'slot-b')
    assert.equal(saved.name, '槽')
    const active = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'active.json'), 'utf8'))
    assert.equal(active.active_vm, 'slot-b')
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

test('renameVmId refuses a running, remote, or taken slot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-'))
  try {
    seed(root, 'slot-a', { status: 'running' })
    assert.equal(renameVmId(root, 'slot-a', 'slot-c').code, 'vm_running')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-a.json')), true)

    const stopped = {
      ...JSON.parse(fs.readFileSync(path.join(root, 'vms', 'slot-a.json'), 'utf8')),
      status: 'stopped',
    }
    fs.writeFileSync(path.join(root, 'vms', 'slot-a.json'), JSON.stringify(stopped))
    seed(root, 'slot-b')
    assert.equal(renameVmId(root, 'slot-a', 'slot-b').code, 'vm_id_taken')

    fs.writeFileSync(path.join(root, 'vms', 'slot-a.json'), JSON.stringify({ ...stopped, node_id: 'node-1' }))
    assert.equal(renameVmId(root, 'slot-a', 'slot-d').code, 'remote_vm')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-a.json')), true)
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

test('renameVmId refuses an invalid id without writing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-'))
  try {
    seed(root, 'slot-a')
    assert.equal(renameVmId(root, 'slot-a', '../slot').code, 'invalid_id')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-a.json')), true)
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

function bindingFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-rename-bindings-'))
  const db = createDatabase({ dataDir: path.join(root, 'data') })
  const proxyPool = new ProxyPool({ db })
  t.after(() => {
    proxyPool.stopScheduler()
    db.close()
    fs.rmSync(root, { recursive: true })
  })
  proxyPool.importLines('socks5://user:password@192.0.2.10:1080\nhttp://other:secret@192.0.2.20:8080')
  const [single, shared] = proxyPool.state.proxies
  seed(root, 'slot-a', {
    proxy_id: single.id,
    oauth: { access_token: 'slot-token', refresh_token: 'slot-refresh' },
    schedule_enabled: false,
  })
  seed(root, 'slot-shared', { proxy_id: shared.id })
  assert.equal(proxyPool.bind(single.id, 'slot-a').ok, true)
  assert.equal(proxyPool.bind(shared.id, 'slot-shared').ok, true)
  assert.equal(proxyPool.bind(shared.id, 'slot-other').ok, true)
  // Persisted credentials move as opaque encrypted bytes, without re-authentication.
  const cookieBytes = encryptString(
    JSON.stringify({ cookies: [{ name: 'session', value: 'cookie-secret' }] }),
    'fixture-key',
  )
  const billingBytes = encryptString(JSON.stringify({ token: 'billing-secret' }), 'fixture-key')
  db.prepare(`INSERT INTO slot_browser_profiles
    (vm_id, account_id, storage_state_enc, billing_session_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run('slot-a', 'account-a', cookieBytes, billingBytes, 'created', 'updated')
  return { root, db, proxyPool, single, shared, cookieBytes, billingBytes }
}

test('rename keeps encrypted browser state and single/shared proxy bindings through a later pool save', (t) => {
  const { root, db, proxyPool, single, shared, cookieBytes, billingBytes } = bindingFixture(t)
  db.prepare('INSERT INTO accounts (id, vm_id, credentials, proxy_id) VALUES (?, ?, ?, ?)').run(
    'account-a',
    'slot-a',
    '{"refresh_token":"account-refresh"}',
    single.id,
  )
  db.prepare('INSERT INTO account_runtime (account_id, vm_id, updated_at) VALUES (?, ?, ?)').run(
    'account-a',
    'slot-a',
    'updated',
  )
  db.prepare('INSERT INTO sticky_sessions (key, account_id, vm_id) VALUES (?, ?, ?)').run(
    'sticky-key',
    'account-a',
    'slot-a',
  )
  db.prepare('INSERT INTO api_keys (id, key, allowed_vms) VALUES (?, ?, ?)').run(
    'api-key',
    'key-secret',
    '["slot-a","slot-other"]',
  )
  db.prepare('INSERT INTO vm_pools (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    'pool-a',
    'pool-a',
    'created',
    'updated',
  )
  db.prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES (?, ?, ?)').run(
    'pool-a',
    'slot-a',
    'created',
  )
  db.prepare('INSERT INTO usage_logs (id, vm_id, created_at) VALUES (?, ?, ?)').run('history-a', 'slot-a', 'created')
  const before = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'slot-a.json'), 'utf8'))
  const workingSet = proxyPool.state.proxies
  shared.latency_ms = 17 // Keep a pending probe observation and its existing object.
  const result = renameVmId(root, 'slot-a', 'slot-b', { proxyPool, discardContainer: () => ({ ok: true }) })
  assert.equal(result.ok, true)
  const renamedShared = renameVmId(root, 'slot-shared', 'slot-shared-new', { proxyPool })
  assert.equal(renamedShared.ok, true)
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'slot-b.json'), 'utf8'))
  assert.deepEqual(saved.oauth, before.oauth)
  assert.equal(saved.proxy_id, before.proxy_id)
  assert.equal(saved.schedule_enabled, false)
  const profile = db.prepare('SELECT * FROM slot_browser_profiles WHERE vm_id = ?').get('slot-b')
  assert.equal(profile.storage_state_enc, cookieBytes)
  assert.equal(profile.billing_session_enc, billingBytes)
  assert.equal(profile.account_id, 'account-a')
  assert.equal(profile.created_at, 'created')
  assert.equal(profile.updated_at, 'updated')
  assert.equal(new SlotBrowserRepo(db).get('slot-a'), null)
  assert.equal(db.prepare('SELECT vm_id FROM accounts WHERE id = ?').get('account-a').vm_id, 'slot-b')
  assert.equal(
    db.prepare('SELECT credentials FROM accounts WHERE id = ?').get('account-a').credentials,
    '{"refresh_token":"account-refresh"}',
  )
  assert.equal(db.prepare('SELECT vm_id FROM account_runtime').get().vm_id, 'slot-b')
  assert.equal(db.prepare('SELECT vm_id FROM sticky_sessions').get().vm_id, 'slot-b')
  assert.equal(db.prepare('SELECT vm_id FROM vm_pool_members').get().vm_id, 'slot-b')
  assert.deepEqual(JSON.parse(db.prepare('SELECT allowed_vms FROM api_keys').get().allowed_vms), [
    'slot-b',
    'slot-other',
  ])
  assert.equal(db.prepare('SELECT vm_id FROM usage_logs').get().vm_id, 'slot-a')
  assert.equal(proxyPool.state.proxies, workingSet)
  assert.deepEqual(single.bound_vm_ids, ['slot-b'])
  assert.deepEqual(shared.bound_vm_ids, ['slot-shared-new', 'slot-other'])
  assert.equal(shared.latency_ms, 17)
  assert.equal(db.prepare('SELECT bound_vm_id FROM proxies WHERE id = ?').get(single.id).bound_vm_id, 'slot-b')
  assert.deepEqual(JSON.parse(db.prepare('SELECT bound_vm_id FROM proxies WHERE id = ?').get(shared.id).bound_vm_id), [
    'slot-shared-new',
    'slot-other',
  ])
  proxyPool.save()
  const reopened = new ProxyPool({ db })
  assert.deepEqual(reopened.state.proxies.find((p) => p.id === single.id).bound_vm_ids, ['slot-b'])
  assert.deepEqual(reopened.state.proxies.find((p) => p.id === shared.id).bound_vm_ids, [
    'slot-shared-new',
    'slot-other',
  ])
  assert.equal(reopened.state.proxies.find((p) => p.id === single.id).password, 'password')
})

test('preflight refuses occupied browser state before container or file changes', (t) => {
  const { root, db, proxyPool } = bindingFixture(t)
  db.prepare('INSERT INTO slot_browser_profiles (vm_id, created_at, updated_at) VALUES (?, ?, ?)').run(
    'slot-b',
    'created',
    'updated',
  )
  const before = fs.readFileSync(path.join(root, 'vms', 'slot-a.json'), 'utf8')
  let discarded = 0
  assert.equal(preflightVmRename(root, 'slot-a', 'slot-b', { proxyPool }).code, 'vm_id_taken')
  assert.equal(
    renameVmId(root, 'slot-a', 'slot-b', {
      proxyPool,
      discardContainer: () => {
        discarded++
        return { ok: true }
      },
    }).code,
    'vm_id_taken',
  )
  assert.equal(discarded, 0)
  assert.equal(fs.readFileSync(path.join(root, 'vms', 'slot-a.json'), 'utf8'), before)
  assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-b')), false)
  assert.equal(
    db.prepare('SELECT vm_id FROM slot_browser_profiles WHERE account_id = ?').get('account-a').vm_id,
    'slot-a',
  )
})

test('container inspection failure leaves slot files, credentials and proxy bindings untouched', (t) => {
  const { root, db, proxyPool, single, cookieBytes } = bindingFixture(t)
  fs.writeFileSync(path.join(root, 'vms', 'active.json'), JSON.stringify({ active_vm: 'slot-a' }))
  assert.equal(preflightVmRename(root, 'slot-a', 'slot-b', { proxyPool }).ok, true)
  const result = renameVmId(root, 'slot-a', 'slot-b', {
    proxyPool,
    discardContainer: () => ({ ok: false, code: 'docker_inspect_failed', error: 'daemon unavailable' }),
  })
  assert.equal(result.code, 'docker_inspect_failed')
  assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-a', 'marker.txt')), true)
  assert.equal(fs.existsSync(path.join(root, 'vms', 'slot-b.json')), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'active.json'), 'utf8')).active_vm, 'slot-a')
  assert.equal(
    db.prepare('SELECT storage_state_enc FROM slot_browser_profiles WHERE vm_id = ?').get('slot-a').storage_state_enc,
    cookieBytes,
  )
  assert.deepEqual(single.bound_vm_ids, ['slot-a'])
  assert.equal(db.prepare('SELECT bound_vm_id FROM proxies WHERE id = ?').get(single.id).bound_vm_id, 'slot-a')
})

test('a reference transaction failure rolls back persisted bindings before changing the in-memory pool', (t) => {
  const { db, proxyPool, single } = bindingFixture(t)
  db.exec(`CREATE TRIGGER reject_rename BEFORE UPDATE OF bound_vm_id ON proxies
    BEGIN SELECT RAISE(ABORT, 'fixture rejects retarget'); END`)
  assert.throws(() => retargetVmId('slot-a', 'slot-b', { proxyPool }), /fixture rejects retarget/)
  assert.equal(db.prepare('SELECT vm_id FROM slot_browser_profiles').get().vm_id, 'slot-a')
  assert.equal(db.prepare('SELECT bound_vm_id FROM proxies WHERE id = ?').get(single.id).bound_vm_id, 'slot-a')
  assert.deepEqual(single.bound_vm_ids, ['slot-a'])
})
