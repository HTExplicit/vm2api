import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AccountBrowserRuntime,
  ACCOUNT_BROWSER_KEY_SETTING,
  safeAccountBrowserError,
} from '../../src/lib/browser/account-browser-runtime.mjs'

const OLD = '155.0.8059.39.1'
const NEW = '156.0.8078.47.1'
const PLATFORM =
  process.platform === 'win32'
    ? 'windows-x64'
    : `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-browser-runtime-'))
  const previous = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = 'unit-test-browser-key-encryption'
  const rows = new Map()
  const repo = {
    get: (key) => rows.get(key),
    set: (key, value) => rows.set(key, value),
    remove: (key) => rows.delete(key),
  }
  const runtime = new AccountBrowserRuntime({
    dataDir: directory,
    settingsRepo: () => repo,
    fetch: async () => ({ ok: true, json: async () => ({ version: NEW }) }),
    ...options,
  })
  const binary = (version, activate = true) => {
    const dir = path.join(runtime.cacheDir, `chromium-${version}-pro`)
    const file =
      process.platform === 'darwin'
        ? path.join(dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
        : path.join(dir, process.platform === 'win32' ? 'chrome.exe' : 'chrome')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'test fixture executable', { mode: 0o755 })
    if (activate) fs.writeFileSync(path.join(runtime.cacheDir, `latest_pro_version_${PLATFORM}`), version)
    return { dir, file }
  }
  t.after(async () => {
    await runtime.shutdown()
    if (previous === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = previous
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { runtime, rows, repo, binary }
}

test('key has one encrypted DB value, follows the repository getter and never appears in status', (t) => {
  const { runtime, rows, binary } = fixture(t)
  runtime.setKey('cb_example_secret')
  assert.match(rows.get(ACCOUNT_BROWSER_KEY_SETTING), /^enc:v1:/)
  assert.equal(rows.get(ACCOUNT_BROWSER_KEY_SETTING).includes('cb_example_secret'), false)
  assert.equal(JSON.stringify(runtime.status()).includes('cb_example_secret'), false)
  binary(OLD)
  assert.deepEqual(runtime.launchConfig(), { licenseKey: 'cb_example_secret', cacheDir: runtime.cacheDir })
  const replacement = new Map()
  runtime.settingsRepo = () => ({ get: (key) => replacement.get(key), remove: (key) => replacement.delete(key) })
  assert.equal(runtime.status().key_set, false)
  assert.throws(() => runtime.launchConfig(), { code: 'browser_key_required' })
  runtime.settingsRepo = () => ({ get: (key) => rows.get(key), remove: (key) => rows.delete(key) })
  runtime.setKey(null)
  assert.equal(rows.has(ACCOUNT_BROWSER_KEY_SETTING), false)
})

test('key save refuses unencrypted storage while deletion still works', (t) => {
  const { runtime, rows } = fixture(t)
  runtime.setKey('cb_secret')
  const kin = process.env.KIN_DB_SECRET
  delete process.env.VM2API_DB_SECRET
  delete process.env.KIN_DB_SECRET
  try {
    assert.throws(() => runtime.setKey('cb_other'), { code: 'browser_key_encryption_required' })
    runtime.setKey(null)
    assert.equal(rows.size, 0)
  } finally {
    process.env.VM2API_DB_SECRET = 'unit-test-browser-key-encryption'
    if (kin !== undefined) process.env.KIN_DB_SECRET = kin
  }
})

test('status is local and fresh update checking sends platform only', async (t) => {
  const calls = []
  const { runtime, binary } = fixture(t, {
    fetch: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, json: async () => ({ version: NEW }) }
    },
    now: () => Date.UTC(2026, 10, 13),
  })
  binary(OLD)
  assert.equal(runtime.status().installed_version, OLD)
  assert.equal(runtime.status().phase, 'idle')
  assert.equal(calls.length, 0)
  const state = await runtime.check()
  assert.equal(state.latest_version, NEW)
  assert.equal(state.checked_at, '2026-11-13T00:00:00.000Z')
  assert.deepEqual(Object.keys(calls[0].options.headers), ['X-Platform'])
  assert.equal(calls[0].options.headers['X-Platform'], PLATFORM)
  assert.equal(calls[0].url, 'https://cloakbrowser.dev/api/download/version')
})

test('installation reserves synchronously and only removes old binaries after fixture closes', async (t) => {
  let release
  let fixtureFinished = false
  let wakeups = 0
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const { runtime, binary } = fixture(t, {
    onIdle: () => {
      wakeups++
    },
    runUpdate: async ({ onOutput }) => {
      assert.equal(runtime.isInstalling, true)
      assert.equal(fs.existsSync(path.join(runtime.cacheDir, `.last_pro_version_check_${PLATFORM}`)), false)
      onOutput('[cloakbrowser] Download progress: 50% (100/200 MB)')
      assert.equal(runtime.status().progress, 50)
      binary(NEW)
    },
    runFixture: async () => {
      assert.equal(runtime.status().phase, 'testing')
      assert.equal(fs.existsSync(path.join(runtime.cacheDir, `chromium-${OLD}-pro`)), true)
      await pending
      fixtureFinished = true
    },
  })
  runtime.setKey('cb_test_key')
  const old = binary(OLD)
  const geo = path.join(runtime.cacheDir, 'geoip')
  fs.mkdirSync(geo)
  fs.writeFileSync(path.join(geo, 'GeoLite2-City.mmdb'), 'keep')
  fs.writeFileSync(path.join(runtime.cacheDir, `.last_pro_version_check_${PLATFORM}`), OLD)
  const state = runtime.install()
  assert.equal(state.installing, true)
  assert.throws(() => runtime.install(), { code: 'browser_installing' })
  assert.throws(() => runtime.launchConfig(), { code: 'browser_installing' })
  assert.throws(() => runtime.setKey(null), { code: 'browser_installing' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixtureFinished, false)
  assert.equal(fs.existsSync(old.dir), true)
  release()
  await runtime.task
  assert.equal(fixtureFinished, true)
  assert.equal(fs.existsSync(old.dir), false)
  assert.equal(fs.existsSync(geo), true)
  assert.equal(runtime.status().installed_version, NEW)
  assert.equal(runtime.status().phase, 'ready')
  assert.equal(runtime.status().installing, false)
  assert.equal(wakeups, 1)
})

test('failed local acceptance restores the selector and keeps both installations without copying', async (t) => {
  const { runtime, binary } = fixture(t, {
    runUpdate: async () => binary(NEW),
    runFixture: async () => {
      throw new Error('fixture failed for cb_test_secret')
    },
  })
  runtime.setKey('cb_test_secret')
  const old = binary(OLD)
  runtime.install()
  await runtime.task
  const state = runtime.status()
  assert.equal(state.installed_version, OLD)
  assert.equal(state.phase, 'failed')
  assert.equal(state.last_error.message, 'fixture failed for [license key]')
  assert.equal(fs.existsSync(old.dir), true)
  assert.equal(fs.existsSync(path.join(runtime.cacheDir, `chromium-${NEW}-pro`)), true)
  assert.equal(
    fs.readdirSync(runtime.cacheDir).some((name) => /backup|snapshot/.test(name)),
    false,
  )
})

test('a CLI success without the requested version is not accepted', async (t) => {
  let tested = false
  const { runtime, binary } = fixture(t, {
    runUpdate: async () => {},
    runFixture: async () => {
      tested = true
    },
  })
  runtime.setKey('cb_test_secret')
  binary(OLD)
  runtime.install()
  await runtime.task
  assert.equal(runtime.status().last_error.code, 'browser_version_mismatch')
  assert.equal(runtime.status().installed_version, OLD)
  assert.equal(tested, false)
})

test('selector restoration failure is recorded without rejecting the background task', async (t) => {
  const { runtime, binary } = fixture(t, {
    runUpdate: async () => binary(NEW),
    runFixture: async () => {
      throw new Error('fixture failed')
    },
  })
  runtime.setKey('cb_test_secret')
  binary(OLD)
  runtime.restoreSelector = () => {
    throw new Error('disk full')
  }
  runtime.install()
  await assert.doesNotReject(runtime.task)
  assert.equal(runtime.status().last_error.code, 'browser_selector_restore_failed')
  assert.equal(runtime.isInstalling, false)
  assert.throws(() => runtime.launchConfig(), { code: 'browser_selector_restore_failed' })
})

test('busy browsers prevent install before any work and shutdown aborts its own task', async (t) => {
  let busy = true
  let started = false
  const { runtime } = fixture(t, {
    getBusy: () => busy,
    runUpdate: async ({ signal }) => {
      started = true
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  assert.throws(() => runtime.install(), { code: 'browser_busy' })
  busy = false
  runtime.setKey('cb_test_secret')
  runtime.install()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, true)
  await runtime.shutdown()
  assert.equal(runtime.isInstalling, false)
  assert.equal(runtime.status().phase, 'failed')
  assert.throws(() => runtime.launchConfig(), { code: 'browser_runtime_stopped' })
})

test('public error formatter removes key and URL credentials', () => {
  const result = safeAccountBrowserError(
    new Error('cb_secret Bearer cb_other https://alice:password@example.test/path'),
  )
  assert.equal(result.message.includes('cb_secret'), false)
  assert.equal(result.message.includes('cb_other'), false)
  assert.equal(result.message.includes('password'), false)
})
