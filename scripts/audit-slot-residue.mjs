/** One-shot bounded audit; no migrations, inference, Docker cleanup or backup pruning. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { isValidVmId, isVmRecordFile } from '../src/lib/vm/vm-file.mjs'
import { cleanupVmFiles, findSlotResidue, slotResidueReferences } from '../src/lib/vm/slot-cleanup.mjs'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const rootArg = args.indexOf('--project-root')
const projectRoot = path.resolve(rootArg >= 0 ? args[rootArg + 1] : fileURLToPath(new URL('..', import.meta.url)))
const vmsRoot = path.join(projectRoot, 'vms')
const dataArg = args.indexOf('--data-dir')
const dataDir =
  dataArg >= 0 ? path.resolve(args[dataArg + 1]) : process.env.KIN_DATA_DIR || path.join(projectRoot, 'data')
const dbPath = process.env.KIN_DB_PATH || path.join(dataDir, 'kin.db')

function readRegistry() {
  const ids = new Set()
  for (const name of fs.readdirSync(vmsRoot).filter(isVmRecordFile)) {
    const id = name.slice(0, -5)
    // Even an unreadable registry record is not proof that its slot was deleted.
    ids.add(id)
  }
  if (!fs.existsSync(dbPath)) throw new Error('database_missing')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  let references
  try {
    for (const row of db.prepare('SELECT id FROM vms').all()) ids.add(row.id)
    references = slotResidueReferences(db, ids)
  } finally {
    db.close()
  }
  return { ids, references }
}

function containers() {
  const ids = execFileSync('docker', ['ps', '-aq'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const rows = ids.length
    ? JSON.parse(execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    : []
  return rows.map((row) => row.Config?.Labels?.['kin.vm.id']).filter(Boolean)
}

function processIdentity(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean)
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { cmd, start: tail[19], exited: tail[0] === 'Z' }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null
    throw error
  }
}

function kernels() {
  const result = []
  if (!fs.existsSync('/proc/self')) throw new Error('linux_process_inventory_required')
  for (const name of fs.readdirSync('/proc').filter((id) => /^\d+$/.test(id))) {
    const current = processIdentity(name)
    if (!current || current.exited) continue
    const configArg = current.cmd.find((arg) => arg.startsWith(vmsRoot + path.sep))
    if (!configArg) continue
    const relative = path.relative(vmsRoot, configArg).split(path.sep)
    if (!isValidVmId(relative[0])) continue
    const vmId = relative[0]
    let owned =
      relative.length === 3 &&
      relative[1] === 'run' &&
      relative[2] === 'codex-kernel.json' &&
      path.basename(current.cmd[0]) === 'kin-codex-kernel' &&
      current.cmd.length === 2 &&
      current.cmd[1] === configArg
    try {
      const config = JSON.parse(fs.readFileSync(configArg, 'utf8'))
      owned &&=
        config.vm_id === vmId &&
        config.socket_path === path.join(vmsRoot, vmId, 'run', 'codex-kernel.sock') &&
        config.credential_path === path.join(vmsRoot, vmId, 'codex-credentials.json')
    } catch {
      owned = false
    }
    result.push({ vmId, pid: Number(name), owned, cmd: current.cmd, start: current.start })
  }
  return result
}

async function stopOwnedProcess(item) {
  const same = () => {
    const current = processIdentity(item.pid)
    if (!current || current.exited) return false
    if (current.start !== item.start || JSON.stringify(current.cmd) !== JSON.stringify(item.cmd))
      throw new Error('process_identity_changed')
    return true
  }
  for (const [signal, timeout] of [
    ['SIGTERM', 2000],
    ['SIGKILL', 1000],
  ]) {
    if (!same()) return
    try {
      process.kill(item.pid, signal)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    const deadline = Date.now() + timeout
    while (same() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    if (!same()) return
  }
  throw new Error('owned_kernel_stop_timeout')
}

async function main() {
  const registry = readRegistry()
  const containerIds = containers()
  const audit = findSlotResidue({
    projectRoot,
    registeredIds: registry.ids,
    referencedIds: registry.references.keys(),
    containerIds,
    kernelProcesses: kernels(),
  })
  let reclaimed = 0
  let removed = 0
  let stopped = 0
  const cleanedDb = { profiles: 0, accounts: 0, keys: 0, endpoints: 0 }
  if (apply) {
    const { OpenaiApiRepo } = await import('../src/lib/db/repos/openai-api-repo.mjs')
    const { SlotBrowserRepo } = await import('../src/lib/db/repos/slot-browser-repo.mjs')
    for (const item of audit.candidates) {
      if (readRegistry().ids.has(item.vmId) || containers().includes(item.vmId))
        throw new Error('slot_became_registered')
      for (const process of item.processes) {
        await stopOwnedProcess(process)
        stopped += 1
      }
      if (readRegistry().ids.has(item.vmId) || containers().includes(item.vmId))
        throw new Error('slot_became_registered')
      const cleaned = cleanupVmFiles({ projectRoot, vmId: item.vmId })
      reclaimed += cleaned.reclaimed_bytes
      const db = new DatabaseSync(dbPath)
      try {
        if (db.prepare('SELECT 1 FROM vms WHERE id = ?').get(item.vmId)) throw new Error('slot_became_registered')
        const cleanup = new OpenaiApiRepo(db).cleanupForVm(item.vmId)
        const profiles = new SlotBrowserRepo(db, { migrateLegacy: false }).remove(item.vmId) ? 1 : 0
        for (const key of ['accounts', 'keys', 'endpoints']) cleanedDb[key] += cleanup[key]
        cleanedDb.profiles += profiles
      } finally {
        db.close()
      }
      removed += 1
    }
  }
  const idHash = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)
  console.log(
    JSON.stringify({
      mode: apply ? 'apply' : 'audit',
      confirmed_slots: audit.candidates.length,
      reclaimable_bytes: audit.candidates.reduce((sum, item) => sum + item.bytes, 0),
      stopped_kernels: stopped,
      removed_slots: removed,
      reclaimed_bytes: reclaimed,
      orphan_db_references: [...registry.references.values()].reduce(
        (sum, row) => sum + row.profiles + row.accounts + row.keys,
        0,
      ),
      cleaned_db: cleanedDb,
      unresolved: audit.unresolved.map((item) => ({ slot: idHash(item.vmId), reason: item.reason })),
    }),
  )
}

main().catch((error) => {
  const code = /^[a-z_]+$/.test(error.message || '') ? error.message : error.code || 'audit_failed'
  console.error(JSON.stringify({ ok: false, code }))
  process.exitCode = 1
})
