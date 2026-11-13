import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// Run against the public image before mounting any deployment or test data.
const forbidden = new Set([
  'playwright',
  'playwright-core',
  'patchright',
  'patchright-core',
  'cloakbrowser',
  'camoufox',
  '@proxyshard/shardx',
])
const packages = []
function inspectPackages(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const target = path.join(directory, entry.name)
    if (entry.name.startsWith('@')) {
      inspectPackages(target)
      continue
    }
    const manifest = path.join(target, 'package.json')
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      assert.equal(forbidden.has(pkg.name), false, `unexpected runtime package: ${pkg.name}`)
      packages.push(pkg.name)
    }
    const nested = path.join(target, 'node_modules')
    if (fs.existsSync(nested)) inspectPackages(nested)
  }
}
inspectPackages(path.resolve('node_modules'))
assert.ok(packages.includes('puppeteer-core'), 'the runtime must include Puppeteer Core')
const helper = path.resolve('generated/shardbrowser')
assert.ok(fs.statSync(path.join(helper, 'helper.cjs')).size > 0, 'independent installer helper is present')
const manifest = JSON.parse(fs.readFileSync(path.join(helper, 'build-manifest.json'), 'utf8'))
assert.equal(manifest.noPlaywrightOrPatchright, true, 'helper build must exclude Playwright and Patchright')
assert.equal(
  manifest.inputs.some((value) => /(?:playwright|patchright)/i.test(value)),
  false,
)
for (const name of ['CLOAKBROWSER_LICENSE_KEY', 'SHARDBROWSER_LICENSE_KEY']) {
  assert.equal(process.env[name], undefined, 'browser credentials must not enter the image')
}
for (const directory of [
  '/root/.cloakbrowser',
  '/root/.cache/ms-playwright',
  '/root/.cache/camoufox',
  '/root/.cache/puppeteer',
  '/root/.cache/shardx-sdk',
  '/opt/vm2api/browser-cache',
  '/opt/vm2api/data/browser-runtime',
  '/opt/vm2api/scripts/shard-helper/node_modules',
])
  assert.equal(fs.existsSync(directory), false, `unexpected browser asset directory: ${directory}`)
for (const directory of ['/opt/vm2api/vms', '/opt/vm2api/data']) {
  if (fs.existsSync(directory)) assert.deepEqual(fs.readdirSync(directory), [], 'image must not contain user data')
}
console.log(
  'Public image contains Puppeteer, the independent Shard helper and system libraries; no browser data or Playwright runtime',
)
