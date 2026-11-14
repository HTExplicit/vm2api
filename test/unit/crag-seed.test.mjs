import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishCragFactory } from '../../scripts/publish-crag-factory.mjs'
import { cragV2Arch, verifyCragV2Tree } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const override = process.env.KIN_CRAG_V2_ROOT
before(() => {
  delete process.env.KIN_CRAG_V2_ROOT
})
after(() => {
  if (override == null) delete process.env.KIN_CRAG_V2_ROOT
  else process.env.KIN_CRAG_V2_ROOT = override
})

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-seed-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const image = path.join(base, 'image')
  const source = seedEncryptedPackage(image)
  const root = path.join(base, 'installation')
  const destination = path.join(root, 'share/crag/kernels/v2', cragV2Arch())
  return { root, source, destination }
}

function tree(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const file = path.join(dir, entry.name)
      return [entry.name, entry.isDirectory() ? tree(file) : fs.readFileSync(file)]
    })
}

test('empty installation receives the complete verified image package without a download selection or identity', {
  skip: cragV2Arch() !== 'amd64',
}, (t) => {
  const f = fixture(t)
  assert.deepEqual(publishCragFactory(f.root, f.source), { ok: true, changed: true })
  assert.equal(verifyCragV2Tree(f.destination).ok, true)
  assert.deepEqual(tree(f.destination), tree(f.source))
  assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), ['amd64'])
  assert.equal(fs.existsSync(path.join(f.root, 'vms')), false)
})

test('an unrelated image issuer cannot replace the existing factory or downloaded selection', {
  skip: cragV2Arch() !== 'amd64',
}, (t) => {
  const f = fixture(t)
  seedEncryptedPackage(f.root, { revision: 'existing' })
  const selection = 'packages/amd64-11111111-1111-1111-1111-111111111111'
  const selected = path.join(path.dirname(f.destination), selection)
  fs.mkdirSync(path.dirname(selected), { recursive: true })
  fs.cpSync(f.destination, selected, { recursive: true })
  const pointer = path.join(path.dirname(f.destination), 'current-amd64.json')
  const value = Buffer.from(JSON.stringify({ package: selection }))
  fs.writeFileSync(pointer, value)
  const before = tree(path.dirname(f.destination))
  assert.throws(() => publishCragFactory(f.root, f.source), /authority mismatch/)
  assert.deepEqual(tree(path.dirname(f.destination)), before)
})

test('tampered image package cannot publish a factory', { skip: cragV2Arch() !== 'amd64' }, (t) => {
  const f = fixture(t)
  fs.appendFileSync(path.join(f.source, 'crag-v2.payload.enc'), 'tampered')
  assert.throws(() => publishCragFactory(f.root, f.source), /crag_v2_hash_mismatch/)
  assert.equal(fs.existsSync(f.destination), false)
  assert.equal(fs.existsSync(f.root), false)
})

test('unsupported architecture and explicit package override leave the installation untouched', (t) => {
  const f = fixture(t)
  assert.equal(publishCragFactory(f.root, f.source, { arch: 'arm64' }).reason, 'unsupported_arch')
  assert.equal(fs.existsSync(f.root), false)
  process.env.KIN_CRAG_V2_ROOT = f.source
  try {
    assert.equal(publishCragFactory(f.root, f.source, { arch: 'amd64' }).reason, 'custom_package')
    assert.equal(fs.existsSync(f.root), false)
  } finally {
    delete process.env.KIN_CRAG_V2_ROOT
  }
})
