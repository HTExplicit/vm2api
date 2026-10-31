import fs from 'node:fs'
import path from 'node:path'
import { isValidVmId, vmLockBusy } from './vm-file.mjs'

function problem(code, message) {
  return Object.assign(new Error(message), { code })
}

function slotRoot(projectRoot) {
  const root = path.resolve(projectRoot, 'vms')
  if (fs.lstatSync(root).isSymbolicLink()) throw problem('slot_cleanup_path', '槽目录不能是符号链接')
  return root
}

/** Count real files only. Symlinks are unlinked, never followed into shared data. */
export function slotFileBytes(file) {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink()) return stat.size
  if (!stat.isDirectory()) return stat.size
  return fs.readdirSync(file).reduce((total, name) => total + slotFileBytes(path.join(file, name)), 0)
}

export function slotOwnedFiles({ projectRoot, vmId, includeRecord = false }) {
  if (!projectRoot || !isValidVmId(vmId)) throw problem('invalid_vm_id', 'invalid slot id')
  const root = slotRoot(projectRoot)
  const temporary = fs.readdirSync(root).filter((name) => {
    const prefix = `.${vmId}-keep-`
    return name.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length))
  })
  return [vmId, `${vmId}-chat.json`, ...(includeRecord ? [`${vmId}.json`] : []), ...temporary]
    .map((name) => {
      const file = path.resolve(root, name)
      if (path.dirname(file) !== root) throw problem('slot_cleanup_path', '槽文件不在预期目录')
      return file
    })
    .filter((file) => fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
}

/** Caller stops the slot/browser first; a reset holding its VM lock must finish. */
export function cleanupVmFiles({
  projectRoot,
  vmId,
  resetInProgress = vmLockBusy(path.join(projectRoot, 'vms', `${vmId}.json`)),
}) {
  if (resetInProgress) throw problem('slot_cleanup_busy', '槽位正在重建，请稍后删除')
  const files = slotOwnedFiles({ projectRoot, vmId })
  let bytes = 0
  let removed = 0
  for (const file of files) {
    const size = slotFileBytes(file)
    try {
      fs.rmSync(file, { recursive: true, force: false })
    } catch (error) {
      throw Object.assign(problem('slot_cleanup_failed', `槽位文件清理失败 (${error.code || 'io_error'})`), {
        removed,
        reclaimed_bytes: bytes,
      })
    }
    bytes += size
    removed += 1
  }
  return { removed, reclaimed_bytes: bytes }
}

/** Limited to slot directories/sidecars created by this application. */
export function findSlotResidue({
  projectRoot,
  registeredIds,
  referencedIds = [],
  containerIds = [],
  kernelProcesses = [],
}) {
  const root = slotRoot(projectRoot)
  const registered = new Set(registeredIds)
  const live = new Set([...registered, ...containerIds])
  const candidates = new Map()
  const blocked = new Set()
  const unresolved = []
  for (const id of containerIds) {
    if (!registered.has(id)) unresolved.push({ vmId: id, reason: 'container_without_registered_slot' })
  }
  for (const name of fs.readdirSync(root)) {
    let id = name
    if (name.endsWith('-chat.json')) id = name.slice(0, -10)
    else if (name.startsWith('.')) id = name.match(/^\.([A-Za-z0-9_-]+)-keep-[A-Za-z0-9]{6}$/)?.[1]
    if (!id || !isValidVmId(id) || live.has(id) || (name.endsWith('.json') && !name.endsWith('-chat.json'))) continue
    const file = path.join(root, name)
    const stat = fs.lstatSync(file)
    if (name === id) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        unresolved.push({ vmId: id, reason: 'unrecognized_slot_path' })
        blocked.add(id)
        continue
      }
      const owned =
        fs.existsSync(path.join(file, 'codex-credentials.json')) ||
        (fs.existsSync(path.join(file, 'machine-id')) && fs.existsSync(path.join(file, 'cli-home'))) ||
        fs.existsSync(path.join(file, 'run', 'codex-kernel.json'))
      if (!owned) {
        unresolved.push({ vmId: id, reason: 'missing_slot_identity' })
        blocked.add(id)
        continue
      }
    }
    candidates.set(id, { vmId: id, files: [], bytes: 0, processes: [] })
  }
  for (const id of blocked) candidates.delete(id)
  for (const id of referencedIds) {
    if (isValidVmId(id) && !live.has(id) && !blocked.has(id) && !candidates.has(id)) {
      candidates.set(id, { vmId: id, files: [], bytes: 0, processes: [] })
    }
  }
  for (const item of candidates.values()) {
    item.files = slotOwnedFiles({ projectRoot, vmId: item.vmId })
    item.bytes = item.files.reduce((sum, file) => sum + slotFileBytes(file), 0)
    item.processes = kernelProcesses.filter((p) => p.vmId === item.vmId)
    if (item.processes.some((p) => !p.owned)) {
      candidates.delete(item.vmId)
      unresolved.push({ vmId: item.vmId, reason: 'unverified_process_owner' })
    }
  }
  for (const process of kernelProcesses) {
    if (
      !live.has(process.vmId) &&
      !candidates.has(process.vmId) &&
      !unresolved.some((row) => row.vmId === process.vmId)
    ) {
      unresolved.push({ vmId: process.vmId, reason: 'process_without_verified_slot_files' })
    }
  }
  return { candidates: [...candidates.values()], unresolved }
}

/** Current slot associations only. Never decode credentials or historical logs. */
export function slotResidueReferences(db, registeredIds) {
  const live = new Set(registeredIds)
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  )
  const references = new Map()
  for (const [table, column, kind] of [
    ['slot_browser_profiles', 'vm_id', 'profiles'],
    ['openai_api_accounts', 'vm_id', 'accounts'],
    ['api_endpoint_keys', 'source_vm_id', 'keys'],
  ]) {
    if (!tables.has(table)) continue
    for (const row of db
      .prepare(`SELECT ${column} AS vm_id, COUNT(*) AS count FROM ${table} WHERE ${column} != '' GROUP BY ${column}`)
      .all()) {
      if (!isValidVmId(row.vm_id) || live.has(row.vm_id)) continue
      const record = references.get(row.vm_id) || { profiles: 0, accounts: 0, keys: 0 }
      record[kind] = row.count
      references.set(row.vm_id, record)
    }
  }
  return references
}
