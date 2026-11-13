import fs from 'node:fs'
import path from 'node:path'
import { isValidVmId } from '../vm/vm-file.mjs'

export const SHARD_BROWSER_MIGRATION_SETTING = 'account_browser_shard_migrated'

function removeOwnedDirectory(root, relative) {
  const base = path.resolve(root)
  const target = path.resolve(base, relative)
  if (!target.startsWith(base + path.sep)) throw new Error('Browser migration path is outside its root')
  if (!fs.existsSync(path.dirname(target))) return
  const actualBase = fs.realpathSync(base)
  const actualParent = fs.realpathSync(path.dirname(target))
  const parentRelative = path.relative(actualBase, actualParent)
  if (parentRelative === '..' || parentRelative.startsWith('..' + path.sep) || path.isAbsolute(parentRelative))
    throw new Error('Browser migration parent is outside its root')
  fs.rmSync(target, { recursive: true, force: true })
}

/** One bounded cleanup before new browser sessions are accepted. A failed
 * cleanup remains pending; the caller reports it without stopping the API. */
export function migrateBrowserData({ projectRoot, dataDir, settingsRepo, vmIds }) {
  if (settingsRepo.get(SHARD_BROWSER_MIGRATION_SETTING) === true) return
  try {
    const ids = [...new Set(vmIds)]
    if (ids.some((id) => !isValidVmId(id))) throw new Error('Invalid slot id in browser migration')
    for (const id of ids) removeOwnedDirectory(projectRoot, path.join('vms', id, 'browser-profile'))
    removeOwnedDirectory(dataDir, path.join('browser-runtime', 'cloakbrowser'))
    settingsRepo.set(SHARD_BROWSER_MIGRATION_SETTING, true)
  } catch (cause) {
    const message = '旧浏览器数据清理未完成，请检查目录权限后重试。'
    throw Object.assign(new Error(message, { cause }), {
      code: 'browser_data_migration_failed',
      status: 503,
      publicMessage: message,
    })
  }
}
