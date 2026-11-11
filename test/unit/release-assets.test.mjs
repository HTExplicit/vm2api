import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  imageAssets,
  stagedAssets,
  writeProvenance,
  verifyDraft,
  verifyReleaseAssets,
} from '../../scripts/release-assets.mjs'

const pinned = JSON.parse(fs.readFileSync(new URL('../../deploy/payload.json', import.meta.url), 'utf8'))
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

test('the complete release derives twenty pinned assets and image-built egress from the image', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-assets-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const files = pinned.files.map((file) => {
    const bytes = Buffer.from(`image bytes for ${file.asset}`)
    fs.writeFileSync(path.join(dir, file.asset), bytes)
    return { ...file, size: bytes.length, sha256: sha256(bytes) }
  })
  fs.writeFileSync(path.join(dir, 'kin-egress'), 'fork-built egress')
  const manifest = { ...pinned, files }
  const mapping = imageAssets(manifest)
  assert.equal(mapping.size, 21)
  assert.deepEqual(mapping.get('kin-kernel').sources, ['image-bin/kin-kernel', 'image-wrap-cli/kin-kernel.bin'])
  assert.equal(mapping.get('crag-v2-amd64-manifest.json').sources[0], 'image-crag/kernels/v2/amd64/manifest.json')
  assert.equal(mapping.get('libc.so.6').sources[0], 'image-wrap-cli/glibc239/libc.so.6')
  assert.equal(mapping.has('cc-node'), false)
  const expected = stagedAssets(manifest, dir)
  assert.equal(expected.length, 21)
  const digestOf = (name) => expected.find((asset) => asset.name === name).digest.slice('sha256:'.length)
  const upstreamBuild = {
    cli_source_commit: 'upstream-cli',
    crag_native_source_commit: 'upstream-core',
    cli_upx_sha256: digestOf('cli-node'),
    crag_bootstrap_upx_sha256: digestOf('crag-v2-amd64-crag-v2'),
    crag_payload_ciphertext_sha256: digestOf('crag-v2-amd64-crag-v2.payload.enc'),
  }
  const image = `ghcr.io/htexplicit/vm2api@sha256:${'1'.repeat(64)}`
  expected.push(
    writeProvenance({
      manifest,
      dir,
      image,
      sourceCommit: 'fork-source',
      upstreamBuild,
      assets: [...expected],
    }),
  )
  assert.equal(expected.length, 22)
  const provenance = JSON.parse(fs.readFileSync(path.join(dir, 'build-provenance.json')))
  assert.equal(provenance.image, image)
  assert.equal(provenance.source_commit, 'fork-source')
  assert.equal(provenance.assets.length, 21)
  assert.deepEqual(provenance.upstream.build, upstreamBuild)
  assert.equal(provenance.source_built['kin-egress'].source_commit, 'fork-source')
  const release = { draft: true, tag_name: 'v1.4.6901', assets: expected.map((entry) => ({ ...entry })) }
  verifyReleaseAssets(release, 'v1.4.6901', expected)
  release.assets.find((entry) => entry.name === 'kin-egress').digest = `sha256:${'0'.repeat(64)}`
  assert.throws(() => verifyReleaseAssets(release, 'v1.4.6901', expected), /kin-egress: release checksum mismatch/)
  fs.writeFileSync(path.join(dir, 'cli-node'), 'wrong cli-node')
  assert.throws(() => stagedAssets(manifest, dir), /cli-node: pinned size mismatch/)
})

test('release uploads reject a public release and a different draft tag', () => {
  assert.throws(() => verifyDraft({ draft: false, tag_name: 'v1.4.6901' }, 'v1.4.6901'), /public release/)
  assert.throws(() => verifyDraft({ draft: true, tag_name: 'v1.4.6902' }, 'v1.4.6901'), /tag mismatch/)
})
