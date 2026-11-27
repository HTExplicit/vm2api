/**
 * Local backup service for the database, VM files, and configuration.
 *
 * Backup artifact: data/backups/kin-backup-<stamp>.tar.gz (0600) containing
 *   manifest.json   {version, created_at, kind, includes, sha256s}
 *   db/kin.db       VACUUM INTO online-consistent snapshot (slot metadata)
 *   vms/            slot *.json + active.json + nested Codex credentials
 *   config/         routing.json / intercept-rules.json …
 *
 * Creating backups requires tar. Older db.gz snapshots remain readable but
 * contain metadata only; they cannot reconstruct missing OAuth credentials.
 * Keep the original DB secret separately, and preserve complete slot homes
 * for native Claude credentials, guest identity and runtime state.
 *
 * Staging lives on the data volume (`<dataDir>/tmp`, override with
 * KIN_BACKUP_TMPDIR), not os.tmpdir(): /tmp is a tmpfs sized to a fraction of
 * RAM and a multi-GB `VACUUM INTO` snapshot fails there with SQLITE_FULL
 * ("database or disk is full") while the real disk still has room.
 *
 * Scheduling (default ON, user requirement):
 *   settings.backup_schedule = { enabled: true, interval_hours: 24, retention: 7 }
 *   env overrides: KIN_BACKUP_DISABLED=1, KIN_BACKUP_INTERVAL_HOURS, KIN_BACKUP_RETENTION
 *   - checker runs every 10 min + a catch-up check shortly after boot
 *   - the job itself runs in a worker thread (backup-worker.mjs): the
 *     pipeline is synchronous for minutes, so running it in-process
 *     would stop the gateway from answering (Cloudflare 524)
 *   - retention prunes old ok backups (pre_restore keeps newest 3)
 *
 * Restore:
 *   verify manifest/sha256 → automatic pre_restore backup → close DB →
 *   swap kin.db (old one kept as kin.db.pre-restore) → restore vms/ +
 *   config/ files (or rebuild from DB) → reopen + migrate → rebind stores.
 *   `isRestoring` flag lets the server 503 protocol traffic meanwhile.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { getDb, getDbEngine, getDbPath, getPgConfig, getPgPool, closeDatabase, openDatabase } from '../db/database.mjs'
import { buildPgConnectionString } from '../db/pg/config.mjs'
import { stopSqlitePool } from '../db/sqlite-pool.mjs'
import { pgRestoreAvailable, sha256File, SLOT_BACKUP_FILES } from './backup-core.mjs'
import { getCacheRuntime } from '../cache/index.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { BackupRepo } from '../db/repos/backup-repo.mjs'
import { reconcileVms } from '../vm/vm-db-sync.mjs'
import { migrateScheduleFields, repairSlotSmbios, repairVmProxyCliEnabled } from '../vm/vm-registry.mjs'
import { atomicWriteJson, invalidateReadCache, isVmRecordFile } from '../vm/vm-file.mjs'
import { sameSiwcOwner, SIWC_CREDENTIAL_FILE } from '../vm/codex-siwc-store.mjs'

// tarAvailability / sha256File / the runnable pipeline live in backup-core.mjs;
// keep the historical export surface for tests and callers.
export { tarAvailable } from './backup-core.mjs'

const SCHEDULE_KEY = 'backup_schedule'
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8')

function corruptBackup(message) {
  return Object.assign(new Error(message), { code: 'backup_corrupt' })
}

function allowedArchiveFile(name) {
  if (['manifest.json', 'db/kin.db', 'db/kin.pgdump', 'db/kin.pg.ndjson.gz'].includes(name)) return true
  if (/^(vms|config)\/[^/\\:]+\.json$/.test(name)) return true
  const parts = name.split('/')
  return (
    parts.length === 3 &&
    parts[0] === 'vms' &&
    /^[A-Za-z0-9_-]+$/.test(parts[1]) &&
    SLOT_BACKUP_FILES.includes(parts[2])
  )
}

// Check names and entry types before extraction. Only the regular files and
// directories produced by this backup writer belong in a restore archive.
function validateArchiveEntries(file) {
  const names = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' })
  const types = spawnSync('tar', ['-tvzf', file], { encoding: 'utf8' })
  if (names.status !== 0 || types.status !== 0) throw corruptBackup('cannot list backup archive')
  for (const line of types.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!['-', 'd'].includes(line[0])) throw corruptBackup('backup contains a link or special file')
  }
  for (const raw of names.stdout.split(/\r?\n/).filter(Boolean)) {
    const name = raw.replace(/^\.\//, '').replace(/\/$/, '')
    if (!name || name === '.') continue
    if (name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw corruptBackup('backup contains an unsafe path')
    }
    if (raw.endsWith('/') && (['db', 'vms', 'config'].includes(name) || /^vms\/[A-Za-z0-9_-]+$/.test(name))) continue
    if (!allowedArchiveFile(name)) throw corruptBackup('backup contains an unsupported path')
  }
}

function archiveFiles(dir, rel = '') {
  const files = []
  for (const name of fs.readdirSync(path.join(dir, rel))) {
    const key = rel ? `${rel}/${name}` : name
    const st = fs.lstatSync(path.join(dir, key))
    if (st.isDirectory()) files.push(...archiveFiles(dir, key))
    else if (st.isFile() && allowedArchiveFile(key)) files.push(key)
    else throw corruptBackup('backup contains an unsupported file')
  }
  return files
}

// Reject linked or incompatible destination paths before replacing the DB.
function validateRestoreTarget(base, rel) {
  let current = base
  const parts = rel.split('/')
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i])
    const st = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!st) continue
    if (st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile())) {
      throw corruptBackup('restore destination is linked or has an incompatible type')
    }
  }
}

export const DEFAULT_SCHEDULE = {
  enabled: true,
  interval_hours: 24,
  retention: 7,
}

/** SIGTERM the tar processes this process spawned (Linux /proc; no-op elsewhere). Returns how many. */
export function killChildArchivers({ pid = process.pid, proc = '/proc' } = {}) {
  let entries = []
  try {
    entries = fs.readdirSync(proc)
  } catch {
    return 0
  }
  let n = 0
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue
    try {
      const stat = fs.readFileSync(path.join(proc, e, 'stat'), 'utf8')
      const close = stat.lastIndexOf(')')
      const comm = stat.slice(stat.indexOf('(') + 1, close)
      const ppid = Number(stat.slice(close + 2).split(' ')[1])
      if (ppid !== pid || !['tar', 'pg_dump', 'pg_restore'].includes(comm)) continue
      process.kill(Number(e), 'SIGTERM')
      n++
    } catch {}
  }
  return n
}

export class BackupService {
  constructor({
    dataDir,
    projectRoot,
    configDir,
    backupDir,
    tmpDir,
    checkIntervalMs = 10 * 60_000,
    getEngine = null,
    isPgRestoreAvailable = null,
  } = {}) {
    this.dataDir = dataDir
    this.projectRoot = projectRoot
    this.configDir = configDir || null
    this.backupDir = backupDir || path.join(dataDir, 'backups')
    this.tmpDir = tmpDir || path.join(dataDir, 'tmp')
    this.checkIntervalMs = checkIntervalMs
    this._getDbEngine = typeof getEngine === 'function' ? getEngine : getDbEngine
    this._pgRestoreAvailable = typeof isPgRestoreAvailable === 'function' ? isPgRestoreAvailable : pgRestoreAvailable
    this.isRestoring = false
    this._running = false
    this._timer = null
    this._bootTimer = null
    this._rebindStores = null // set via onRestored()
  }

  _repo() {
    return new BackupRepo(getDb())
  }
  _settings() {
    return new SettingsRepo(getDb())
  }

  /** Staging dir on the data volume — the DB snapshot can be several GB. */
  _mkdtemp(prefix) {
    const base = process.env.KIN_BACKUP_TMPDIR || this.tmpDir
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(base, 0o700)
    } catch {}
    return fs.mkdtempSync(path.join(base, prefix))
  }

  /** Register the callback that re-binds stores to the new DB after restore. */
  onRestored(fn) {
    this._rebindStores = typeof fn === 'function' ? fn : null
  }

  // ---------- schedule config ----------

  getSchedule() {
    let cfg = { ...DEFAULT_SCHEDULE, ...(this._settings().get(SCHEDULE_KEY, {}) || {}) }
    if (process.env.KIN_BACKUP_DISABLED === '1') cfg.enabled = false
    if (process.env.KIN_BACKUP_INTERVAL_HOURS) {
      const n = Number(process.env.KIN_BACKUP_INTERVAL_HOURS)
      if (Number.isFinite(n) && n > 0) cfg.interval_hours = n
    }
    if (process.env.KIN_BACKUP_RETENTION) {
      const n = Number(process.env.KIN_BACKUP_RETENTION)
      if (Number.isFinite(n) && n > 0) cfg.retention = n
    }
    return cfg
  }

  updateSchedule(patch = {}) {
    const cur = { ...DEFAULT_SCHEDULE, ...(this._settings().get(SCHEDULE_KEY, {}) || {}) }
    if (patch.enabled != null) cur.enabled = !!patch.enabled
    if (patch.interval_hours != null) {
      const n = Number(patch.interval_hours)
      if (!Number.isFinite(n) || n < 1 || n > 24 * 30) {
        throw Object.assign(new Error('interval_hours must be 1..720'), { code: 'invalid_interval' })
      }
      cur.interval_hours = n
    }
    if (patch.retention != null) {
      const n = Math.floor(Number(patch.retention))
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        throw Object.assign(new Error('retention must be 1..100'), { code: 'invalid_retention' })
      }
      cur.retention = n
    }
    this._settings().set(SCHEDULE_KEY, cur)
    return this.getSchedule()
  }

  nextAutoAt() {
    const cfg = this.getSchedule()
    if (!cfg.enabled) return null
    const last = this._repo().lastSuccessful({})
    const base = last ? Date.parse(last.created_at) : 0
    return new Date(Math.max(Date.now(), base + cfg.interval_hours * 3600_000)).toISOString()
  }

  // ---------- create ----------

  /**
   * Run one backup off the main thread.
   *
   * The pipeline (VACUUM INTO + sha256 + tar.gz) is synchronous for minutes on a
   * multi-GB database, so it runs in a worker with its own DB connection while
   * the gateway keeps serving requests.
   *
   * @returns {Promise<backup record>}
   */
  async createBackup({ kind = 'manual', note = null } = {}) {
    if (this.isRestoring && kind !== 'pre_restore') {
      throw Object.assign(new Error('restore already in progress'), { code: 'restore_in_progress' })
    }
    if (this._running) throw Object.assign(new Error('backup already in progress'), { code: 'backup_in_progress' })
    this._running = true
    const id = 'bak_' + crypto.randomBytes(6).toString('hex')
    const createdAt = new Date().toISOString()
    try {
      return await this._runBackupWorker({
        id,
        createdAt,
        kind,
        note,
        retention: this.getSchedule().retention,
      })
    } catch (e) {
      // The worker records its own failure; this covers the cases where it never
      // got that far (module error, OOM, kill) so the panel still shows the job.
      try {
        if (!this._repo().get(id)) {
          this._repo().insert({
            id,
            created_at: createdAt,
            kind,
            status: 'failed',
            file_path: null,
            file_name: null,
            size_bytes: null,
            sha256: null,
            db_bytes: null,
            includes: null,
            error: String(e.message || e).slice(0, 500),
            note,
          })
        }
      } catch {}
      throw e
    } finally {
      this._running = false
    }
  }

  /** True while a backup worker thread is alive; it can outlive abortRunning() while VACUUM INTO runs. */
  get busy() {
    return !!this._worker
  }

  /**
   * Stop a backup in progress (blue/green handover, shutdown): the worker holds a minutes-long VACUUM +
   * tar and keeps a draining controller alive. Its staging dir is removed by the next cleanStaging().
   */
  async abortRunning() {
    const worker = this._worker
    if (!worker) return false
    // terminate() cannot interrupt the worker's synchronous spawnSync('tar'): stop the archiver first.
    killChildArchivers()
    await worker.terminate().catch(() => {})
    return true
  }

  /**
   * Remove staging dirs left by backups that never finished (process killed mid-run). Each is a full
   * DB snapshot (tens of GB). Only the leader backs up, so at leader start none of them is live.
   * The dirs are picked synchronously (a backup started right after is never among them) and removed
   * off the main thread: unlinking a tens-of-GB file on ext4 blocks for seconds.
   */
  async cleanStaging() {
    const stale = []
    for (const base of new Set([process.env.KIN_BACKUP_TMPDIR, this.tmpDir].filter(Boolean))) {
      let names = []
      try {
        names = fs.readdirSync(base)
      } catch {
        continue
      }
      for (const name of names) {
        if (!/^kin-backup-[A-Za-z0-9]{6}$/.test(name)) continue
        const dir = path.join(base, name)
        try {
          if (fs.lstatSync(dir).isDirectory()) stale.push(dir)
        } catch {}
      }
    }
    const removed = []
    for (const dir of stale) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true })
        removed.push(dir)
      } catch {}
    }
    if (removed.length) console.log(`[backup] removed ${removed.length} unfinished staging dir(s)`)
    return removed
  }

  _runBackupWorker(job) {
    return new Promise((resolve, reject) => {
      const engine = this._getDbEngine()
      const worker = new Worker(new URL('./backup-worker.mjs', import.meta.url), {
        workerData: {
          engine,
          pgConnectionString: engine === 'postgres' ? buildPgConnectionString(getPgConfig()) : null,
          dataDir: this.dataDir,
          ctx: {
            projectRoot: this.projectRoot,
            configDir: this.configDir,
            backupDir: this.backupDir,
            tmpDir: this.tmpDir,
          },
          job,
        },
      })
      this._worker = worker
      let settled = false
      let result = null
      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        fn(arg)
      }
      worker.once('message', (msg) => {
        if (msg && msg.ok) {
          result = msg.rec
          return
        }
        finish(
          reject,
          Object.assign(new Error((msg && msg.error && msg.error.message) || 'backup failed'), {
            code: (msg && msg.error && msg.error.code) || 'backup_failed',
          }),
        )
      })
      worker.once('error', (e) => finish(reject, e))
      worker.once('exit', (code) => {
        if (this._worker === worker) this._worker = null
        if (code !== 0)
          finish(reject, Object.assign(new Error(`backup worker exited with code ${code}`), { code: 'backup_aborted' }))
        else if (result) finish(resolve, result)
        else finish(reject, new Error('backup worker exited without a result'))
      })
    })
  }

  // ---------- list / delete ----------

  list({ limit = 100 } = {}) {
    return this._repo()
      .list({ limit })
      .map((r) => ({
        ...r,
        file_exists: !!(r.file_path && fs.existsSync(r.file_path)),
      }))
  }

  get(id) {
    return this._repo().get(id)
  }

  remove(id) {
    const rec = this._repo().get(id)
    if (!rec) return false
    try {
      if (rec.file_path && fs.existsSync(rec.file_path)) fs.rmSync(rec.file_path, { force: true })
    } catch {}
    return this._repo().remove(id)
  }

  // ---------- restore ----------

  /**
   * Preflight a backup archive before creating a `pre_restore` snapshot:
   * validate engine compatibility, extract/decompress into a staging dir when
   * needed, verify inner snapshot checksums against manifest.json, and check
   * `pg_restore` availability for `.pgdump` snapshots.
   */
  async _prepareRestoreArchive(rec, isPg) {
    const fileName = rec.file_name || path.basename(rec.file_path)

    if (isPg) {
      if (fileName.endsWith('.pgdump')) {
        if (!(await this._pgRestoreAvailable())) {
          throw Object.assign(new Error('pg_restore binary is required to restore custom PostgreSQL dumps'), {
            code: 'pg_restore_missing',
          })
        }
        return { tmp: null, dbFile: rec.file_path }
      }
      if (fileName.endsWith('.pg.ndjson.gz')) {
        return { tmp: null, dbFile: rec.file_path }
      }
      throw Object.assign(new Error(`unsupported backup format for PostgreSQL: ${fileName}`), {
        code: 'backup_incompatible',
      })
    }

    if (fileName.endsWith('.db.gz')) {
      const tmp = this._mkdtemp('kin-restore-')
      try {
        const dbFile = path.join(tmp, 'kin.db')
        const raw = zlib.gunzipSync(fs.readFileSync(rec.file_path))
        if (raw.length < SQLITE_HEADER.length || !raw.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
          throw Object.assign(new Error('decompressed backup is not a valid SQLite database'), {
            code: 'backup_corrupt',
          })
        }
        fs.writeFileSync(dbFile, raw)
        return { tmp, dbFile }
      } catch (err) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true })
        } catch {}
        if (err?.code) throw err
        throw Object.assign(new Error(`failed to decompress SQLite backup: ${String(err.message || err)}`), {
          code: 'backup_corrupt',
        })
      }
    }

    throw Object.assign(new Error(`unsupported backup format for SQLite: ${fileName}`), {
      code: 'backup_incompatible',
    })
  }

  /**
   * Restore from a recorded backup. Preflights format, checksums, engine
   * compatibility, and `pg_restore` availability before creating the
   * automatic `pre_restore` safety-net snapshot. Re-binds stores via onRestored.
   */
  async restoreBackup(id) {
    const rec = this._repo().get(id)
    if (!rec) throw Object.assign(new Error('backup not found'), { code: 'backup_not_found' })
    if (rec.status !== 'ok')
      throw Object.assign(new Error('backup record is not restorable'), { code: 'backup_not_ok' })
    if (!rec.file_path || !fs.existsSync(rec.file_path)) {
      throw Object.assign(new Error('backup file missing on disk'), { code: 'backup_file_missing' })
    }
    if (this.isRestoring) throw Object.assign(new Error('restore already in progress'), { code: 'restore_in_progress' })

    // integrity: archive checksum must match the record
    const actual = sha256File(rec.file_path)
    if (rec.sha256 && actual !== rec.sha256) {
      throw Object.assign(new Error('backup archive sha256 mismatch'), { code: 'backup_corrupt' })
    }

    this.isRestoring = true
    let tmp = null
    let databaseClosed = false
    let completed = false
    try {
      // Stage and validate before taking the safety snapshot: its retention
      // policy may remove the selected archive if it is an older pre_restore.
      const isPg = this._getDbEngine() === 'postgres'
      const targetEngine = isPg ? 'postgres' : 'sqlite'
      if (rec.includes?.engine && rec.includes.engine !== targetEngine) {
        throw Object.assign(new Error('backup database engine differs from the live database'), { code: 'backup_incompatible' })
      }
      let dbFile
      let manifest = null
      let files = []
      const siwcRecords = new Map()
      if ((rec.file_name || path.basename(rec.file_path)).endsWith('.tar.gz')) {
        validateArchiveEntries(rec.file_path)
        tmp = this._mkdtemp('kin-restore-')
        const r = spawnSync('tar', ['-xzf', rec.file_path, '-C', tmp], { stdio: 'pipe' })
        if (r.status !== 0) throw new Error(`tar extract failed: ${String(r.stderr || '').slice(0, 300)}`)
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
        } catch {
          throw corruptBackup('backup manifest is missing or invalid')
        }
        if (manifest?.version !== 1 && manifest?.version !== 2) throw corruptBackup('invalid backup manifest')
        if (manifest?.version !== (isPg ? 2 : 1)) {
          throw Object.assign(new Error('backup database engine differs from the live database'), {
            code: 'backup_incompatible',
          })
        }
        const snapshotPath = isPg
          ? manifest.format === 'pg_dump_custom'
            ? 'db/kin.pgdump'
            : 'db/kin.pg.ndjson.gz'
          : 'db/kin.db'
        if (!manifest.sha256s?.[snapshotPath]) throw corruptBackup('invalid backup manifest')
        dbFile = path.join(tmp, snapshotPath)
        files = archiveFiles(tmp)
        for (const key of new Set([
          ...files.filter((name) => name !== 'manifest.json'),
          ...Object.keys(manifest.sha256s),
        ])) {
          if (
            !allowedArchiveFile(key) ||
            !files.includes(key) ||
            sha256File(path.join(tmp, key)) !== manifest.sha256s[key]
          ) {
            throw corruptBackup('file sha256 mismatch inside backup archive')
          }
          if (key.startsWith('vms/') && this.projectRoot) {
            validateRestoreTarget(this.projectRoot, key)
            if (path.posix.basename(key) === SIWC_CREDENTIAL_FILE) {
              try {
                const record = JSON.parse(fs.readFileSync(path.join(tmp, key), 'utf8'))
                if (typeof record?.host_id !== 'string') throw new Error('missing host ID')
                siwcRecords.set(key, record)
              } catch {
                throw corruptBackup('invalid SIWC credential record')
              }
            }
          }
          if (key.startsWith('config/') && this.configDir) validateRestoreTarget(this.configDir, key.slice(7))
        }
        if (snapshotPath.endsWith('.pgdump') && !(await this._pgRestoreAvailable())) {
          throw Object.assign(new Error('pg_restore binary is required to restore custom PostgreSQL dumps'), {
            code: 'pg_restore_missing',
          })
        }
      } else {
        const prepared = await this._prepareRestoreArchive(rec, isPg)
        tmp = prepared.tmp
        dbFile = prepared.dbFile
      }
      if (!fs.existsSync(dbFile)) throw new Error('no db snapshot inside backup')

      const pre = await this.createBackup({ kind: 'pre_restore', note: `before restore of ${rec.id}` })

      const dbPath = getDbPath()
      if (isPg) {
        databaseClosed = true
        await this._restorePostgresSnapshot(dbFile)
        await getCacheRuntime().client.invalidate({ prefixes: ['apikey:', 'billing:', 'sched:', 'dash:'] })
      } else {
        await stopSqlitePool()
        closeDatabase()
        databaseClosed = true
        const keep = `${dbPath}.pre-restore`
        // A stale WAL can replay newer pages over the restored snapshot. Never
        // overwrite the database when a sidecar is still open or unremovable.
        for (const suffix of ['-wal', '-shm']) {
          fs.rmSync(dbPath + suffix, { force: true })
        }
        fs.rmSync(keep, { force: true })
        fs.renameSync(dbPath, keep)
        fs.copyFileSync(dbFile, dbPath)
        try {
          fs.chmodSync(dbPath, 0o600)
        } catch {}
      }

      // 3. restore vm + config files from the archive (tar flavor only)
      const vmsDirSrc = tmp ? path.join(tmp, 'vms') : null
      if (this.projectRoot && vmsDirSrc && fs.existsSync(vmsDirSrc)) {
        const vmsDir = path.join(this.projectRoot, 'vms')
        fs.mkdirSync(vmsDir, { recursive: true })
        // Replace top-level records, then restore only the credential files
        // explicitly staged and verified above. Other slot-home data stays put.
        for (const f of fs.readdirSync(vmsDir)) {
          if (isVmRecordFile(f) || f === 'active.json') {
            try {
              fs.rmSync(path.join(vmsDir, f), { force: true })
            } catch {}
          }
        }
        for (const key of files.filter((name) => name.startsWith('vms/'))) {
          const dest = path.join(this.projectRoot, key)
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
          const saved = siwcRecords.get(key)
          if (saved) {
            const current = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, 'utf8')) : null
            // Keep the newer local record, including an explicit local unbind.
            if (current && (!saved.owner || !current.owner || sameSiwcOwner(current.owner, saved.owner))) continue
            // A snapshot by itself cannot prove the grant did not rotate later.
            if (saved.refresh_token) saved.state = 'refresh_outcome_unknown'
            atomicWriteJson(dest, saved, { mode: 0o600, durable: true })
            continue
          }
          fs.copyFileSync(path.join(tmp, key), dest)
          try {
            fs.chmodSync(dest, 0o600)
          } catch {}
        }
      }
      const cfgDirSrc = tmp ? path.join(tmp, 'config') : null
      if (this.configDir && cfgDirSrc && fs.existsSync(cfgDirSrc)) {
        fs.mkdirSync(this.configDir, { recursive: true })
        for (const f of fs.readdirSync(cfgDirSrc)) {
          const dest = path.join(this.configDir, f)
          fs.copyFileSync(path.join(cfgDirSrc, f), dest)
          invalidateReadCache(dest)
        }
      }

      // 4. reopen + migrate (old backups upgrade automatically)
      const db = isPg ? getDb() : openDatabase({ dataDir: this.dataDir, dbPath })

      // 5. db-only backups: rebuild slot metadata (not OAuth credentials)
      if (this.projectRoot) {
        invalidateReadCache()
        try {
          reconcileVms(this.projectRoot)
          try {
            repairVmProxyCliEnabled(this.projectRoot)
          } catch {}
          try {
            repairSlotSmbios(this.projectRoot)
          } catch {}
          try {
            migrateScheduleFields(this.projectRoot)
          } catch {}
        } catch {}
      }

      // 6. the ledger itself rolled back with the DB — re-register the
      //    pre_restore snapshot (and any other on-disk archives) so the
      //    user can still see/undo from the panel.
      try {
        this._registerOrphanArchives([pre, rec])
      } catch {}

      // 7. re-bind stores to the fresh connection. A failed rebind leaves the
      //    process partially attached to the closed database, so it must make
      //    the restore fail instead of reporting a false success.
      if (this._rebindStores) await this._rebindStores(db)

      completed = true
      return { ok: true, restored: rec.id, pre_restore: pre.id }
    } finally {
      // Once database replacement starts, an error can leave stale/closed
      // stores. Keep protocol traffic paused until the operator recovers and
      // restarts, instead of serving against a partially restored state.
      this.isRestoring = databaseClosed && !completed
      if (tmp) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true })
        } catch {}
      }
    }
  }

  async _restorePostgresSnapshot(dbFile) {
    const pgConnectionString = buildPgConnectionString(getPgConfig())
    if (!pgConnectionString) throw new Error('PostgreSQL connection configuration unavailable for restore')
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./backup-worker.mjs', import.meta.url), {
        workerData: {
          op: 'pg_restore',
          engine: 'postgres',
          pgConnectionString,
          dbFile,
        },
      })
      let settled = false
      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        fn(arg)
      }
      worker.once('message', (msg) => {
        if (msg && msg.ok) return finish(resolve)
        finish(
          reject,
          Object.assign(new Error((msg && msg.error && msg.error.message) || 'PostgreSQL restore failed'), {
            code: (msg && msg.error && msg.error.code) || 'restore_failed',
          }),
        )
      })
      worker.once('error', (e) => finish(reject, e))
      worker.once('exit', (code) => {
        if (code !== 0) {
          finish(
            reject,
            Object.assign(new Error(`restore worker exited with code ${code}`), { code: 'restore_aborted' }),
          )
        } else {
          finish(reject, new Error('restore worker exited without a result'))
        }
      })
    })
  }

  /**
   * Insert ledger rows for archive files that exist on disk but have no
   * record in the (freshly restored) DB. `known` records are inserted
   * verbatim; remaining orphans get kind='imported'.
   */
  _registerOrphanArchives(known = []) {
    const repo = this._repo()
    const existing = new Set(repo.list({ limit: 500 }).map((r) => r.file_name))
    for (const rec of known) {
      if (rec?.file_name && !existing.has(rec.file_name) && rec.file_path && fs.existsSync(rec.file_path)) {
        try {
          repo.insert(rec)
          existing.add(rec.file_name)
        } catch {}
      }
    }
    if (!fs.existsSync(this.backupDir)) return
    for (const f of fs.readdirSync(this.backupDir)) {
      if (!/^kin-backup-.*\.(tar\.gz|db\.gz|pgdump|pg\.ndjson\.gz)$/.test(f) || existing.has(f)) continue
      const fp = path.join(this.backupDir, f)
      try {
        const st = fs.statSync(fp)
        repo.insert({
          id: 'bak_' + crypto.randomBytes(6).toString('hex'),
          created_at: st.mtime.toISOString(),
          kind: 'imported',
          status: 'ok',
          file_path: fp,
          file_name: f,
          size_bytes: st.size,
          sha256: sha256File(fp),
          db_bytes: null,
          includes: null,
          error: null,
          note: 're-registered from disk after restore',
        })
        existing.add(f)
      } catch {}
    }
  }

  // ---------- scheduler ----------

  /** Auto-backup checker: every checkIntervalMs + a catch-up run at boot. */
  startScheduler() {
    this.stopScheduler()
    const check = async () => {
      try {
        if (this.shouldRunScheduled()) {
          const rec = await this.createBackup({ kind: 'scheduled' })
          console.log(`[backup] scheduled backup completed (${Math.round((rec.size_bytes || 0) / 1048576)} MiB)`)
        }
      } catch (e) {
        console.warn('[backup] scheduled backup failed:', String(e.message || e))
      }
    }
    this._timer = setInterval(check, this.checkIntervalMs)
    if (typeof this._timer.unref === 'function') this._timer.unref()
    // boot catch-up (delayed so startup isn't blocked)
    this._bootTimer = setTimeout(check, 5_000)
    if (typeof this._bootTimer.unref === 'function') this._bootTimer.unref()
  }

  shouldRunScheduled(now = Date.now()) {
    const cfg = this.getSchedule()
    if (!cfg.enabled || this._running || this.isRestoring) return false
    const last = this._repo().lastSuccessful({})
    if (!last) return true
    return now - Date.parse(last.created_at) >= cfg.interval_hours * 3600_000
  }

  stopScheduler() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._bootTimer) {
      clearTimeout(this._bootTimer)
      this._bootTimer = null
    }
  }
}
