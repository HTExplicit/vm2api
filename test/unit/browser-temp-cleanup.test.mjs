import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBrowserTempCleanup, isBrowserExecutable } from '../../src/lib/browser/temp-cleanup.mjs'

const dead = () => ({ activeBrowser: false, references: [], unknown: false })

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-browser-cleanup-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const uid = fs.statSync(root).uid
  const cleanup = createBrowserTempCleanup({ tmpDir: root, uid, enabled: true, readProcesses: dead, ...options })
  const directory = (name, content = 'fixture') => {
    const file = path.join(root, name)
    fs.mkdirSync(file)
    fs.writeFileSync(path.join(file, 'sample'), content)
    return file
  }
  return { root, cleanup, directory }
}

test('only exact direct temporary directories are reclaimed, preserving unrelated files', async (t) => {
  const { cleanup, directory, root } = fixture(t)
  directory('playwright-artifacts-a1B2c3', '12345')
  directory('playwright_firefoxdev_profile-Z9y8x7', '678')
  const unknown = directory('playwright-artifacts-too-long')
  const shared = directory('camoufox')
  const plain = path.join(root, 'playwright-artifacts-123456')
  fs.writeFileSync(plain, 'not a directory')
  const report = await cleanup.cleanup()
  assert.equal(report.removed, 2)
  assert.equal(report.reclaimed_bytes, 8)
  assert.deepEqual(report.failed, [])
  assert.deepEqual(report.skipped, [{ name: path.basename(plain), reason: 'not_owned_directory' }])
  assert.ok(fs.existsSync(shared))
  assert.ok(fs.existsSync(unknown))
  assert.ok(fs.existsSync(plain))
})

test('a session tracks only directories created after its launch snapshot', async (t) => {
  const { cleanup, directory } = fixture(t)
  const older = directory('playwright-artifacts-123456')
  const before = cleanup.snapshot()
  const current = directory('playwright_firefoxdev_profile-abcdef')
  assert.deepEqual(cleanup.createdSince(before), [current])
  const report = await cleanup.cleanup({ paths: cleanup.createdSince(before) })
  assert.equal(report.removed, 1)
  assert.ok(fs.existsSync(older))
  assert.ok(!fs.existsSync(current))
  assert.equal((await cleanup.cleanup({ paths: [current] })).removed, 0)
})

test('other runtimes report candidates without deleting them', async (t) => {
  const { cleanup, directory } = fixture(t, { enabled: false })
  const file = directory('playwright-artifacts-123456')
  const report = await cleanup.cleanup()
  assert.equal(cleanup.enabled, false)
  assert.equal(report.removed, 0)
  assert.deepEqual(report.skipped, [{ name: path.basename(file), reason: 'reported_only' }])
  assert.match(report.warning, /仅报告/)
  assert.ok(fs.existsSync(file))
})

test('Firefox child executable remains identifiable without a parent profile argument or browser comm', () => {
  for (const executable of [
    '/opt/vm2api/browser-cache/camoufox/browsers/firefox',
    '/opt/paired/firefox-bin',
    '/opt/paired/camoufox',
    '/opt/paired/camoufox-bin',
  ]) {
    assert.equal(isBrowserExecutable(executable), true)
  }
  assert.equal(isBrowserExecutable('/usr/bin/node'), false)
  assert.equal(isBrowserExecutable(''), false)
})

test('live browser and profile references stop collection', async (t) => {
  const { root, directory } = fixture(t)
  const file = directory('playwright_firefoxdev_profile-123456')
  const cleanup = createBrowserTempCleanup({
    tmpDir: root,
    uid: fs.statSync(root).uid,
    enabled: true,
    readProcesses: () => ({ activeBrowser: true, references: [file], unknown: false }),
  })
  const report = await cleanup.cleanup()
  assert.equal(report.removed, 0)
  assert.deepEqual(report.skipped, [{ name: path.basename(file), reason: 'process_reference' }])
  assert.match(report.warning, /process_reference/)
  assert.ok(fs.existsSync(file))
  const artifacts = directory('playwright-artifacts-abcdef')
  const next = await cleanup.cleanup({ paths: [artifacts] })
  assert.equal(next.skipped[0].reason, 'active_browser')
})

test('an unreadable process inventory keeps candidate directories', async (t) => {
  const { cleanup, directory } = fixture(t, {
    readProcesses: () => {
      throw new Error('unavailable')
    },
  })
  const file = directory('playwright-artifacts-123456')
  const report = await cleanup.cleanup()
  assert.equal(report.removed, 0)
  assert.equal(report.skipped[0].reason, 'process_inventory_unavailable')
  assert.ok(fs.existsSync(file))
})

test('different owners are excluded from snapshots and cleanup', async (t) => {
  const { root, directory } = fixture(t)
  const file = directory('playwright-artifacts-123456')
  const cleanup = createBrowserTempCleanup({
    tmpDir: root,
    uid: fs.statSync(root).uid + 1,
    enabled: true,
    readProcesses: dead,
  })
  assert.equal(cleanup.snapshot().size, 0)
  const report = await cleanup.cleanup()
  assert.equal(report.skipped[0].reason, 'different_owner')
  assert.ok(fs.existsSync(file))
})

test('symbolic links and outside paths never get traversed or removed', async (t) => {
  const { cleanup, directory, root } = fixture(t)
  const target = directory('shared')
  const link = path.join(root, 'playwright-artifacts-123456')
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(cleanup.snapshot().size, 0)
  const report = await cleanup.cleanup({ paths: [link, target, path.join(root, '..', 'playwright-artifacts-abcdef')] })
  assert.deepEqual(
    report.skipped.map((row) => row.reason),
    ['not_owned_directory', 'outside_scope', 'outside_scope'],
  )
  assert.ok(fs.existsSync(path.join(target, 'sample')))
  assert.ok(fs.lstatSync(link).isSymbolicLink())
})

test('deletion failures return a safe code and a later cleanup can retry', async (t) => {
  let fail = true
  const { cleanup, directory } = fixture(t, {
    remove: async (file) => {
      if (fail) throw Object.assign(new Error('private diagnostic'), { code: 'EACCES' })
      await fs.promises.rm(file, { recursive: true })
    },
  })
  const file = directory('playwright-artifacts-123456')
  const first = await cleanup.cleanup({ paths: [file] })
  assert.deepEqual(first.failed, [{ name: path.basename(file), code: 'EACCES' }])
  assert.ok(!JSON.stringify(first).includes('private diagnostic'))
  assert.ok(fs.existsSync(file))
  fail = false
  const second = await cleanup.cleanup({ paths: [file] })
  assert.equal(second.removed, 1)
  assert.equal(second.warning, null)
  assert.ok(!fs.existsSync(file))
})
