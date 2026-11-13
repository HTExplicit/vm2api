import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBrowserFixture } from './browser-fixture.mjs'
import { SlotBrowserManager } from '../src/lib/browser/slot-browser-manager.mjs'

// A real child exit must notify the production manager and release its queue.
// The scenario never manually closes the crashed slot to advance the next one.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm2api-browser-close-'))
const records = new Map()
const vms = new Map(['a', 'b'].map((id) => [id, { id, proxy: { url: 'http://127.0.0.1:1' } }]))
const manager = new SlotBrowserManager({
  cfg: { paths: { project: root } },
  getVm: (id) => vms.get(id),
  resolveProxy: (vm) => vm.proxy.url,
  resolveTimezone: () => 'America/New_York',
  profileRepo: {
    get: (id) => records.get(id),
    upsert(id, patch) {
      records.set(id, { ...records.get(id), ...patch })
      return records.get(id)
    },
    remove: (id) => records.delete(id),
  },
  createSession: (options) => createBrowserFixture({ profileDir: options.profileDir }),
})
let timer
try {
  const first = await manager.acquire('a', { interactive: true })
  await first.page.goto('data:text/html,<title>Local lifecycle fixture</title>')
  const waiting = manager.acquire('b', { interactive: true })
  assert.equal(manager.state('b').status, 'queued')
  const child = first.browser.browser.process()
  const stopped = once(child, 'exit')
  child.kill('SIGKILL')
  await stopped
  assert.equal(child.signalCode, 'SIGKILL')
  const second = await Promise.race([
    waiting,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('crashed slot did not release the browser queue')), 15_000)
    }),
  ])
  clearTimeout(timer)
  assert.equal(manager.state('a').active, false)
  assert.match(manager.state('a').warning, /异常退出/)
  assert.ok(await fs.stat(manager.profileDirectory('a')), 'a crash does not delete the native persistent profile')
  await second.page.goto('data:text/html,<title>Next session ready</title>')
  assert.equal(await second.page.title(), 'Next session ready')
  const next = second.browser.browser.process()
  await Promise.all([manager.close('b'), manager.close('b')])
  assert.equal(next.exitCode, 0, 'the subsequent browser exits normally')
  assert.equal(next.signalCode, null)
  console.log(
    JSON.stringify({
      offline: true,
      crashedProcessReleased: true,
      managerQueueAdvancedWithoutManualClose: true,
      profilePreserved: true,
      subsequentSessionClosed: true,
    }),
  )
} finally {
  clearTimeout(timer)
  await manager.stop()
  await fs.rm(root, { recursive: true, force: true })
}
