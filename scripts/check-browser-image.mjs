import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { binaryInfo } from 'cloakbrowser'

// Called in the public image, before any deployment data volume is mounted.
const info = binaryInfo(undefined, 'stable')
assert.equal(info.installed, false, 'the public image must not bundle a CloakBrowser binary')
assert.equal(process.env.CLOAKBROWSER_LICENSE_KEY, undefined, 'a license key must not enter the image')
for (const directory of [
  info.cacheDir,
  '/root/.cloakbrowser',
  '/root/.cache/ms-playwright',
  '/root/.cache/camoufox',
  '/opt/vm2api/browser-cache',
  '/opt/vm2api/data/browser-runtime',
  path.resolve('node_modules/camoufox'),
].filter(Boolean)) {
  assert.equal(fs.existsSync(directory), false, `unexpected browser asset directory: ${directory}`)
}
for (const directory of ['/opt/vm2api/vms', '/opt/vm2api/data']) {
  if (fs.existsSync(directory)) assert.deepEqual(fs.readdirSync(directory), [], 'image must not contain user data')
}
console.log('Public image contains the browser launcher and system dependencies only')
