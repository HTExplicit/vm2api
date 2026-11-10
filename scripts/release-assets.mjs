#!/usr/bin/env node
/** Extract all 10 assets from one final image, then upload and verify its draft. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
export const IMAGE_ASSETS = Object.freeze({
  'kin-kernel': 'image-bin/kin-kernel',
  'kin-kernel-crag': 'image-crag/kin-kernel',
  'kin-codex-kernel': 'image-bin/kin-codex-kernel',
  'kin-worker': 'image-bin/kin-worker',
  'kin-egress': 'image-bin/kin-egress',
  'kin-slot-gate': 'image-bin/kin-slot-gate',
  'kin-oauth-auth': 'image-bin/kin-oauth-auth',
  'kin-computer': 'image-bin/kin-computer',
  'cli-node': 'image-wrap-cli/cli-node',
  'cc-node': 'image-wrap-cli/cc-node',
})

export function stagedAssets(manifest, dir) {
  const pinned = new Map(
    manifest.files
      .filter((file) => !file.path.startsWith('share/wrap-cli/glibc239/'))
      .map((file) => [file.asset, file]),
  )
  assert.deepEqual(
    [...pinned.keys()].sort(),
    Object.keys(IMAGE_ASSETS)
      .filter((name) => name !== 'kin-egress')
      .sort(),
    'the release contains nine pinned upstream assets and source-built kin-egress',
  )
  return Object.keys(IMAGE_ASSETS).map((name) => {
    const bytes = fs.readFileSync(path.join(dir, name))
    const size = bytes.length
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
    const pin = pinned.get(name)
    if (pin) {
      assert.equal(size, pin.size, `${name}: pinned size mismatch`)
      assert.equal(digest, `sha256:${pin.sha256}`, `${name}: pinned checksum mismatch`)
    }
    return { name, size, digest }
  })
}

export function verifyDraft(release, tag) {
  assert.equal(release.draft, true, 'refusing to replace assets of a public release')
  assert.equal(release.tag_name, tag, 'release tag mismatch')
}

export function verifyReleaseAssets(release, tag, expected) {
  verifyDraft(release, tag)
  assert.deepEqual(release.assets.map((asset) => asset.name).sort(), expected.map((asset) => asset.name).sort())
  for (const file of expected) {
    const asset = release.assets.find((item) => item.name === file.name)
    assert.equal(asset.size, file.size, `${file.name}: release size mismatch`)
    assert.equal(asset.digest, file.digest, `${file.name}: release checksum mismatch`)
  }
}

function main() {
  const { values: opts } = parseArgs({
    options: { image: { type: 'string' }, tag: { type: 'string' }, dest: { type: 'string', default: 'dist' } },
  })
  assert.match(opts.image || '', /@sha256:[a-f0-9]{64}$/, 'an exact image digest is required')
  assert.ok(opts.tag, '--tag is required')
  const capture = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim()
  const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
  const releaseApi = capture('gh', ['release', 'view', opts.tag, '--json', 'apiUrl', '--jq', '.apiUrl'])
  const readRelease = () => JSON.parse(capture('gh', ['api', releaseApi]))
  verifyDraft(readRelease(), opts.tag)

  fs.mkdirSync(opts.dest, { recursive: true })
  run('docker', ['pull', opts.image])
  const container = capture('docker', ['create', opts.image])
  try {
    for (const [name, source] of Object.entries(IMAGE_ASSETS)) {
      run('docker', ['cp', `${container}:/opt/vm2api/${source}`, path.join(opts.dest, name)])
    }
  } finally {
    run('docker', ['rm', container])
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'deploy/payload.json'), 'utf8'))
  const expected = stagedAssets(manifest, opts.dest)
  verifyDraft(readRelease(), opts.tag)
  run('gh', ['release', 'upload', opts.tag, '--clobber', ...expected.map((file) => path.join(opts.dest, file.name))])
  verifyReleaseAssets(readRelease(), opts.tag, expected)
  console.log(`All 10 draft assets match ${opts.image}; nine upstream pins verified`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
