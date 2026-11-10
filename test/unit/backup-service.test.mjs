import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { openDatabase, closeDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { BackupService, tarAvailable } from '../../src/lib/admin/backup-service.mjs'
import { sha256File } from '../../src/lib/admin/backup-core.mjs'
import { BackupRepo } from '../../src/lib/db/repos/backup-repo.mjs'
import { readAll } from '../../src/lib/db/sqlite-pool.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { stopVmWatch, initVmDbSync } from '../../src/lib/vm/vm-db-sync.mjs'
import { setVmWriteHook } from '../../src/lib/vm/vm-file.mjs'

let root, dataDir, configDir, svc

function seedVm(id = 'vm-b1') {
  const vmsDir = path.join(root, 'vms')
  fs.mkdirSync(vmsDir, { recursive: true })
  fs.writeFileSync(
    path.join(vmsDir, `${id}.json`),
    JSON.stringify(
      {
        id,
        name: 'b',
        status: 'running',
        claude: { access_token: 'sk-ant-oat01-BAK', refresh_token: 'sk-ant-ort01-BAK', account_uuid: 'acct-b' },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(vmsDir, 'active.json'), JSON.stringify({ active_vm: id }))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bak-'))
  dataDir = path.join(root, 'data')
  configDir = path.join(root, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'routing.json'), JSON.stringify({ sticky: { enabled: true } }))
  openDatabase({ dataDir })
  svc = new BackupService({ dataDir, projectRoot: root, configDir })
})

afterEach(() => {
  svc.stopScheduler()
  stopVmWatch()
  setVmWriteHook(null)
  closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.KIN_BACKUP_DISABLED
  delete process.env.KIN_BACKUP_INTERVAL_HOURS
  delete process.env.KIN_BACKUP_RETENTION
})

test('tar is available in this environment', () => {
  assert.equal(tarAvailable(), true)
})

test('createBackup produces tar.gz with manifest + db + vms + config, records ok', async () => {
  seedVm()
  initVmDbSync(root, { watch: false })
  new SettingsRepo(getDb()).set('marker', 'before-backup')

  const rec = await svc.createBackup({ kind: 'manual' })
  assert.equal(rec.status, 'ok')
  assert.equal(rec.kind, 'manual')
  assert.ok(rec.file_path.endsWith('.tar.gz'))
  assert.ok(fs.existsSync(rec.file_path))
  assert.ok(rec.size_bytes > 0)
  assert.match(rec.sha256, /^[0-9a-f]{64}$/)
  assert.equal(rec.includes.vms, 2) // vm-b1.json + active.json
  assert.equal(rec.includes.config, 1)

  // archive contents sane
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bak-x-'))
  spawnSync('tar', ['-xzf', rec.file_path, '-C', tmp])
  assert.ok(fs.existsSync(path.join(tmp, 'manifest.json')))
  assert.ok(fs.existsSync(path.join(tmp, 'db', 'kin.db')))
  assert.ok(fs.existsSync(path.join(tmp, 'vms', 'vm-b1.json')))
  assert.ok(fs.existsSync(path.join(tmp, 'config', 'routing.json')))
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, 1)
  assert.ok(manifest.sha256s['db/kin.db'])
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('createBackup does not block the main thread (gateway keeps ticking)', async () => {
  seedVm()
  initVmDbSync(root, { watch: false })
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
  }, 5)
  try {
    await svc.createBackup({ kind: 'manual' })
  } finally {
    clearInterval(timer)
  }
  // The backup pipeline is synchronous for minutes on a real database; it must
  // run off the main thread or timers (SSE keepalive, health probes) stop firing
  // and the gateway looks dead to the reverse proxy (Cloudflare 524).
  assert.ok(ticks > 0, `event loop should tick during backup, got ${ticks}`)
})

test('restoreBackup rolls data back and creates pre_restore record', async () => {
  seedVm()
  initVmDbSync(root, { watch: false })
  const keys = new ApiKeyStore({ db: getDb() })
  const kept = keys.create({ name: 'kept-key' })

  const rec = await svc.createBackup({ kind: 'manual' })

  // mutate after the backup
  const lost = keys.create({ name: 'lost-key' })
  new SettingsRepo(getDb()).set('marker', 'after-backup')
  // wire the rebind like the server does
  let reboundDb = null
  svc.onRestored((db) => {
    reboundDb = db
    keys.rebind(db)
  })

  const out = await svc.restoreBackup(rec.id)
  assert.equal(out.ok, true)
  assert.ok(reboundDb, 'rebind callback should fire')

  // state rolled back
  assert.ok(keys.getById(kept.id), 'pre-backup key survives')
  assert.equal(keys.getById(lost.id), null, 'post-backup key rolled back')
  assert.equal(new SettingsRepo(getDb()).get('marker'), null)

  // old db file kept on disk as safety net
  assert.ok(fs.existsSync(path.join(dataDir, 'kin.db.pre-restore')))
  // pre_restore archive file kept on disk for manual recovery
  const preFiles = fs.readdirSync(path.join(dataDir, 'backups'))
  assert.ok(preFiles.length >= 2, 'manual + pre_restore archives on disk')
  // ledger re-registered after restore: pre_restore (and restored manual) visible
  const ledger = svc.list()
  assert.ok(
    ledger.some((r) => r.id === out.pre_restore && r.kind === 'pre_restore'),
    'pre_restore record re-registered in restored DB',
  )
  assert.ok(
    ledger.some((r) => r.id === rec.id),
    'restored manual record present',
  )
  assert.ok(
    ledger.every((r) => r.file_exists),
    'all ledger rows point at real files',
  )
})

test('restore fails when stores cannot rebind to the reopened database', async () => {
  seedVm()
  const rec = await svc.createBackup({ kind: 'manual' })
  svc.onRestored(() => {
    throw new Error('store rebind failed')
  })

  await assert.rejects(svc.restoreBackup(rec.id), /store rebind failed/)
  assert.equal(svc.isRestoring, true, 'traffic must stay paused after a partially applied restore')
  await assert.rejects(svc.createBackup(), /restore already in progress/)
  assert.doesNotThrow(() => getDb().prepare('SELECT 1').get())
})

test('restore preserves legacy top-level VM archive files', async () => {
  seedVm('vm-b2')
  initVmDbSync(root, { watch: false })
  const rec = await svc.createBackup({ kind: 'manual' })

  // delete vm file + its row is still in backup db; also delete local file post-backup
  fs.rmSync(path.join(root, 'vms', 'vm-b2.json'))
  const out = await svc.restoreBackup(rec.id)
  assert.equal(out.ok, true)
  const back = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-b2.json'), 'utf8'))
  // tar snapshot still has the on-disk file from backup time; DB is metadata only.
  assert.equal(back.claude.access_token, 'sk-ant-oat01-BAK')
  const row = new VmsRepo(getDb()).get('vm-b2')
  assert.equal(row.access_token, null)
  assert.equal(row.vm.claude.has_access, true)
  assert.equal(row.vm.claude.access_token, undefined)
})

test('backup and restore include nested Codex credentials without guest caches', async () => {
  seedVm('vm-codex')
  const slotDir = path.join(root, 'vms', 'vm-codex')
  fs.mkdirSync(path.join(slotDir, 'cli-home'), { recursive: true })
  const credentialFile = path.join(slotDir, 'codex-credentials.json')
  const credential = JSON.stringify({ accounts: [{ access_token: 'test-access', refresh_token: 'test-refresh' }] })
  fs.writeFileSync(credentialFile, credential)
  fs.writeFileSync(path.join(slotDir, 'cli-home', 'cache.json'), 'keep-current-cache')
  const rec = await svc.createBackup()
  assert.equal(rec.includes.vms, 3)
  const stage = path.join(root, 'inspect')
  fs.mkdirSync(stage)
  assert.equal(spawnSync('tar', ['-xzf', rec.file_path, '-C', stage]).status, 0)
  const stagedFile = path.join(stage, 'vms', 'vm-codex', 'codex-credentials.json')
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'))
  assert.equal(fs.readFileSync(stagedFile, 'utf8'), credential)
  assert.equal(manifest.sha256s['vms/vm-codex/codex-credentials.json'], sha256File(stagedFile))
  assert.equal(fs.existsSync(path.join(stage, 'vms', 'vm-codex', 'cli-home')), false)
  fs.writeFileSync(credentialFile, '{"accounts":[]}')
  await svc.restoreBackup(rec.id)
  assert.equal(fs.readFileSync(credentialFile, 'utf8'), credential)
  assert.equal(fs.readFileSync(path.join(slotDir, 'cli-home', 'cache.json'), 'utf8'), 'keep-current-cache')
})

test('corrupt nested credentials fail validation before changing the live database', async () => {
  seedVm('vm-codex')
  const slotDir = path.join(root, 'vms', 'vm-codex')
  fs.mkdirSync(slotDir)
  fs.writeFileSync(path.join(slotDir, 'codex-credentials.json'), '{"accounts":[]}')
  const rec = await svc.createBackup()
  const stage = path.join(root, 'tampered')
  fs.mkdirSync(stage)
  assert.equal(spawnSync('tar', ['-xzf', rec.file_path, '-C', stage]).status, 0)
  fs.writeFileSync(path.join(stage, 'vms', 'vm-codex', 'codex-credentials.json'), 'damaged')
  assert.equal(spawnSync('tar', ['-czf', rec.file_path, '-C', stage, '.']).status, 0)
  getDb().prepare('UPDATE backup_records SET sha256 = ? WHERE id = ?').run(sha256File(rec.file_path), rec.id)
  new SettingsRepo(getDb()).set('marker', 'live-state')
  await assert.rejects(svc.restoreBackup(rec.id), /sha256 mismatch/)
  assert.equal(new SettingsRepo(getDb()).get('marker'), 'live-state')
  assert.equal(fs.existsSync(path.join(dataDir, 'kin.db.pre-restore')), false)
  assert.equal(svc.list().length, 1, 'invalid archive must not rotate safety backups')
})

test('restore rejects incompatible nested targets before replacing the live database', async () => {
  seedVm('vm-codex')
  const slotDir = path.join(root, 'vms', 'vm-codex')
  fs.mkdirSync(slotDir)
  const credentialFile = path.join(slotDir, 'codex-credentials.json')
  fs.writeFileSync(credentialFile, '{"accounts":[]}')
  const rec = await svc.createBackup()
  fs.unlinkSync(credentialFile)
  fs.mkdirSync(credentialFile)
  new SettingsRepo(getDb()).set('marker', 'live-state')
  await assert.rejects(svc.restoreBackup(rec.id), /incompatible type/)
  assert.equal(new SettingsRepo(getDb()).get('marker'), 'live-state')
  assert.equal(fs.existsSync(path.join(dataDir, 'kin.db.pre-restore')), false)
})

test('restoring oldest retained pre_restore survives safety-backup retention', async () => {
  seedVm()
  new SettingsRepo(getDb()).set('marker', 'oldest')
  const oldest = await svc.createBackup({ kind: 'pre_restore' })
  new SettingsRepo(getDb()).set('marker', 'later')
  await svc.createBackup({ kind: 'pre_restore' })
  await svc.createBackup({ kind: 'pre_restore' })
  const restored = await svc.restoreBackup(oldest.id)
  assert.equal(restored.ok, true)
  assert.equal(new SettingsRepo(getDb()).get('marker'), 'oldest')
})

test('legacy database-only gzip snapshots remain restorable as metadata', async () => {
  seedVm('vm-legacy')
  initVmDbSync(root, { watch: false })
  new SettingsRepo(getDb()).set('marker', 'legacy')
  const rec = await svc.createBackup()
  const stage = path.join(root, 'legacy')
  fs.mkdirSync(stage)
  assert.equal(spawnSync('tar', ['-xzf', rec.file_path, '-C', stage]).status, 0)
  const filePath = path.join(svc.backupDir, 'kin-backup-legacy.db.gz')
  fs.writeFileSync(filePath, zlib.gzipSync(fs.readFileSync(path.join(stage, 'db', 'kin.db'))))
  const legacy = new BackupRepo(getDb()).insert({
    ...rec,
    id: 'bak_legacy',
    file_path: filePath,
    file_name: path.basename(filePath),
    sha256: sha256File(filePath),
    size_bytes: fs.statSync(filePath).size,
  })
  new SettingsRepo(getDb()).set('marker', 'current')
  fs.unlinkSync(path.join(root, 'vms', 'vm-legacy.json'))
  await svc.restoreBackup(legacy.id)
  assert.equal(new SettingsRepo(getDb()).get('marker'), 'legacy')
  const restored = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-legacy.json'), 'utf8'))
  assert.equal(restored.id, 'vm-legacy')
  assert.equal(restored.claude.access_token, undefined)
})

test('missing tar fails visibly without pruning successful backups', async () => {
  seedVm()
  const rec = await svc.createBackup()
  const originalPath = process.env.PATH
  try {
    process.env.PATH = path.join(root, 'no-tools')
    await assert.rejects(svc.createBackup(), /tar is required/)
  } finally {
    process.env.PATH = originalPath
  }
  assert.equal(svc.list().filter((row) => row.status === 'failed').length, 1)
  assert.equal(fs.existsSync(rec.file_path), true)
  assert.equal(
    fs.readdirSync(svc.backupDir).some((name) => name.endsWith('.db.gz')),
    false,
  )
})

test('unreadable credential entry fails the backup instead of silently omitting it', async () => {
  seedVm('vm-codex')
  const rec = await svc.createBackup()
  fs.mkdirSync(path.join(root, 'vms', 'vm-codex', 'codex-credentials.json'), { recursive: true })
  await assert.rejects(svc.createBackup(), /requires a regular file/)
  assert.equal(svc.list().filter((row) => row.status === 'failed').length, 1)
  assert.equal(fs.existsSync(rec.file_path), true)
})

test('archive links are rejected before extraction or live changes', async () => {
  seedVm()
  const rec = await svc.createBackup()
  const stage = path.join(root, 'linked-archive')
  fs.mkdirSync(stage)
  assert.equal(spawnSync('tar', ['-xzf', rec.file_path, '-C', stage]).status, 0)
  // A hardlink is portable on the Windows fixture filesystem and must be
  // rejected just like a symlink, even with a matching outer archive hash.
  fs.linkSync(path.join(stage, 'db', 'kin.db'), path.join(stage, 'vms', 'linked.json'))
  assert.equal(spawnSync('tar', ['-czf', rec.file_path, '-C', stage, '.']).status, 0)
  getDb().prepare('UPDATE backup_records SET sha256 = ? WHERE id = ?').run(sha256File(rec.file_path), rec.id)
  new SettingsRepo(getDb()).set('marker', 'live-state')
  await assert.rejects(svc.restoreBackup(rec.id), /link or special file/)
  assert.equal(new SettingsRepo(getDb()).get('marker'), 'live-state')
  assert.equal(fs.existsSync(path.join(dataDir, 'kin.db.pre-restore')), false)
})

test('restore waits for pooled readers before removing the live WAL', async (t) => {
  openDatabase({ dataDir, pooled: true })
  await readAll('SELECT 1')
  new SettingsRepo(getDb()).set('marker', 'before')
  const rec = await svc.createBackup()
  new SettingsRepo(getDb()).set('marker', 'after')
  await readAll('SELECT 1')
  const originalTerminate = Worker.prototype.terminate
  let readersTerminated = 0
  const terminateMock = t.mock.method(Worker.prototype, 'terminate', function () {
    return new Promise((resolve) => setTimeout(resolve, 50)).then(async () => {
      const code = await originalTerminate.call(this)
      readersTerminated += 1
      return code
    })
  })
  const originalRemove = fs.rmSync
  const removeMock = t.mock.method(fs, 'rmSync', (file, options) => {
    if (file === path.join(dataDir, 'kin.db-wal'))
      assert.ok(readersTerminated > 0, 'readers must exit before WAL removal')
    return originalRemove(file, options)
  })
  try {
    await svc.restoreBackup(rec.id)
  } finally {
    terminateMock.mock.restore()
    removeMock.mock.restore()
  }
  assert.equal(new SettingsRepo(getDb()).get('marker'), 'before')
})

test('restore refuses to replace the database when a WAL sidecar cannot be removed', async (t) => {
  seedVm()
  const rec = await svc.createBackup()
  new SettingsRepo(getDb()).set('marker', 'live-state')
  const originalRemove = fs.rmSync
  const removeMock = t.mock.method(fs, 'rmSync', (file, options) => {
    if (file === path.join(dataDir, 'kin.db-wal')) throw new Error('test WAL is still held open')
    return originalRemove(file, options)
  })
  await assert.rejects(svc.restoreBackup(rec.id), /WAL is still held open/)
  assert.equal(svc.isRestoring, true)
  removeMock.mock.restore()
  openDatabase({ dataDir })
  assert.equal(new SettingsRepo(getDb()).get('marker'), 'live-state')
  assert.equal(fs.existsSync(path.join(dataDir, 'kin.db.pre-restore')), false)
})

test('sha256 tamper detection blocks restore', async () => {
  seedVm()
  const rec = await svc.createBackup({ kind: 'manual' })
  fs.appendFileSync(rec.file_path, 'tamper')
  await assert.rejects(svc.restoreBackup(rec.id), /sha256 mismatch/)
})

test('retention prunes old backups', async () => {
  process.env.KIN_BACKUP_RETENTION = '2'
  seedVm()
  const recs = []
  for (let i = 0; i < 4; i++) recs.push(await svc.createBackup({ kind: 'manual' }))
  const remaining = svc.list().filter((r) => r.kind === 'manual')
  assert.equal(remaining.length, 2)
  // newest two kept
  assert.ok(remaining.some((r) => r.id === recs[3].id))
  assert.ok(remaining.some((r) => r.id === recs[2].id))
  // pruned files removed from disk
  assert.equal(fs.existsSync(recs[0].file_path), false)
  assert.equal(fs.existsSync(recs[1].file_path), false)
})

test('schedule config defaults on, env override off, updateSchedule persists', () => {
  const cfg = svc.getSchedule()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.interval_hours, 24)
  assert.equal(cfg.retention, 7)

  svc.updateSchedule({ interval_hours: 6, retention: 3 })
  assert.equal(svc.getSchedule().interval_hours, 6)
  assert.equal(svc.getSchedule().retention, 3)
  assert.throws(() => svc.updateSchedule({ interval_hours: 0 }), /interval_hours/)

  process.env.KIN_BACKUP_DISABLED = '1'
  assert.equal(svc.getSchedule().enabled, false)
})

test('shouldRunScheduled: true when never run, false right after a backup', async () => {
  seedVm()
  assert.equal(svc.shouldRunScheduled(), true)
  await svc.createBackup({ kind: 'scheduled' })
  assert.equal(svc.shouldRunScheduled(), false)
  // pretend 25h elapsed
  assert.equal(svc.shouldRunScheduled(Date.now() + 25 * 3600_000), true)
})

test('remove deletes record + file', async () => {
  seedVm()
  const rec = await svc.createBackup({ kind: 'manual' })
  assert.equal(svc.remove(rec.id), true)
  assert.equal(fs.existsSync(rec.file_path), false)
  assert.equal(svc.get(rec.id), null)
})
