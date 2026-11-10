import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IMAGE_ASSETS, stagedAssets, verifyDraft, verifyReleaseAssets } from '../../scripts/release-assets.mjs'

test('release assets verify nine upstream pins and the exact image-built egress bytes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-assets-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const files = []
  for (const name of Object.keys(IMAGE_ASSETS)) {
    const bytes = Buffer.from(`image bytes for ${name}`)
    fs.writeFileSync(path.join(dir, name), bytes)
    if (name !== 'kin-egress')
      files.push({
        path: `bin/${name}`,
        asset: name,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      })
  }
  const manifest = { files }
  const expected = stagedAssets(manifest, dir)
  assert.equal(expected.length, 10)
  const release = { draft: true, tag_name: 'v1.4.6101', assets: expected.map((entry) => ({ ...entry })) }
  verifyReleaseAssets(release, 'v1.4.6101', expected)
  release.assets.find((entry) => entry.name === 'kin-egress').digest = `sha256:${'0'.repeat(64)}`
  assert.throws(() => verifyReleaseAssets(release, 'v1.4.6101', expected), /kin-egress: release checksum mismatch/)
  fs.writeFileSync(path.join(dir, 'cli-node'), 'wrong cli-node')
  assert.throws(() => stagedAssets(manifest, dir), /cli-node: pinned size mismatch/)
})

test('release uploads reject a public release and a different draft tag', () => {
  assert.throws(() => verifyDraft({ draft: false, tag_name: 'v1.4.6101' }, 'v1.4.6101'), /public release/)
  assert.throws(() => verifyDraft({ draft: true, tag_name: 'v1.4.6102' }, 'v1.4.6101'), /tag mismatch/)
})
