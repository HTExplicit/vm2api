import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBrowserTempCleanup } from '../src/lib/browser/temp-cleanup.mjs'

// This isolated child owns only a dummy profile, never a browser or account.
// Linux /proc sees its real --user-data-dir argument; killing it models a missing
// Playwright parent cleanup handler without touching a production process.
if (process.platform !== 'linux') {
  console.log(JSON.stringify({ offline: true, skipped: 'Linux process ownership smoke runs in the image' }))
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-browser-cleanup-smoke-'))
  const profile = path.join(root, 'browser-profile')
  const artifact = path.join(root, 'playwright-artifacts-Zy98Xw')
  fs.mkdirSync(profile)
  fs.mkdirSync(artifact)
  fs.writeFileSync(path.join(profile, 'fixture'), 'isolated temporary state')
  fs.writeFileSync(path.join(artifact, 'fixture'), 'isolated temporary artifact')
  const child = spawn(
    process.execPath,
    ['-e', "process.send('ready');setInterval(()=>{},1000)", '--', '--user-data-dir', profile],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  )
  try {
    await once(child, 'message')
    const cleanup = createBrowserTempCleanup({ tmpDir: root, enabled: true })
    const retained = await cleanup.cleanup()
    assert.equal(retained.removed, 0)
    assert.ok(retained.skipped.length > 0)
    assert.ok(fs.existsSync(profile))
    assert.ok(fs.existsSync(artifact))
    const stopped = once(child, 'exit')
    child.kill('SIGKILL')
    await stopped
    const reclaimed = await cleanup.cleanup()
    assert.equal(reclaimed.removed, 1)
    assert.deepEqual(reclaimed.failed, [])
    assert.deepEqual(reclaimed.skipped, [])
    assert.equal(fs.existsSync(profile), true, 'persistent profiles never belong to temporary-artifact cleanup')
    assert.equal(fs.existsSync(artifact), false)
    console.log(
      JSON.stringify({
        offline: true,
        liveProfilePreserved: true,
        killedChildReclaimed: true,
        removed: reclaimed.removed,
        modelCalls: 0,
      }),
    )
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      const stopped = once(child, 'exit')
      child.kill('SIGKILL')
      await stopped
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}
