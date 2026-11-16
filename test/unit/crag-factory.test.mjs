import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedCragFactory } from '../../scripts/seed-crag.mjs'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'
import { verifyCragV2Tree } from '../../src/lib/vm/wrap-cli-runtime.mjs'

test('a newer image preserves an existing signed factory, selected cache and slot data', {
  skip: process.platform === 'win32' ? 'signed ELF verification requires Unix executable permissions' : false,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-factory-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const imageRoot = path.join(root, 'image')
  const destinationRoot = path.join(root, 'live')
  seedEncryptedPackage(imageRoot, { revision: 'one' })
  const imageCragRoot = path.join(imageRoot, 'share/crag')
  assert.deepEqual(seedCragFactory(destinationRoot, imageCragRoot), { ok: true, seeded: true })
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
  assert.deepEqual(seedCragFactory(destinationRoot, imageCragRoot), {
    ok: true,
    seeded: false,
    reason: 'factory_exists',
  })
  const factoryBefore = fs.readFileSync(path.join(factory, 'manifest.json'))
  seedEncryptedPackage(imageRoot, { revision: 'two', payloadKey: crypto.randomBytes(32) })
  assert.deepEqual(seedCragFactory(destinationRoot, imageCragRoot), {
    ok: true,
    seeded: false,
    reason: 'factory_exists',
  })
  assert.deepEqual(fs.readFileSync(path.join(factory, 'manifest.json')), factoryBefore)
  assert.equal(verifyCragV2Tree(factory).ok, true)
  assert.equal(fs.readFileSync(pointer, 'utf8'), pointerBytes)
  assert.equal(fs.readFileSync(path.join(slot, 'kin-kernel'), 'utf8'), 'original wrapper')
  assert.deepEqual(
    fs.readFileSync(path.join(factory, 'manifest.json')),
    fs.readFileSync(path.join(selected, 'manifest.json')),
  )
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(factory, 'manifest.json'))).payload.key_id,
    JSON.parse(fs.readFileSync(path.join(selected, 'manifest.json'))).payload.key_id,
  )
  const before = fs.readFileSync(path.join(factory, 'manifest.json'))
  const otherRoot = path.join(root, 'other')
  seedEncryptedPackage(otherRoot)
  assert.equal(seedCragFactory(destinationRoot, path.join(otherRoot, 'share/crag')).reason, 'factory_exists')
  assert.deepEqual(fs.readFileSync(path.join(factory, 'manifest.json')), before)
})
