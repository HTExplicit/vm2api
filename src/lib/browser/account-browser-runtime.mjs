import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runShardHelper, SHARD_SDK_VERSION } from './shard-runtime-helper.mjs'

export { SHARD_SDK_VERSION }
export const SHARD_MANIFEST_URL = 'https://raw.githubusercontent.com/ProxyShard/ShardBrowser/main/runtime.json'
const VERSION = /^\d+(?:\.\d+){3}$/
const NUMERIC_VERSION = /^\d+(?:\.\d+)*$/
const COMPONENTS = {
  browser: 'ShardX-Linux.zip',
  fingerprints: 'ShardX-Fingerprints.zip',
  widevine: 'ShardX-Widevine-Linux.zip',
}
const exec = promisify(execFile)

function problem(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status, publicMessage: message })
}

export function compareBrowserVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return Math.sign(difference)
  }
  return 0
}

export function safeAccountBrowserError(error) {
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'browser_runtime_error'
  const message = String(error?.message || '账号浏览器操作失败')
    .replace(/(?:sk-|cb_)[A-Za-z0-9_-]+/g, '[key]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .slice(0, 500)
  return { code, message }
}

function readJson(file) {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function identity(info) {
  return { version: info.version, build: info.build, components: { ...info.components } }
}

function sameIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.version === right.version &&
      left.build === right.build &&
      Object.keys(COMPONENTS).every((key) => left.components?.[key] === right.components?.[key]),
  )
}

/** Local metadata only. Status never launches the executable or contacts upstream. */
export function localShardInfo(cacheDir) {
  const executablePath = path.join(cacheDir, 'ShardX-Linux', 'chrome')
  const manifest = readJson(path.join(cacheDir, 'manifest.json'))
  const buildFile = path.join(cacheDir, 'ShardX-Linux', 'shardx-build')
  return {
    installed: fs.existsSync(executablePath),
    executablePath,
    version: manifest?.installed_chromium_version || null,
    build: fs.existsSync(buildFile)
      ? fs.readFileSync(buildFile, 'utf8').trim()
      : manifest?.installed_engine_build || null,
    components: {
      browser: manifest?.browser_etag || null,
      fingerprints: manifest?.fingerprints_etag || null,
      widevine: manifest?.widevine_etag || null,
    },
  }
}

function releaseFromManifest(data) {
  const build = String(data?.engine_build ?? '')
  if (
    !VERSION.test(data?.chromium_version || '') ||
    !NUMERIC_VERSION.test(build) ||
    !NUMERIC_VERSION.test(data?.min_sdk_version || '') ||
    Object.values(COMPONENTS).some((name) => typeof data?.archives?.[name] !== 'string' || !data.archives[name])
  )
    throw problem('browser_update_check_failed', '浏览器版本服务返回了无效发布信息', 502)
  return {
    version: data.chromium_version,
    build,
    minSdkVersion: data.min_sdk_version,
    components: Object.fromEntries(Object.entries(COMPONENTS).map(([key, name]) => [key, data.archives[name]])),
  }
}

/** Chromium/build order prevents downgrades; archive tags identify same-version component changes. */
export function browserUpdateStatus(installed, latest, { retry = false, checkFailed = false } = {}) {
  if (latest && compareBrowserVersions(latest.minSdkVersion, SHARD_SDK_VERSION) > 0)
    return 'application_update_required'
  if (checkFailed) return 'check_failed'
  if (latest && installed.installed && installed.version) {
    const versionOrder = compareBrowserVersions(latest.version, installed.version)
    const buildOrder = installed.build ? compareBrowserVersions(latest.build, installed.build) : 0
    if (versionOrder < 0 || (versionOrder === 0 && buildOrder < 0)) return 'newer_installed'
  }
  if (retry) return 'retry_required'
  if (!installed.installed) return 'not_installed'
  if (!latest) return 'unchecked'
  if (!installed.version || compareBrowserVersions(latest.version, installed.version) > 0) return 'update_available'
  if (!installed.build || compareBrowserVersions(latest.build, installed.build) > 0) return 'update_available'
  if (Object.keys(COMPONENTS).some((key) => latest.components[key] !== installed.components[key]))
    return 'components_available'
  return 'current'
}

async function defaultUpdate({ cacheDir, force, refreshWidevine, signal, onProgress }) {
  const args = [cacheDir, ...(force ? ['--force'] : []), ...(refreshWidevine ? ['--refresh-widevine'] : [])]
  return runShardHelper('install', args, { signal, onProgress })
}

/** File/version verification only: deliberately does not start an interactive browser or load a page. */
export async function verifyShardInstall({ cacheDir, target, signal, execVersion = exec }) {
  const installed = localShardInfo(cacheDir)
  if (!installed.installed || !sameIdentity(installed, target))
    throw problem('browser_version_mismatch', '实际安装版本或组件与目标不一致，请重新检查并重试安装', 502)
  for (const name of [
    'chrome',
    'icudtl.dat',
    'resources.pak',
    'libEGL.so',
    'libGLESv2.so',
    'libvk_swiftshader.so',
    'WidevineCdm/manifest.json',
    'WidevineCdm/_platform_specific/linux_x64/libwidevinecdm.so',
  ]) {
    const file = path.join(cacheDir, 'ShardX-Linux', name)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.statSync(file).size)
      throw problem('browser_install_incomplete', `浏览器安装缺少必要文件：${name}`, 502)
  }
  const fingerprints = path.join(cacheDir, 'fingerprints')
  if (!fs.existsSync(fingerprints) || !fs.readdirSync(fingerprints).some((name) => name.endsWith('.json')))
    throw problem('browser_install_incomplete', '浏览器指纹模板尚未安装', 502)
  const { stdout } = await execVersion(installed.executablePath, ['--version'], {
    signal,
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 4096,
  })
  const actualVersion = stdout.match(/\b\d+(?:\.\d+){3}\b/)?.[0]
  if (actualVersion !== target.version)
    throw problem('browser_version_mismatch', '浏览器可执行文件版本与目标不一致，请重试安装', 502)
  return identity(installed)
}

/** One installation job shares the existing browser queue's reservation. */
export class AccountBrowserRuntime {
  constructor({
    dataDir,
    getBusy = () => false,
    getActiveVersion = () => null,
    onIdle = () => {},
    fetch: fetchImpl = globalThis.fetch,
    runUpdate = defaultUpdate,
    verifyInstall = verifyShardInstall,
    now = Date.now,
  } = {}) {
    this.cacheDir = path.join(path.resolve(dataDir), 'browser-runtime', 'shardbrowser')
    this.receiptFile = path.join(this.cacheDir, 'installation.json')
    Object.assign(this, { getBusy, getActiveVersion, onIdle, fetchImpl, runUpdate, verifyInstall, now })
    this.receipt = readJson(this.receiptFile) || { verified: null, pending: false, last_error: null }
    const interrupted = this.receipt.pending
      ? safeAccountBrowserError(problem('browser_install_interrupted', '上次浏览器安装未完成，请重试安装'))
      : null
    this.state = {
      checked_at: null,
      installing: false,
      phase: interrupted || this.receipt.last_error ? 'failed' : 'idle',
      progress: null,
      last_error: interrupted || this.receipt.last_error,
    }
    this.latestRelease = null
    this.checkFailed = false
    this.task = null
    this.controller = null
    this.stopped = false
  }

  get isInstalling() {
    return this.state.installing
  }

  saveReceipt() {
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 })
    const temp = `${this.receiptFile}.tmp`
    fs.writeFileSync(temp, JSON.stringify(this.receipt), { mode: 0o600 })
    fs.renameSync(temp, this.receiptFile)
  }

  status() {
    const installed = localShardInfo(this.cacheDir)
    return {
      launcher_version: SHARD_SDK_VERSION,
      installed_version: installed.installed ? installed.version : null,
      installed_build: installed.installed ? installed.build : null,
      running_version: this.getActiveVersion() || null,
      latest_version: this.latestRelease?.version || null,
      latest_build: this.latestRelease?.build || null,
      ...this.state,
      update_status: browserUpdateStatus(installed, this.latestRelease, {
        retry: Boolean(
          this.receipt.pending ||
            this.receipt.last_error ||
            (installed.installed && !sameIdentity(installed, this.receipt.verified)),
        ),
        checkFailed: this.checkFailed,
      }),
      browser_busy: Boolean(this.getBusy()),
    }
  }

  assertIdle() {
    if (this.stopped) throw problem('browser_runtime_stopped', '账号浏览器服务正在关闭', 503)
    if (this.isInstalling) throw problem('browser_installing', '账号浏览器正在安装更新')
    if (this.state.phase === 'checking') throw problem('browser_checking', '正在检查浏览器版本，请稍候')
    if (this.getBusy()) throw problem('browser_busy', '请先关闭当前浏览器，再安装更新')
  }

  async latest(signal) {
    try {
      const response = await this.fetchImpl(SHARD_MANIFEST_URL, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      })
      if (!response.ok)
        throw problem('browser_update_check_failed', `浏览器版本检查失败（HTTP ${response.status}）`, 502)
      const release = releaseFromManifest(await response.json())
      this.latestRelease = release
      this.state.checked_at = new Date(this.now()).toISOString()
      this.checkFailed = false
      return release
    } catch (error) {
      this.latestRelease = null
      this.state.checked_at = null
      this.checkFailed = true
      throw problem('browser_update_check_failed', safeAccountBrowserError(error).message, 502)
    }
  }

  async check() {
    if (this.stopped) throw problem('browser_runtime_stopped', '账号浏览器服务正在关闭', 503)
    if (this.isInstalling) throw problem('browser_installing', '账号浏览器正在安装更新')
    if (this.state.phase === 'checking') throw problem('browser_checking', '正在检查浏览器版本，请稍候')
    this.state.phase = 'checking'
    try {
      await this.latest()
      // A check does not turn a previous incomplete installation into a success.
      if (!this.isInstalling) {
        this.state.last_error = this.receipt.last_error || (this.receipt.pending ? this.state.last_error : null)
        this.state.phase = this.state.last_error ? 'failed' : 'idle'
      }
    } catch (error) {
      const failure = problem('browser_update_check_failed', safeAccountBrowserError(error).message, 502)
      if (!this.isInstalling) {
        this.latestRelease = null
        this.state.checked_at = null
        this.checkFailed = true
        this.state.phase = 'failed'
        this.state.last_error = safeAccountBrowserError(failure)
      }
      throw failure
    }
    return this.status()
  }

  install() {
    this.assertIdle()
    this.state.installing = true
    this.state.phase = 'checking'
    this.state.progress = null
    this.state.last_error = null
    this.controller = new AbortController()
    this.task = Promise.resolve().then(() => this.installLatest(this.controller.signal))
    this.task.catch(() => {})
    return this.status()
  }

  async installLatest(signal) {
    let attempted = false
    try {
      const before = localShardInfo(this.cacheDir)
      const target = await this.latest(signal)
      signal.throwIfAborted()
      const update = browserUpdateStatus(before, target)
      if (update === 'application_update_required')
        throw problem('browser_application_update_required', '官方内核需要更高版本的安装组件，请先升级应用')
      if (
        update === 'newer_installed' ||
        (update === 'current' &&
          !this.receipt.pending &&
          !this.receipt.last_error &&
          sameIdentity(before, this.receipt.verified))
      ) {
        this.state.phase = 'idle'
        return
      }
      // A failed same-version installation can be retried explicitly. A failed
      // download of a newer version does not force reinstalling the old engine.
      const force = update === 'current' || (before.installed && !before.version)
      this.receipt.pending = true
      this.receipt.last_error = null
      this.saveReceipt()
      attempted = true
      this.state.phase = 'downloading'
      await this.runUpdate({
        cacheDir: this.cacheDir,
        target,
        force,
        refreshWidevine: before.components.widevine !== target.components.widevine,
        signal,
        onProgress: ({ phase, progress }) => {
          if (['downloading', 'installing'].includes(phase)) this.state.phase = phase
          this.state.progress = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null
        },
      })
      signal.throwIfAborted()
      this.state.phase = 'verifying'
      this.state.progress = null
      const verified = await this.verifyInstall({ cacheDir: this.cacheDir, target, signal })
      signal.throwIfAborted()
      this.receipt = { verified, pending: false, last_error: null }
      this.saveReceipt()
      this.state.phase = 'ready'
      this.state.progress = 100
    } catch (error) {
      const failure = safeAccountBrowserError(error)
      if (error.code === 'browser_update_check_failed' || !this.latestRelease) {
        this.latestRelease = null
        this.state.checked_at = null
        this.checkFailed = true
      }
      this.state.phase = 'failed'
      this.state.progress = null
      this.state.last_error = failure
      if (attempted) {
        this.receipt.pending = false
        this.receipt.last_error = failure
        this.saveReceipt()
      }
    } finally {
      this.state.installing = false
      this.controller = null
      await this.onIdle()
    }
  }

  launchConfig() {
    if (this.stopped) throw problem('browser_runtime_stopped', '账号浏览器服务正在关闭', 503)
    if (this.isInstalling) throw problem('browser_installing', '账号浏览器正在安装更新')
    const installed = localShardInfo(this.cacheDir)
    if (!installed.installed) throw problem('browser_not_installed', '请先在账号浏览器设置中安装内核', 400)
    if (this.receipt.pending || this.receipt.last_error || !sameIdentity(installed, this.receipt.verified))
      throw problem('browser_install_unverified', '浏览器安装尚未完成文件与版本核对，请在设置中重试安装', 503)
    return { cacheDir: this.cacheDir }
  }

  async shutdown() {
    this.stopped = true
    this.controller?.abort(problem('browser_runtime_stopped', '账号浏览器安装已停止'))
    await this.task
  }
}
