#!/usr/bin/env node
/** Extract the complete pinned payload and source-built egress from one final image. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
export function imageAssets(manifest) {
  const assets = new Map()
  for (const file of manifest.files) {
    const source = file.path
      .replace(/^bin\//, 'image-bin/')
      .replace(/^share\/wrap-cli\//, 'image-wrap-cli/')
      .replace(/^share\/crag\//, 'image-crag/')
    assert.notEqual(source, file.path, `${file.path}: unknown image payload location`)
    const existing = assets.get(file.asset)
    if (existing) {
      assert.equal(existing.file.size, file.size, `${file.asset}: conflicting pinned sizes`)
      assert.equal(existing.file.sha256, file.sha256, `${file.asset}: conflicting pinned checksums`)
      existing.sources.push(source)
    } else assets.set(file.asset, { file, sources: [source] })
  }
  assert.equal(assets.size, 20, 'the release contains twenty pinned upstream assets')
  assets.set('kin-egress', { sources: ['image-bin/kin-egress'] })
  return assets
}

function assetDigest(name, bytes) {
  return { name, size: bytes.length, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` }
}

export function stagedAssets(manifest, dir) {
  return [...imageAssets(manifest)].map(([name, { file }]) => {
    const result = assetDigest(name, fs.readFileSync(path.join(dir, name)))
    if (file) {
      assert.equal(result.size, file.size, `${name}: pinned size mismatch`)
      assert.equal(result.digest, `sha256:${file.sha256}`, `${name}: pinned checksum mismatch`)
    }
    return result
  })
}

export function writeProvenance({ manifest, dir, image, sourceCommit, upstreamBuild, assets }) {
  for (const [field, name] of [
    ['cli_upx_sha256', 'cli-node'],
    ['crag_bootstrap_upx_sha256', 'crag-v2-amd64-crag-v2'],
    ['crag_payload_ciphertext_sha256', 'crag-v2-amd64-crag-v2.payload.enc'],
  ]) {
    const asset = assets.find((item) => item.name === name)
    assert.equal(asset.digest, `sha256:${upstreamBuild[field]}`, `${name}: upstream provenance mismatch`)
  }
  const provenance = {
    source_commit: sourceCommit,
    image,
    upstream: { repository: manifest.repo, release: manifest.release, build: upstreamBuild },
    source_built: {
      'kin-egress': {
        repository: 'HTExplicit/vm2api',
        source_commit: sourceCommit,
        path: 'worker/cmd/kin-egress',
        toolchain_image: 'golang:1.25-bookworm',
        build_flags: ['-buildvcs=false', '-trimpath', '-ldflags=-s -w'],
      },
    },
    assets,
  }
  const bytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, 'build-provenance.json'), bytes)
  return assetDigest('build-provenance.json', bytes)
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
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'deploy/payload.json'), 'utf8'))
  run('docker', ['pull', opts.image])
  const container = capture('docker', ['create', opts.image])
  try {
    for (const [name, { sources }] of imageAssets(manifest)) {
      const target = path.join(opts.dest, name)
      for (const [index, source] of sources.entries()) {
        const copied = index === 0 ? target : `${target}.duplicate`
        run('docker', ['cp', `${container}:/opt/vm2api/${source}`, copied])
        if (index > 0) {
          assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(target), `${name}: image copies differ`)
          fs.rmSync(copied)
        }
      }
    }
  } finally {
    run('docker', ['rm', container])
  }
  const expected = stagedAssets(manifest, opts.dest)
  expected.push(
    writeProvenance({
      manifest,
      dir: opts.dest,
      image: opts.image,
      sourceCommit: capture('git', ['rev-parse', 'HEAD']),
      upstreamBuild: JSON.parse(fs.readFileSync(path.join(root, 'docs/releases/v1.4.067-binaries.json'), 'utf8')),
      assets: [...expected],
    }),
  )
  verifyDraft(readRelease(), opts.tag)
  run('gh', ['release', 'upload', opts.tag, '--clobber', ...expected.map((file) => path.join(opts.dest, file.name))])
  verifyReleaseAssets(readRelease(), opts.tag, expected)
  console.log(`All 22 draft assets verified for ${opts.image}; twenty upstream pins and image-built egress match`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
