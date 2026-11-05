import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEMP_NAME = /^(?:playwright-artifacts-|playwright_firefoxdev_profile-)[A-Za-z0-9]{6}$/
const BROWSER_NAME = /^(?:firefox|camoufox)(?:-bin)?$/

export function isBrowserExecutable(executable) {
  return BROWSER_NAME.test(path.basename(executable || ''))
}

function dedicatedControlContainer() {
  return (
    process.platform === 'linux' &&
    (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) &&
    process.env.KIN_PROJECT_ROOT === '/opt/vm2api' &&
    process.cwd() === '/opt/vm2api'
  )
}

/** Inspect browser identities and profile arguments, never log process arguments. */
function browserProcesses({ executablePath, uid }) {
  const result = { activeBrowser: false, references: [], unknown: false }
  let entries
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return { ...result, unknown: true }
  }
  for (const id of entries) {
    if (!/^\d+$/.test(id)) continue
    const root = path.join('/proc', id)
    try {
      const status = fs.readFileSync(path.join(root, 'status'), 'utf8')
      if (Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== uid) continue
      const command = fs.readFileSync(path.join(root, 'comm'), 'utf8').trim()
      const args = fs.readFileSync(path.join(root, 'cmdline'), 'utf8').split('\0').filter(Boolean)
      const profiles = args.flatMap((arg, index) => {
        if (['-profile', '--profile', '--user-data-dir'].includes(arg)) return args[index + 1] || []
        return arg.startsWith('--user-data-dir=') ? [arg.slice(16)] : []
      })
      let executable
      try {
        executable = fs.readlinkSync(path.join(root, 'exe')).replace(/ \(deleted\)$/, '')
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
      }
      if (
        BROWSER_NAME.test(command) ||
        isBrowserExecutable(executable) ||
        (executablePath && executable === executablePath) ||
        profiles.length
      ) {
        result.activeBrowser = true
        result.references.push(...profiles)
      }
    } catch (error) {
      // Processes that exit during inspection no longer own temporary files.
      if (!['ENOENT', 'ESRCH'].includes(error.code)) result.unknown = true
    }
  }
  return result
}

function bytesIn(root) {
  const entry = fs.lstatSync(root)
  if (entry.isSymbolicLink() || !entry.isDirectory()) return entry.size
  return fs.readdirSync(root).reduce((total, name) => total + bytesIn(path.join(root, name)), 0)
}

function warningFor(report) {
  const failures = report.failed.map((item) => `${item.name} (${item.code})`)
  const skipped = report.skipped.filter((item) => item.reason !== 'reported_only')
  if (failures.length) return `浏览器临时文件清理失败：${failures.join('、')}`.slice(0, 300)
  if (skipped.length)
    return `浏览器临时目录保留：${skipped.map((item) => `${item.name} (${item.reason})`).join('、')}`.slice(0, 300)
  if (report.skipped.some((item) => item.reason === 'reported_only')) return '浏览器临时目录仅报告，未自动清理'
  return null
}

/**
 * Only the dedicated control container owns these Playwright temporary paths.
 * Calls are serialized with browser launch/close; no periodic collector runs.
 * readProcesses returns { activeBrowser, references: string[], unknown }.
 */
export function createBrowserTempCleanup({
  tmpDir = os.tmpdir(),
  executablePath,
  enabled = dedicatedControlContainer(),
  uid = process.getuid?.(),
  readProcesses = browserProcesses,
  remove = (file) => fs.promises.rm(file, { recursive: true, force: false }),
} = {}) {
  const root = path.resolve(tmpDir)
  const inspect = (file) => {
    if (path.dirname(file) !== root || !TEMP_NAME.test(path.basename(file))) return { reason: 'outside_scope' }
    const entry = fs.lstatSync(file, { throwIfNoEntry: false })
    if (!entry) return null
    if (entry.isSymbolicLink() || !entry.isDirectory()) return { reason: 'not_owned_directory' }
    if (entry.uid !== uid) return { reason: 'different_owner' }
    if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(root)) return { reason: 'path_changed' }
    return { entry }
  }
  const snapshot = () => {
    const found = new Set()
    try {
      for (const name of fs.readdirSync(root)) {
        if (!TEMP_NAME.test(name)) continue
        const file = path.join(root, name)
        if (inspect(file)?.entry) found.add(file)
      }
    } catch {
      // cleanup() reports the underlying directory access error separately.
    }
    return found
  }
  return {
    enabled,
    snapshot,
    createdSince(before) {
      return [...snapshot()].filter((file) => !before.has(file))
    },
    async cleanup({ paths } = {}) {
      const report = { removed: 0, reclaimed_bytes: 0, skipped: [], failed: [], warning: null }
      let files
      try {
        files =
          paths ||
          fs
            .readdirSync(root)
            .filter((name) => TEMP_NAME.test(name))
            .map((name) => path.join(root, name))
      } catch (error) {
        report.failed.push({ name: path.basename(root), code: error.code || 'io_error' })
        report.warning = warningFor(report)
        return report
      }
      let processes
      if (enabled && files.length) {
        try {
          processes = await readProcesses({ executablePath, uid })
        } catch {
          processes = { unknown: true }
        }
      }
      for (const value of new Set(files)) {
        const file = path.resolve(value)
        const name = path.basename(file)
        try {
          const candidate = inspect(file)
          if (!candidate) continue
          let reason = candidate.reason
          if (!reason && !enabled) reason = 'reported_only'
          if (!reason && processes?.unknown) reason = 'process_inventory_unavailable'
          if (!reason && processes?.references?.some((reference) => path.resolve(reference) === file))
            reason = 'process_reference'
          if (!reason && processes?.activeBrowser) reason = 'active_browser'
          if (reason) {
            report.skipped.push({ name, reason })
            continue
          }
          const bytes = bytesIn(file)
          const current = inspect(file)
          if (
            !current?.entry ||
            current.entry.ino !== candidate.entry.ino ||
            current.entry.dev !== candidate.entry.dev
          ) {
            report.skipped.push({ name, reason: 'path_changed' })
            continue
          }
          await remove(file)
          report.removed += 1
          report.reclaimed_bytes += bytes
        } catch (error) {
          if (error.code !== 'ENOENT') report.failed.push({ name, code: error.code || 'io_error' })
        }
      }
      report.warning = warningFor(report)
      return report
    },
  }
}
