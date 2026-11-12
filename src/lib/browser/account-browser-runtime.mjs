import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { binaryInfo, launchPersistentContext, licenseDenial } from 'cloakbrowser'
import { decryptString, encryptString, encryptionEnabled, isEncrypted } from '../db/secure.mjs'
import { createHeadedDisplay } from './headed-display.mjs'

export const ACCOUNT_BROWSER_KEY_SETTING = 'account_browser_cloakbrowser_key'
const VERSION = /^\d+(?:\.\d+){3,4}$/
const RUNTIME_FILE = fileURLToPath(import.meta.url)
const CLOAK_ENTRY = fileURLToPath(import.meta.resolve('cloakbrowser'))
const CLOAK_CLI = path.join(path.dirname(CLOAK_ENTRY), 'cli.js')
const LAUNCHER_VERSION = JSON.parse(
  fs.readFileSync(path.join(path.dirname(CLOAK_ENTRY), '..', 'package.json'), 'utf8'),
).version

function problem(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status, publicMessage: message })
}

export function safeAccountBrowserError(error) {
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'browser_runtime_error'
  const message = String(error?.message || '账号浏览器操作失败')
    .replace(/cb_[A-Za-z0-9_-]+/g, '[license key]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .slice(0, 500)
  return { code, message }
}

// binaryInfo is synchronous and only reads local files. Keep its environment
// scoped to this call; an asynchronous download must run in its own process.
function localBinaryInfo(cacheDir) {
  const previous = Object.fromEntries(
    ['CLOAKBROWSER_CACHE_DIR', 'CLOAKBROWSER_VERSION'].map((key) => [key, process.env[key]]),
  )
  try {
    process.env.CLOAKBROWSER_CACHE_DIR = cacheDir
    delete process.env.CLOAKBROWSER_VERSION
    return binaryInfo(undefined, 'stable')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function childEnvironment(cacheDir, licenseKey) {
  const env = {
    ...process.env,
    CLOAKBROWSER_CACHE_DIR: cacheDir,
    CLOAKBROWSER_LICENSE_KEY: licenseKey,
    CLOAKBROWSER_AUTO_UPDATE: 'false',
    CLOAKBROWSER_RELEASE_CHANNEL: 'stable',
  }
  delete env.CLOAKBROWSER_VERSION
  delete env.CLOAKBROWSER_BINARY_PATH
  return env
}

function runChild(args, { env, signal, onOutput = () => {}, timeoutMs = 0 }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const grouped = process.platform !== 'win32'
    const child = spawn(process.execPath, args, {
      env,
      detached: grouped,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let tail = ''
    let killTimer
    let timedOut = false
    const kill = (kind) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, kind)
        else child.kill(kind)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    const stop = () => {
      // The fixture owns its browser and X11 children in this process group.
      child.kill('SIGTERM')
      killTimer = setTimeout(() => kill('SIGKILL'), 15_000)
      killTimer.unref?.()
    }
    const timeout = timeoutMs
      ? setTimeout(() => {
          timedOut = true
          stop()
        }, timeoutMs)
      : null
    signal?.addEventListener('abort', stop, { once: true })
    const output = (data) => {
      const text = String(data)
      tail = (tail + text).slice(-4000)
      onOutput(text)
    }
    child.stdout.on('data', output)
    child.stderr.on('data', output)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(killTimer)
      clearTimeout(timeout)
      signal?.removeEventListener('abort', stop)
      if (grouped) kill('SIGKILL')
      if (signal?.aborted) return reject(problem('browser_runtime_stopped', '账号浏览器安装已停止'))
      if (timedOut) return reject(problem('browser_fixture_timeout', '浏览器本地启动验证超时', 502))
      if (code === 0) return resolve()
      const detail = safeAccountBrowserError(new Error(tail.trim().split('\n').slice(-3).join(' '))).message
      reject(problem('browser_install_failed', detail || '账号浏览器安装进程未正常完成', 502))
    })
  })
}

async function defaultUpdate({ cacheDir, licenseKey, signal, onOutput }) {
  await runChild([CLOAK_CLI, 'update'], { env: childEnvironment(cacheDir, licenseKey), signal, onOutput })
}

async function defaultFixture({ cacheDir, licenseKey, binaryPath, signal }) {
  const env = childEnvironment(cacheDir, licenseKey)
  env.CLOAKBROWSER_BINARY_PATH = binaryPath
  await runChild([RUNTIME_FILE, '--fixture'], { env, signal, timeoutMs: 60_000 })
}

/** One server-wide browser installation; account sessions keep their own profiles. */
export class AccountBrowserRuntime {
  constructor({
    dataDir,
    settingsRepo,
    getBusy = () => false,
    getActiveVersion = () => null,
    onIdle = () => {},
    fetch: fetchImpl = globalThis.fetch,
    runUpdate = defaultUpdate,
    runFixture = defaultFixture,
    now = Date.now,
    launcherVersion = LAUNCHER_VERSION,
  } = {}) {
    this.cacheDir = path.join(path.resolve(dataDir), 'browser-runtime', 'cloakbrowser')
    Object.assign(this, {
      settingsRepo,
      getBusy,
      getActiveVersion,
      onIdle,
      fetchImpl,
      runUpdate,
      runFixture,
      now,
      launcherVersion,
    })
    this.state = {
      latest_version: null,
      checked_at: null,
      installing: false,
      phase: 'idle',
      progress: null,
      last_error: null,
    }
    this.task = null
    this.controller = null
    this.stopped = false
  }

  get isInstalling() {
    return this.state.installing
  }

  restoreSelector(previous) {
    const platform = localBinaryInfo(this.cacheDir).platform
    const marker = path.join(this.cacheDir, `latest_pro_version_${platform}`)
    if (previous === null) fs.rmSync(marker, { force: true })
    else {
      if (typeof previous !== 'string' || !VERSION.test(previous.trim()))
        throw new Error('Invalid previous browser version')
      fs.writeFileSync(`${marker}.tmp`, previous)
      fs.renameSync(`${marker}.tmp`, marker)
    }
  }

  repo() {
    return typeof this.settingsRepo === 'function' ? this.settingsRepo() : this.settingsRepo
  }

  key() {
    const value = this.repo().get(ACCOUNT_BROWSER_KEY_SETTING)
    if (!value) return null
    if (!isEncrypted(value) || !encryptionEnabled()) {
      throw problem('browser_key_unavailable', '浏览器密钥无法解密，请检查数据库加密配置', 503)
    }
    try {
      return decryptString(value)
    } catch {
      throw problem('browser_key_unavailable', '浏览器密钥无法解密，请检查数据库加密配置', 503)
    }
  }

  status() {
    const installed = localBinaryInfo(this.cacheDir)
    return {
      launcher_version: this.launcherVersion,
      installed_version: installed.installed ? installed.version : null,
      running_version: this.getActiveVersion() || null,
      ...this.state,
      key_set: Boolean(this.repo().get(ACCOUNT_BROWSER_KEY_SETTING)),
      browser_busy: Boolean(this.getBusy()),
    }
  }

  setKey(value) {
    this.assertIdle()
    if (value !== null && typeof value !== 'string') throw problem('browser_key_invalid', '请输入有效的浏览器密钥', 400)
    const key = value?.trim() || null
    if (key) {
      if (!/^cb_[A-Za-z0-9_-]+$/.test(key) || key.length > 512)
        throw problem('browser_key_invalid', '浏览器密钥应以 cb_ 开头', 400)
      if (!encryptionEnabled())
        throw problem('browser_key_encryption_required', '请先配置数据库加密，再保存浏览器密钥', 503)
      this.repo().set(ACCOUNT_BROWSER_KEY_SETTING, encryptString(key))
    } else {
      this.repo().remove(ACCOUNT_BROWSER_KEY_SETTING)
    }
    this.state.last_error = null
    return this.status()
  }

  assertIdle() {
    if (this.stopped) throw problem('browser_runtime_stopped', '账号浏览器服务正在关闭', 503)
    if (this.isInstalling) throw problem('browser_installing', '账号浏览器正在安装更新')
    if (this.getBusy()) throw problem('browser_busy', '请先关闭当前浏览器，再修改密钥或安装更新')
  }

  async latest(signal) {
    const platform = localBinaryInfo(this.cacheDir).platform
    const response = await this.fetchImpl('https://cloakbrowser.dev/api/download/version', {
      headers: { 'X-Platform': platform },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw problem('browser_update_check_failed', `浏览器版本检查失败（HTTP ${response.status}）`, 502)
    const data = await response.json()
    if (!VERSION.test(data?.version || ''))
      throw problem('browser_update_check_failed', '浏览器版本服务返回了无效版本', 502)
    this.state.latest_version = data.version
    this.state.checked_at = new Date(this.now()).toISOString()
    return data.version
  }

  async check() {
    if (this.stopped || this.isInstalling) throw problem('browser_installing', '账号浏览器正在安装更新')
    this.state.phase = 'checking'
    this.state.last_error = null
    try {
      await this.latest()
      if (this.state.phase === 'checking') this.state.phase = 'idle'
    } catch (error) {
      if (this.state.phase === 'checking') {
        this.state.phase = 'failed'
        this.state.last_error = safeAccountBrowserError(error)
      }
      throw error
    }
    return this.status()
  }

  install() {
    // Reserve before the first await so a simultaneous login cannot take the
    // free plan's only browser session while its installation is being tested.
    this.assertIdle()
    const licenseKey = this.key()
    if (!licenseKey) throw problem('browser_key_required', '请先保存 CloakBrowser 密钥', 400)
    this.state.installing = true
    this.state.phase = 'downloading'
    this.state.progress = null
    this.state.last_error = null
    this.controller = new AbortController()
    this.task = Promise.resolve().then(() => this.installLatest(licenseKey, this.controller.signal))
    this.task.catch(() => {})
    return this.status()
  }

  progress(text) {
    if (/Download progress:\s*(\d+)%/.test(text)) {
      this.state.progress = Math.min(100, Number(text.match(/Download progress:\s*(\d+)%/)[1]))
    }
    if (/signature|Checksum verified|SHA-256|SHA256SUMS/i.test(text)) this.state.phase = 'verifying'
    if (/Extracting to/i.test(text)) this.state.phase = 'extracting'
  }

  async installLatest(licenseKey, signal) {
    let markerPath
    let previousMarker = null
    let verified = false
    try {
      const before = localBinaryInfo(this.cacheDir)
      markerPath = path.join(this.cacheDir, `latest_pro_version_${before.platform}`)
      if (fs.existsSync(markerPath)) previousMarker = fs.readFileSync(markerPath, 'utf8')
      const target = await this.latest(signal)
      fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 })
      // These are query caches, not the active binary marker or account data.
      for (const name of [
        `.last_pro_version_check_${before.platform}`,
        `.last_pro_version_resolution_${before.platform}`,
      ]) {
        fs.rmSync(path.join(this.cacheDir, name), { force: true })
      }
      signal.throwIfAborted()
      await this.runUpdate({ cacheDir: this.cacheDir, licenseKey, signal, onOutput: (text) => this.progress(text) })
      signal.throwIfAborted()
      const installed = localBinaryInfo(this.cacheDir)
      if (!installed.installed || installed.version !== target) {
        throw problem('browser_version_mismatch', '浏览器安装版本与检查到的版本不一致，请重新检查更新', 502)
      }
      this.state.phase = 'testing'
      this.state.progress = null
      await this.runFixture({ cacheDir: this.cacheDir, licenseKey, binaryPath: installed.binaryPath, signal })
      signal.throwIfAborted()
      verified = true
      this.removeOldBinaries(installed.version)
      this.state.phase = 'ready'
      this.state.progress = 100
    } catch (error) {
      // Restore only the previous small selector; never copy or overwrite the
      // old installation, which the upstream updater leaves in its own dir.
      let failure = error
      try {
        if (markerPath && !verified) {
          this.restoreSelector(previousMarker)
        }
      } catch {
        failure = problem(
          'browser_selector_restore_failed',
          '浏览器安装失败，版本标记无法恢复，请检查持久目录是否可写',
          503,
        )
      }
      this.state.phase = 'failed'
      this.state.progress = null
      this.state.last_error = safeAccountBrowserError(failure)
    } finally {
      this.state.installing = false
      this.controller = null
      try {
        await this.onIdle()
      } catch {}
    }
  }

  removeOldBinaries(currentVersion) {
    for (const entry of fs.readdirSync(this.cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^chromium-\d+(?:\.\d+){3,4}-pro$/.test(entry.name)) continue
      if (entry.name === `chromium-${currentVersion}-pro`) continue
      fs.rmSync(path.join(this.cacheDir, entry.name), { recursive: true, force: true })
    }
  }

  launchConfig() {
    if (this.stopped) throw problem('browser_runtime_stopped', '账号浏览器服务正在关闭', 503)
    if (this.isInstalling) throw problem('browser_installing', '账号浏览器正在安装更新')
    if (this.state.last_error?.code === 'browser_selector_restore_failed') {
      throw problem('browser_selector_restore_failed', this.state.last_error.message, 503)
    }
    const licenseKey = this.key()
    if (!licenseKey) throw problem('browser_key_required', '请先在账号浏览器设置中保存 CloakBrowser 密钥', 400)
    if (!localBinaryInfo(this.cacheDir).installed)
      throw problem('browser_not_installed', '请先在账号浏览器设置中安装内核', 400)
    return { licenseKey, cacheDir: this.cacheDir }
  }

  async shutdown() {
    this.stopped = true
    this.controller?.abort(problem('browser_runtime_stopped', '账号浏览器安装已停止'))
    await this.task
  }
}

/** Runs only in the install child process: no account, proxy or external page. */
export async function runLocalBrowserFixture({ signal } = {}) {
  const cacheDir = process.env.CLOAKBROWSER_CACHE_DIR
  const profileDir = fs.mkdtempSync(path.join(cacheDir, 'fixture-'))
  let display
  let context
  const stop = () => {
    void context?.close().catch(() => {})
  }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    display = await createHeadedDisplay({ signal })
    signal?.throwIfAborted()
    context = await launchPersistentContext({
      userDataDir: profileDir,
      licenseKey: process.env.CLOAKBROWSER_LICENSE_KEY,
      headless: false,
      geoip: false,
      humanize: false,
      launchOptions: { timeout: 30_000, env: display.env },
    })
    signal?.throwIfAborted()
    await context.route('**/*', (route) => route.abort())
    const page = context.pages()[0] || (await context.newPage())
    await page.bringToFront()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.setContent(
      '<!doctype html><meta charset="utf-8"><label>Name <input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Check</button><output></output>',
    )
    await page.locator('#name').fill('vm2api fixture')
    await page.getByRole('button', { name: 'Check' }).click()
    if ((await page.locator('output').textContent()) !== 'vm2api fixture') throw new Error('浏览器本地输入验证失败')
    const screenshot = await page.screenshot({ type: 'png' })
    if (!screenshot.length) throw new Error('浏览器本地截图验证失败')
    const denial = licenseDenial(context)
    if (denial) throw denial
  } finally {
    signal?.removeEventListener('abort', stop)
    await context?.close()
    await display?.close()
    fs.rmSync(profileDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === RUNTIME_FILE && process.argv[2] === '--fixture') {
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('浏览器本地验证已停止'))
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const timer = setTimeout(stop, 45_000)
  try {
    await runLocalBrowserFixture({ signal: controller.signal })
  } catch (error) {
    console.error(safeAccountBrowserError(error).message)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
  if (process.exitCode) process.exit(process.exitCode)
}
