import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishCragFactory } from '../../scripts/publish-crag-factory.mjs'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'
import { verifyCragV2Tree } from '../../src/lib/vm/wrap-cli-runtime.mjs'

test('image factory publishes signed bytes without replacing selected caches or slot data', {
  skip: process.platform === 'win32' ? 'signed ELF verification requires Unix executable permissions' : false,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-factory-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const imageRoot = path.join(root, 'image')
  const destinationRoot = path.join(root, 'live')
  const source = seedEncryptedPackage(imageRoot, { revision: 'one' })
  assert.deepEqual(publishCragFactory(destinationRoot, source), { ok: true, changed: true })
  const factory = path.join(destinationRoot, 'share/crag/kernels/v2', process.arch === 'arm64' ? 'arm64' : 'amd64')
  const selected = path.join(
    destinationRoot,
    'share/crag/kernels/v2/packages/amd64-11111111-1111-1111-1111-111111111111',
  )
  fs.mkdirSync(path.dirname(selected), { recursive: true })
  fs.cpSync(factory, selected, { recursive: true })
  const pointer = path.join(destinationRoot, 'share/crag/kernels/v2/current-amd64.json')
  const pointerBytes = JSON.stringify({ package: 'packages/amd64-11111111-1111-1111-1111-111111111111' })
  fs.writeFileSync(pointer, pointerBytes)
  const slot = path.join(destinationRoot, 'vms/vm-a/cli-home/.kin')
  fs.mkdirSync(slot, { recursive: true })
  fs.writeFileSync(path.join(slot, 'kin-kernel'), 'original wrapper')
  assert.deepEqual(publishCragFactory(destinationRoot, source), { ok: true, changed: false })
  seedEncryptedPackage(imageRoot, { revision: 'two' })
  assert.deepEqual(publishCragFactory(destinationRoot, source), { ok: true, changed: true })
  assert.equal(verifyCragV2Tree(factory).ok, true)
  assert.equal(fs.readFileSync(pointer, 'utf8'), pointerBytes)
  assert.equal(fs.readFileSync(path.join(slot, 'kin-kernel'), 'utf8'), 'original wrapper')
  assert.notDeepEqual(
    fs.readFileSync(path.join(factory, 'manifest.json')),
    fs.readFileSync(path.join(selected, 'manifest.json')),
  )
  const before = fs.readFileSync(path.join(factory, 'manifest.json'))
  const other = seedEncryptedPackage(path.join(root, 'other'))
  assert.throws(() => publishCragFactory(destinationRoot, other), /authority mismatch/)
  assert.deepEqual(fs.readFileSync(path.join(factory, 'manifest.json')), before)
})
