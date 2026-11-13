import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AccountBrowserRuntime,
  SHARD_MANIFEST_URL,
  SHARD_SDK_VERSION,
  browserUpdateStatus,
  compareBrowserVersions,
  localShardInfo,
  safeAccountBrowserError,
  verifyShardInstall,
} from '../../src/lib/browser/account-browser-runtime.mjs'

const OLD = '156.0.8078.47'
const NEW = '157.0.8103.50'
function release(version = NEW, build = '1', components = {}) {
  return {
    version,
    build,
    minSdkVersion: '2.1.0',
    components: {
      browser: `browser-${version}-${build}`,
      fingerprints: 'profiles-1',
      widevine: 'widevine-1',
      ...components,
    },
  }
}
function remote(value) {
  return {
    chromium_version: value.version,
    engine_build: value.build,
    min_sdk_version: value.minSdkVersion,
    archives: {
      'ShardX-Linux.zip': value.components.browser,
      'ShardX-Fingerprints.zip': value.components.fingerprints,
      'ShardX-Widevine-Linux.zip': value.components.widevine,
    },
  }
}
function installedIdentity(value) {
  return { version: value.version, build: value.build, components: value.components }
}
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-runtime-'))
  const runtime = new AccountBrowserRuntime({
    dataDir: directory,
    fetch: async () => ({ ok: true, json: async () => remote(release()) }),
    verifyInstall: async ({ target }) => installedIdentity(target),
    ...options,
  })
  const binary = (value = release(), verified = true) => {
    const root = path.join(runtime.cacheDir, 'ShardX-Linux')
    fs.mkdirSync(root, { recursive: true })
    for (const name of ['chrome', 'icudtl.dat', 'resources.pak', 'libEGL.so', 'libGLESv2.so', 'libvk_swiftshader.so'])
      fs.writeFileSync(path.join(root, name), 'fixture file')
    fs.mkdirSync(path.join(root, 'WidevineCdm', '_platform_specific', 'linux_x64'), { recursive: true })
    fs.writeFileSync(path.join(root, 'WidevineCdm', 'manifest.json'), '{}')
    fs.writeFileSync(
      path.join(root, 'WidevineCdm', '_platform_specific', 'linux_x64', 'libwidevinecdm.so'),
      'fixture CDM',
    )
    fs.writeFileSync(path.join(root, 'shardx-build'), value.build)
    fs.mkdirSync(path.join(runtime.cacheDir, 'fingerprints'), { recursive: true })
    fs.writeFileSync(path.join(runtime.cacheDir, 'fingerprints', 'linux.json'), '{}')
    fs.writeFileSync(
      path.join(runtime.cacheDir, 'manifest.json'),
      JSON.stringify({
        installed_chromium_version: value.version,
        installed_engine_build: value.build,
        browser_etag: value.components.browser,
        fingerprints_etag: value.components.fingerprints,
        widevine_etag: value.components.widevine,
      }),
    )
    if (verified) {
      runtime.receipt = { verified: installedIdentity(value), pending: false, last_error: null }
      runtime.saveReceipt()
    }
    return root
  }
  t.after(async () => {
    await runtime.shutdown()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { runtime, binary, directory }
}

test('local status neither contacts upstream nor creates cache; no license API remains', (t) => {
  const { runtime } = fixture(t, { fetch: () => assert.fail('status must be local') })
  const state = runtime.status()
  assert.equal(state.update_status, 'not_installed')
  assert.equal(state.launcher_version, SHARD_SDK_VERSION)
  assert.equal('key_set' in state, false)
  assert.equal(runtime.setKey, undefined)
  assert.equal(fs.existsSync(runtime.cacheDir), false)
  assert.throws(() => runtime.launchConfig(), { code: 'browser_not_installed' })
})

test('fresh checking uses the public manifest and local installed build is visible', async (t) => {
  const calls = []
  const { runtime, binary } = fixture(t, {
    fetch: async (...args) => {
      calls.push(args)
      return { ok: true, json: async () => remote(release()) }
    },
    now: () => Date.UTC(2026, 10, 13),
  })
  binary(release(OLD))
  assert.equal(runtime.status().update_status, 'unchecked')
  assert.deepEqual(runtime.launchConfig(), { cacheDir: runtime.cacheDir })
  const status = await runtime.check()
  assert.equal(status.update_status, 'update_available')
  assert.equal(status.installed_build, '1')
  assert.equal(status.latest_build, '1')
  assert.equal(status.checked_at, '2026-11-13T00:00:00.000Z')
  assert.equal(calls[0][0], SHARD_MANIFEST_URL)
  assert.equal(calls[0][1].headers, undefined)
})

test('update decisions include builds and component identities without downgrading', () => {
  const current = { installed: true, ...release() }
  assert.equal(browserUpdateStatus(current, release()), 'current')
  assert.equal(browserUpdateStatus(current, release(NEW, '2')), 'update_available')
  assert.equal(browserUpdateStatus(current, release(NEW, '1', { browser: 'repacked' })), 'components_available')
  assert.equal(browserUpdateStatus(current, release(NEW, '1', { fingerprints: 'profiles-2' })), 'components_available')
  assert.equal(browserUpdateStatus(current, release(NEW, '1', { widevine: 'widevine-2' })), 'components_available')
  assert.equal(browserUpdateStatus(current, release(OLD, '99')), 'newer_installed')
  assert.equal(browserUpdateStatus({ ...current, build: '2' }, release()), 'newer_installed')
  assert.equal(browserUpdateStatus(current, { ...release(), minSdkVersion: '2.2.0' }), 'application_update_required')
  assert.equal(compareBrowserVersions('1.2', '1.2.0'), 0)
})

test('check failure invalidates cached comparison and a later check recovers', async (t) => {
  let failing = false
  const { runtime, binary } = fixture(t, {
    fetch: async () => {
      if (failing) throw new Error('manifest unavailable')
      return { ok: true, json: async () => remote(release()) }
    },
  })
  binary()
  await runtime.check()
  failing = true
  await assert.rejects(runtime.check(), { code: 'browser_update_check_failed' })
  assert.equal(runtime.status().update_status, 'check_failed')
  assert.equal(runtime.status().latest_version, null)
  assert.equal(runtime.status().checked_at, null)
  assert.doesNotThrow(() => runtime.launchConfig())
  failing = false
  await runtime.check()
  assert.equal(runtime.status().update_status, 'current')
  assert.equal(runtime.status().last_error, null)
})

test('same or older release skips installer and verification after fresh query', async (t) => {
  for (const offered of [release(), release(OLD), release(NEW, '0')]) {
    let fetched = 0,
      idle = 0
    const { runtime, binary } = fixture(t, {
      fetch: async () => {
        fetched++
        return { ok: true, json: async () => remote(offered) }
      },
      runUpdate: () => assert.fail('must not download'),
      verifyInstall: () => assert.fail('must not reverify'),
      onIdle: () => idle++,
    })
    binary()
    assert.equal(runtime.install().installing, true)
    assert.throws(() => runtime.install(), { code: 'browser_installing' })
    await runtime.task
    assert.equal(fetched, 1)
    assert.equal(idle, 1)
    assert.equal(runtime.status().phase, 'idle')
    assert.equal(runtime.status().installing, false)
  }
})

test('new release and components update run installer then file/version verification only', async (t) => {
  const offered = release(NEW, '2', { widevine: 'widevine-2' })
  const calls = []
  const setup = fixture(t, {
    fetch: async () => ({ ok: true, json: async () => remote(offered) }),
    runUpdate: async (options) => {
      calls.push('install')
      assert.equal(options.refreshWidevine, true)
      assert.equal(options.force, false)
      assert.equal(options.signal.aborted, false)
      options.onProgress({ phase: 'downloading', progress: 45 })
      assert.equal(setup.runtime.status().progress, 45)
      assert.throws(() => setup.runtime.launchConfig(), { code: 'browser_installing' })
      setup.binary(offered, false)
    },
    verifyInstall: async ({ target }) => {
      calls.push('verify-files')
      assert.equal(setup.runtime.status().phase, 'verifying')
      assert.equal(localShardInfo(setup.runtime.cacheDir).build, '2')
      return installedIdentity(target)
    },
  })
  setup.binary(release())
  setup.runtime.install()
  await setup.runtime.task
  assert.deepEqual(calls, ['install', 'verify-files'])
  assert.equal(setup.runtime.status().update_status, 'current')
  assert.equal(setup.runtime.status().phase, 'ready')
  assert.deepEqual(setup.runtime.launchConfig(), { cacheDir: setup.runtime.cacheDir })
  const reloaded = new AccountBrowserRuntime({ dataDir: setup.directory })
  assert.deepEqual(reloaded.launchConfig(), { cacheDir: setup.runtime.cacheDir })
})

test('component-only update does not force a browser download', async (t) => {
  const offered = release(NEW, '1', { fingerprints: 'profiles-2' })
  const setup = fixture(t, {
    fetch: async () => ({ ok: true, json: async () => remote(offered) }),
    runUpdate: async ({ force, refreshWidevine }) => {
      assert.equal(force, false)
      assert.equal(refreshWidevine, false)
      setup.binary(offered, false)
    },
  })
  setup.binary()
  setup.runtime.install()
  await setup.runtime.task
  assert.equal(setup.runtime.status().phase, 'ready')
})

test('minimum SDK mismatch refuses installer but leaves known installed browser usable', async (t) => {
  const { runtime, binary } = fixture(t, {
    fetch: async () => ({ ok: true, json: async () => remote({ ...release(), minSdkVersion: '2.2.0' }) }),
    runUpdate: () => assert.fail('incompatible SDK must not install'),
  })
  binary()
  runtime.install()
  await runtime.task
  assert.equal(runtime.status().update_status, 'application_update_required')
  assert.equal(runtime.status().last_error.code, 'browser_application_update_required')
  assert.doesNotThrow(() => runtime.launchConfig())
})

test('install failure releases reservation but requires manual retry even when old metadata remains', async (t) => {
  let idle = 0
  const { runtime, binary, directory } = fixture(t, {
    runUpdate: async () => {
      throw new Error('download unavailable')
    },
    onIdle: () => idle++,
  })
  binary(release(OLD))
  runtime.install()
  await runtime.task
  assert.equal(idle, 1)
  assert.equal(runtime.status().phase, 'failed')
  assert.equal(runtime.status().update_status, 'retry_required')
  assert.throws(() => runtime.launchConfig(), { code: 'browser_install_unverified' })
  const restarted = new AccountBrowserRuntime({ dataDir: directory })
  assert.equal(restarted.status().update_status, 'retry_required')
  assert.throws(() => restarted.launchConfig(), { code: 'browser_install_unverified' })
})

test('installer exit success without installing target fails verification', async (t) => {
  const { runtime, binary } = fixture(t, { runUpdate: async () => {}, verifyInstall: verifyShardInstall })
  binary(release(OLD))
  runtime.install()
  await runtime.task
  assert.equal(runtime.status().last_error.code, 'browser_version_mismatch')
  assert.equal(runtime.status().phase, 'failed')
  assert.throws(() => runtime.launchConfig(), { code: 'browser_install_unverified' })
})

test('failed verification blocks changed install and explicit same-version retry can repair it', async (t) => {
  let fail = true
  const forceFlags = []
  const setup = fixture(t, {
    runUpdate: async ({ force }) => {
      forceFlags.push(force)
      setup.binary(release(), false)
    },
    verifyInstall: async ({ target }) => {
      if (fail) throw Object.assign(new Error('missing file'), { code: 'browser_install_incomplete' })
      return installedIdentity(target)
    },
  })
  setup.binary(release(OLD))
  setup.runtime.install()
  await setup.runtime.task
  assert.throws(() => setup.runtime.launchConfig(), { code: 'browser_install_unverified' })
  await setup.runtime.check()
  assert.equal(setup.runtime.status().update_status, 'retry_required')
  fail = false
  setup.runtime.install()
  await setup.runtime.task
  assert.deepEqual(forceFlags, [false, true])
  assert.equal(setup.runtime.status().phase, 'ready')
  assert.doesNotThrow(() => setup.runtime.launchConfig())
})

test('interrupted installation stays visible after restart and same-version retry is available', (t) => {
  const { runtime, binary, directory } = fixture(t)
  binary(release(), false)
  runtime.receipt.pending = true
  runtime.saveReceipt()
  const restarted = new AccountBrowserRuntime({ dataDir: directory })
  assert.equal(restarted.status().last_error.code, 'browser_install_interrupted')
  assert.equal(restarted.status().update_status, 'retry_required')
  assert.throws(() => restarted.launchConfig(), { code: 'browser_install_unverified' })
})

test('interrupted upgrade cannot trust old metadata after the engine directory was swapped', (t) => {
  const { runtime, binary, directory } = fixture(t)
  const root = binary(release())
  runtime.receipt.pending = true
  runtime.saveReceipt()
  fs.writeFileSync(path.join(root, 'chrome'), 'replacement executable before manifest update')
  const restarted = new AccountBrowserRuntime({ dataDir: directory })
  assert.equal(restarted.status().installed_version, NEW)
  assert.equal(restarted.status().update_status, 'retry_required')
  assert.throws(() => restarted.launchConfig(), { code: 'browser_install_unverified' })
})

test('busy and checking states reject install; shutdown aborts its only install job', async (t) => {
  let busy = true,
    started = false
  const { runtime } = fixture(t, {
    getBusy: () => busy,
    runUpdate: async ({ signal }) => {
      started = true
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  assert.throws(() => runtime.install(), { code: 'browser_busy' })
  busy = false
  runtime.state.phase = 'checking'
  assert.throws(() => runtime.install(), { code: 'browser_checking' })
  runtime.state.phase = 'idle'
  runtime.install()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, true)
  await runtime.shutdown()
  assert.equal(runtime.isInstalling, false)
  assert.equal(runtime.status().phase, 'failed')
  assert.throws(() => runtime.launchConfig(), { code: 'browser_runtime_stopped' })
})

test('file verification executes only --version and rejects wrong binary and missing assets', async (t) => {
  const { runtime, binary } = fixture(t)
  const root = binary()
  const target = release()
  let calls = 0
  const execVersion = async (file, args) => {
    calls++
    assert.equal(file, path.join(root, 'chrome'))
    assert.deepEqual(args, ['--version'])
    return { stdout: `Google Chrome ${NEW}\n` }
  }
  assert.deepEqual(
    await verifyShardInstall({ cacheDir: runtime.cacheDir, target, execVersion }),
    installedIdentity(target),
  )
  assert.equal(calls, 1)
  await assert.rejects(
    verifyShardInstall({
      cacheDir: runtime.cacheDir,
      target,
      execVersion: async () => ({ stdout: `Chromium ${OLD}` }),
    }),
    { code: 'browser_version_mismatch' },
  )
  fs.rmSync(path.join(root, 'libvk_swiftshader.so'))
  await assert.rejects(verifyShardInstall({ cacheDir: runtime.cacheDir, target, execVersion }), {
    code: 'browser_install_incomplete',
  })
  assert.equal(calls, 1)
})

test('install query failure invalidates stale latest version before any mutation', async (t) => {
  let fail = false
  const { runtime, binary } = fixture(t, {
    fetch: async () => {
      if (fail) throw new Error('offline')
      return { ok: true, json: async () => remote(release()) }
    },
    runUpdate: () => assert.fail('must not install without fresh manifest'),
  })
  binary(release(OLD))
  await runtime.check()
  fail = true
  runtime.install()
  await runtime.task
  assert.equal(runtime.status().latest_version, null)
  assert.equal(runtime.status().update_status, 'check_failed')
  assert.equal(runtime.receipt.pending, false)
})

test('public errors redact credentials', () => {
  const failure = safeAccountBrowserError(
    new Error('cb_secret sk-private Bearer secret https://alice:password@example.test'),
  )
  assert.doesNotMatch(failure.message, /cb_secret|sk-private|Bearer secret|alice:password/)
})
