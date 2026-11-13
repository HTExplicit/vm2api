import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'
import {
  imageAssets,
  stagedAssets,
  verifyCragArchive,
  writeProvenance,
  verifyDraft,
  verifyReleaseAssets,
} from '../../scripts/release-assets.mjs'

const pinned = JSON.parse(fs.readFileSync(new URL('../../deploy/payload.json', import.meta.url), 'utf8'))
const manifestAsset = pinned.files.find((file) => file.path === 'share/crag/kernels/v2/amd64/manifest.json').asset
const encryptedAsset = pinned.files.find((file) => file.path === 'share/crag/kernels/v2/amd64/crag-v2.payload.enc').asset
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

test('the complete release derives twenty-one pinned assets and image-built egress from the image', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-assets-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const files = pinned.files.map((file) => {
    const bytes = Buffer.from(
      file.asset === manifestAsset
        ? JSON.stringify({ payload: { plaintext_sha256: 'core-commitment' } })
        : `image bytes for ${file.asset}`,
    )
    fs.writeFileSync(path.join(dir, file.asset), bytes)
    return { ...file, size: bytes.length, sha256: sha256(bytes) }
  })
  fs.writeFileSync(path.join(dir, 'kin-egress'), 'fork-built egress')
  const manifest = { ...pinned, files }
  const mapping = imageAssets(manifest)
  assert.equal(mapping.size, 22)
  assert.deepEqual(mapping.get('kin-kernel').sources, ['image-bin/kin-kernel', 'image-wrap-cli/kin-kernel.bin'])
  assert.equal(mapping.get(manifestAsset).sources[0], 'image-crag/kernels/v2/amd64/manifest.json')
  assert.equal(mapping.get('libc.so.6').sources[0], 'image-wrap-cli/glibc239/libc.so.6')
  assert.deepEqual(mapping.get('crag-v2-licensed-amd64.tar.gz').sources, ['image-crag/crag-v2-licensed-amd64.tar.gz'])
  assert.equal(mapping.has('cc-node'), false)
  const expected = stagedAssets(manifest, dir)
  assert.equal(expected.length, 22)
  const digestOf = (name) => expected.find((asset) => asset.name === name).digest.slice('sha256:'.length)
  const upstreamBuild = {
    application_release: 'v1.4.072',
    assets: expected.map((asset) => ({ name: asset.name, size: asset.size, sha256: digestOf(asset.name) })),
  }
  const cragBuild = {
    application_release: 'v1.4.081',
    core_plaintext_sha256: 'core-commitment',
    assets: Object.fromEntries(
      expected.filter((asset) => asset.name.startsWith('crag-v2-')).map((asset) => [asset.name, digestOf(asset.name)]),
    ),
  }
  const image = `ghcr.io/htexplicit/vm2api@sha256:${'1'.repeat(64)}`
  expected.push(
    writeProvenance({
      manifest,
      dir,
      image,
      sourceCommit: 'fork-source',
      upstreamBuild,
      cragBuild,
      assets: [...expected],
    }),
  )
  assert.equal(expected.length, 23)
  const provenance = JSON.parse(fs.readFileSync(path.join(dir, 'build-provenance.json')))
  assert.equal(provenance.image, image)
  assert.equal(provenance.source_commit, 'fork-source')
  assert.equal(provenance.assets.length, 22)
  assert.equal(provenance.upstream.build.application_release, 'v1.4.072')
  assert.equal(
    provenance.upstream.build.assets.some((asset) => asset.name.startsWith('crag-v2-') || asset.name === 'kin-egress'),
    false,
  )
  assert.deepEqual(provenance.upstream.crag, cragBuild)
  assert.equal(provenance.source_built['kin-egress'].source_commit, 'fork-source')
  const release = { draft: true, tag_name: 'v1.4.6901', assets: expected.map((entry) => ({ ...entry })) }
  verifyReleaseAssets(release, 'v1.4.6901', expected)
  release.assets.find((entry) => entry.name === 'kin-egress').digest = `sha256:${'0'.repeat(64)}`
  assert.throws(() => verifyReleaseAssets(release, 'v1.4.6901', expected), /kin-egress: release checksum mismatch/)
  fs.writeFileSync(path.join(dir, 'cli-node'), 'wrong cli-node')
  assert.throws(() => stagedAssets(manifest, dir), /cli-node: pinned size mismatch/)
})

test('release CRAG archive verifies its signature and exactly matches the image factory', {
  skip: process.platform === 'win32' ? 'signed ELF verification requires Unix executable permissions' : false,
}, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-release-crag-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'crag-v2-licensed-amd64')
  fs.renameSync(seedEncryptedPackage(path.join(dir, 'source')), source)
  const signed = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
  for (const name of ['LICENSES.txt', 'claude-code-2.1.321/LICENSE.md', 'kernel.json.example']) {
    fs.writeFileSync(path.join(source, name), name)
    signed.sha256[name] = sha256(Buffer.from(name))
  }
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(signed))
  const archive = pinned.files.find((file) => file.asset === 'crag-v2-licensed-amd64.tar.gz')
  execFileSync('tar', ['-czf', path.join(dir, archive.asset), '-C', dir, 'crag-v2-licensed-amd64'])
  for (const file of pinned.files.filter((item) => item.path.startsWith('share/crag/kernels/v2/amd64/'))) {
    fs.copyFileSync(
      path.join(source, file.path.slice('share/crag/kernels/v2/amd64/'.length)),
      path.join(dir, file.asset),
    )
  }
  assert.equal(verifyCragArchive(pinned, dir).payload.plaintext_sha256, signed.payload.plaintext_sha256)
  fs.writeFileSync(path.join(dir, encryptedAsset), 'different factory bytes')
  assert.throws(() => verifyCragArchive(pinned, dir), /CRAG archive and image factory differ/)
})

test('release uploads reject a public release and a different draft tag', () => {
  assert.throws(() => verifyDraft({ draft: false, tag_name: 'v1.4.6901' }, 'v1.4.6901'), /public release/)
  assert.throws(() => verifyDraft({ draft: true, tag_name: 'v1.4.6902' }, 'v1.4.6901'), /tag mismatch/)
})
