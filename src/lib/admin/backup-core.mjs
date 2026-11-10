/**
 * Backup pipeline primitives.
 *
 * Why this module exists: the whole pipeline (VACUUM INTO of a multi-GB
 * database, sha256 of the snapshot, `tar -czf`, sha256 of the archive, staging
 * cleanup) is synchronous. Running it on the gateway's main thread stops the
 * HTTP server from answering any request for the entire backup — a 3-5 minute
 * hole that turns into Cloudflare 524s for /v1 traffic, the panel and /healthz.
 *
 * So the pipeline lives here and is executed by backup-worker.mjs on its own
 * thread with its own database connection, while BackupService stays a thin
 * orchestrator on the main thread.
 *
 * `tar` is required: the DB only mirrors slot metadata, so a database-only
 * fallback would silently omit the credentials needed for disaster recovery.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { getDb, vacuumInto } from '../db/database.mjs'
import { BackupRepo } from '../db/repos/backup-repo.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'

// Deliberately bounded: guest disks, sockets, caches and binaries are not part
// of this archive. Codex OAuth is not mirrored into the database.
export const SLOT_BACKUP_FILES = ['codex-credentials.json']

export function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-')
}

// Chunked on purpose: the DB snapshot and the archive both outgrow Node's
// ~2 GiB Buffer ceiling, and readFileSync would throw before hashing.
export function sha256File(file) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
    let read = 0
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(read === buf.length ? buf : buf.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

export function tarAvailable() {
  try {
    const r = spawnSync('tar', ['--version'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

/** Staging dir on the data volume — the DB snapshot can be several GB. */
function mkdtempOnDataVolume({ tmpDir }) {
  const base = process.env.KIN_BACKUP_TMPDIR || tmpDir
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(base, 0o700)
  } catch {}
  return fs.mkdtempSync(path.join(base, 'kin-backup-'))
}

/** Drop backups past the retention window (pre_restore keeps the newest 3). */
function applyRetention(repo, retention) {
  const drop = [...repo.beyondRetention(retention), ...repo.preRestoreBeyond(3)]
  for (const rec of drop) {
    try {
      if (rec.file_path && fs.existsSync(rec.file_path)) fs.rmSync(rec.file_path, { force: true })
    } catch {}
    try {
      repo.remove(rec.id)
    } catch {}
  }
  return drop.length
}

/**
 * Run one backup job end to end. Blocking by design — call it from a worker
 * thread (or the test process), never from the gateway's main thread.
 *
 * The caller owns the database connection: open it (openDatabase/openDatabase
 * singleton) before calling and close it afterwards.
 *
 * @returns backup record (status 'ok')
 */
export function runBackupJob(ctx, { id, createdAt, kind = 'manual', note = null, retention = 7 }) {
  const repo = new BackupRepo(getDb())
  let tmp = null
  try {
    if (!tarAvailable()) throw new Error('tar is required to back up slot credentials and configuration')
    fs.mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(ctx.backupDir, 0o700)
    } catch {}
    tmp = mkdtempOnDataVolume(ctx)

    // 1. online-consistent DB snapshot (WAL-safe)
    const dbSnap = path.join(tmp, 'db', 'kin.db')
    vacuumInto(getDb(), dbSnap)
    const dbBytes = fs.statSync(dbSnap).size

    // 2. vm files + config files
    const includes = { db: true, vms: 0, config: 0 }
    const sha256s = { 'db/kin.db': sha256File(dbSnap) }
    const vmsDir = ctx.projectRoot ? path.join(ctx.projectRoot, 'vms') : null
    if (vmsDir && fs.existsSync(vmsDir)) {
      const outVms = path.join(tmp, 'vms')
      fs.mkdirSync(outVms, { recursive: true })
      const copyVmFile = (rel) => {
        const src = path.join(vmsDir, rel)
        if (!fs.lstatSync(src).isFile()) throw new Error(`backup requires a regular file: vms/${rel}`)
        const dest = path.join(outVms, rel)
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
        fs.copyFileSync(src, dest)
        fs.chmodSync(dest, 0o600)
        // Hash the staged bytes: the live credential can rotate after copying.
        sha256s[`vms/${rel}`] = sha256File(dest)
        includes.vms += 1
      }
      for (const f of fs.readdirSync(vmsDir)) {
        const src = path.join(vmsDir, f)
        if (f.endsWith('.json')) copyVmFile(f)
        else if (isValidVmId(f) && fs.lstatSync(src).isDirectory()) {
          for (const name of SLOT_BACKUP_FILES) {
            const rel = `${f}/${name}`
            const st = fs.lstatSync(path.join(vmsDir, rel), { throwIfNoEntry: false })
            if (st) copyVmFile(rel)
          }
        } else if (isValidVmId(f) && fs.lstatSync(src).isSymbolicLink()) {
          throw new Error(`backup refuses a linked slot directory: vms/${f}`)
        }
      }
    }
    if (ctx.configDir && fs.existsSync(ctx.configDir)) {
      const outCfg = path.join(tmp, 'config')
      fs.mkdirSync(outCfg, { recursive: true })
      for (const f of fs.readdirSync(ctx.configDir)) {
        if (!/\.json$/.test(f)) continue
        const src = path.join(ctx.configDir, f)
        if (!fs.lstatSync(src).isFile()) throw new Error(`backup requires a regular file: config/${f}`)
        const dest = path.join(outCfg, f)
        fs.copyFileSync(src, dest)
        fs.chmodSync(dest, 0o600)
        sha256s[`config/${f}`] = sha256File(dest)
        includes.config += 1
      }
    }

    // 3. manifest
    const manifest = {
      version: 1,
      tool: 'kin-gateway',
      created_at: createdAt,
      kind,
      includes,
      sha256s,
    }
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2))

    // 4. archive
    const fileName = `kin-backup-${stamp(new Date(createdAt))}.tar.gz`
    const filePath = path.join(ctx.backupDir, fileName)
    const r = spawnSync('tar', ['-czf', filePath, '-C', tmp, '.'], { stdio: 'pipe' })
    if (r.status !== 0) {
      fs.rmSync(filePath, { force: true })
      throw new Error(`tar failed: ${String(r.stderr || '').slice(0, 300)}`)
    }
    try {
      fs.chmodSync(filePath, 0o600)
    } catch {}

    const rec = repo.insert({
      id,
      created_at: createdAt,
      kind,
      status: 'ok',
      file_path: filePath,
      file_name: fileName,
      size_bytes: fs.statSync(filePath).size,
      sha256: sha256File(filePath),
      db_bytes: dbBytes,
      includes,
      error: null,
      note,
    })
    applyRetention(repo, retention)
    return rec
  } catch (e) {
    try {
      repo.insert({
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
    } catch {}
    throw e
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {}
    }
  }
}
