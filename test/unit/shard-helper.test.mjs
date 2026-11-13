import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SHARD_HELPER_PATH, prepareShardProfile, runShardHelper } from '../../src/lib/browser/shard-runtime-helper.mjs'

const exec = promisify(execFile)
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
const template = (platform, mobile = false) => ({
  name: 'linux-test',
  navigator: { platform, user_agent: 'Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36' },
  client_hints: { platform: platform.startsWith('Linux') ? 'Linux' : platform, mobile, architecture: 'x86' },
  screen: { width: 1920, height: 1080 },
  tls: { signature_algorithms: [1], keep: 'profile' },
  fonts: ['original font'],
  noise: { canvas: { enabled: true, seed: 0 }, audio: { enabled: true, seed: 0 } },
})

function fixture(t) {
  assert.ok(fs.existsSync(SHARD_HELPER_PATH), 'Build the helper with npm run build:browser-helper before tests')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-helper-'))
  const cacheDir = path.join(root, 'cache')
  const spec =
    process.platform === 'win32'
      ? ['ShardX-Windows', 'chrome.exe']
      : process.platform === 'darwin'
        ? ['ShardX-Mac-arm64', 'ShardX.app', 'Contents', 'MacOS', 'ShardX']
        : ['ShardX-Linux', 'chrome']
  const executable = path.join(cacheDir, ...spec)
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, 'fixture executable is never launched')
  fs.mkdirSync(path.join(cacheDir, 'fingerprints'))
  write(path.join(cacheDir, 'fingerprints', 'linux-test.json'), template('Linux x86_64'))
  write(path.join(cacheDir, 'fingerprints', 'windows-test.json'), template('Win32'))
  write(path.join(cacheDir, 'fingerprints', 'android-test.json'), template('Linux armv8l', true))
  const manifest = {
    installed_chromium_version: '157.0.8103.50',
    installed_engine_build: '1',
    installed_grease_brand: 'Not-A.Brand',
    installed_grease_version: '99',
    installed_tls: { signature_algorithms: [10, 20] },
    browser_etag: 'browser-1',
    fingerprints_etag: 'fingerprints-1',
    widevine_etag: 'widevine-1',
  }
  const manifestPath = path.join(cacheDir, 'manifest.json')
  write(manifestPath, manifest)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, cacheDir, executable, manifest, manifestPath, spec }
}

test('helper is bundled without automation dependencies and inspects without creating a cache', async (t) => {
  const { root } = fixture(t)
  const build = JSON.parse(fs.readFileSync(path.join(path.dirname(SHARD_HELPER_PATH), 'build-manifest.json')))
  assert.equal(build.noPlaywrightOrPatchright, true)
  assert.equal(
    build.inputs.some((name) => /playwright|patchright/i.test(name)),
    false,
  )
  assert.equal(digest(SHARD_HELPER_PATH), build.bundleSha256)
  const isolated = path.join(root, 'isolated')
  fs.mkdirSync(isolated)
  const binary = path.join(isolated, 'helper.cjs')
  fs.copyFileSync(SHARD_HELPER_PATH, binary)
  const absent = path.join(root, 'absent')
  const { stdout } = await exec(process.execPath, [binary, 'inspect', absent], {
    cwd: isolated,
    env: { ...process.env, NODE_PATH: '' },
  })
  assert.equal(JSON.parse(stdout.trim()).result.installed, false)
  assert.equal(fs.existsSync(absent), false)
})

test('local inspection reports installed component receipts and prefers the archive build stamp', async (t) => {
  const { cacheDir, spec } = fixture(t)
  fs.writeFileSync(path.join(cacheDir, spec[0], 'shardx-build'), '2\n')
  const installed = await runShardHelper('inspect', [cacheDir])
  assert.equal(installed.version, '157.0.8103.50')
  assert.equal(installed.build, '2')
  assert.deepEqual(installed.components, {
    browser: 'browser-1',
    fingerprints: 'fingerprints-1',
    widevine: 'widevine-1',
  })
  assert.equal(installed.fingerprintCount, 3)
})

test('first profiles select Linux desktop only and persist independent native seeds', async (t) => {
  const { root, cacheDir } = fixture(t)
  const first = await prepareShardProfile({ cacheDir, profileDir: path.join(root, 'a'), timezone: 'America/New_York' })
  const second = await prepareShardProfile({ cacheDir, profileDir: path.join(root, 'b'), timezone: 'America/New_York' })
  assert.equal(first.created, true)
  assert.equal(first.template, 'linux-test')
  assert.equal(second.template, 'linux-test')
  const a = JSON.parse(fs.readFileSync(first.fingerprintPath))
  const b = JSON.parse(fs.readFileSync(second.fingerprintPath))
  assert.equal(a.navigator.platform, 'Linux x86_64')
  assert.equal(a.client_hints.mobile, false)
  assert.equal(a.timezone, 'America/New_York')
  assert.deepEqual(a.navigator.languages, ['en-US', 'en'])
  assert.equal(a.navigator.language, 'en-US')
  assert.equal(a.client_hints.brand_full_version, '157.0.8103.50')
  assert.ok(a.noise.canvas.seed > 0)
  assert.notEqual(a.noise.canvas.seed, b.noise.canvas.seed)
  const before = digest(first.fingerprintPath)
  const reopened = await prepareShardProfile({ cacheDir, profileDir: first.profileDir, timezone: 'America/New_York' })
  assert.equal(reopened.created, false)
  assert.equal(digest(first.fingerprintPath), before)
})

test('existing profiles change installed version and timezone without reselecting devices or adopting new templates', async (t) => {
  const { root, cacheDir, manifest, manifestPath } = fixture(t)
  const first = await prepareShardProfile({ cacheDir, profileDir: path.join(root, 'a'), timezone: 'America/New_York' })
  const before = JSON.parse(fs.readFileSync(first.fingerprintPath))
  const identityBefore = fs.readFileSync(path.join(first.profileDir, 'shard-profile.json'), 'utf8')
  const changedTemplate = {
    ...template('Linux x86_64'),
    fonts: ['new template font'],
    webgl: { renderer: 'a new device' },
  }
  write(path.join(cacheDir, 'fingerprints', 'linux-test.json'), changedTemplate)
  write(manifestPath, {
    ...manifest,
    installed_chromium_version: '158.0.8200.1',
    installed_grease_version: '101',
    installed_tls: { signature_algorithms: [30] },
  })
  await prepareShardProfile({ cacheDir, profileDir: first.profileDir, timezone: 'Asia/Singapore' })
  const after = JSON.parse(fs.readFileSync(first.fingerprintPath))
  assert.equal(after.client_hints.brand_full_version, '158.0.8200.1')
  assert.equal(after.client_hints.grease_version, '101')
  assert.equal(after.timezone, 'Asia/Singapore')
  assert.deepEqual(after.tls.signature_algorithms, [30])
  assert.equal(after.tls.keep, 'profile')
  assert.deepEqual(after.noise, before.noise)
  assert.deepEqual(after.screen, before.screen)
  assert.deepEqual(after.fonts, before.fonts)
  assert.equal(after.webgl, before.webgl)
  assert.equal(after.navigator.hardware_concurrency, before.navigator.hardware_concurrency)
  assert.equal(after.navigator.device_memory, before.navigator.device_memory)
  assert.equal(after.client_hints.platform_version, before.client_hints.platform_version)
  assert.equal(fs.readFileSync(path.join(first.profileDir, 'shard-profile.json'), 'utf8'), identityBefore)
})

test('profile creation requires a valid timezone and never substitutes host timezone', async (t) => {
  const { root, cacheDir } = fixture(t)
  const profileDir = path.join(root, 'invalid')
  await assert.rejects(prepareShardProfile({ cacheDir, profileDir, timezone: 'Invalid/Zone' }), /Invalid time zone/)
  assert.equal(fs.existsSync(profileDir), false)
  const controller = new AbortController()
  controller.abort(new Error('cancelled fixture'))
  assert.throws(
    () => prepareShardProfile({ cacheDir, profileDir, timezone: 'Etc/UTC', signal: controller.signal }),
    /cancelled fixture/,
  )
})
