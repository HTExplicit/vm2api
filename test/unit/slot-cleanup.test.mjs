import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  cleanupVmFiles,
  findSlotResidue,
  slotFileBytes,
  slotResidueReferences,
} from '../../src/lib/vm/slot-cleanup.mjs'
import { DatabaseSync } from 'node:sqlite'
import { destroySlot } from '../../src/lib/vm/slot-runtime.mjs'
import {
  ensureCodexKernel,
  finishCodexRecycle,
  stopCodexKernel,
  writeCodexKernelConfig,
} from '../../src/lib/transport/codex-kernel-supervisor.mjs'
import { codexKernelHealth } from '../../src/lib/transport/codex-kernel-client.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-cleanup-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms)
  const file = (relative, text = 'owned') => {
    const dest = path.join(vms, relative)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, text)
    return dest
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, vms, file }
}

test('delete waits for the local Codex kernel before destroying its container', async () => {
  const vm = { id: 'vm-delete', family: 'codex', runtime_type: 'docker' }
  const calls = []
  const result = await destroySlot(vm, '/project', {
    ops: {
      stopCodexKernelAndWait: async (exec) => {
        calls.push(['stop', exec.vmId, exec.projectRoot])
        return { ok: true }
      },
      destroy: async () => {
        calls.push(['destroy'])
        return { ok: true }
      },
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [['stop', vm.id, '/project'], ['destroy']])
})

test('a kernel whose exit is not verified prevents destructive cleanup', async () => {
  let destroyed = false
  const result = await destroySlot({ id: 'vm-delete', family: 'codex' }, '/project', {
    ops: {
      stopCodexKernelAndWait: async () => ({ ok: false, reason: 'untracked_kernel' }),
      destroy: () => {
        destroyed = true
      },
    },
  })
  assert.equal(result.code, 'codex_kernel_stop_failed')
  assert.equal(destroyed, false)
})

test('slot file cleanup removes only the requested home, sidecar and completed reset stash', (t) => {
  const f = fixture(t)
  f.file('vm-a/codex-credentials.json', 'secret')
  f.file('vm-a/run/owned', 'runtime')
  f.file('vm-a-chat.json', 'chat')
  f.file('.vm-a-keep-Ab1234/credentials.json', 'old')
  f.file('vm-a.json', '{"id":"vm-a"}')
  f.file('vm-b/codex-credentials.json', 'other')
  f.file('slot-guest-bin/shared', 'binary')
  const expected = slotFileBytes(path.join(f.vms, 'vm-a')) + 4 + 3
  const result = cleanupVmFiles({ projectRoot: f.root, vmId: 'vm-a' })
  assert.equal(result.removed, 3)
  assert.equal(result.reclaimed_bytes, expected)
  assert.equal(fs.existsSync(path.join(f.vms, 'vm-a')), false)
  assert.equal(fs.existsSync(path.join(f.vms, 'vm-a.json')), true)
  assert.equal(fs.existsSync(path.join(f.vms, 'vm-b/codex-credentials.json')), true)
  assert.equal(fs.existsSync(path.join(f.vms, 'slot-guest-bin/shared')), true)
})

test('active reset and unsafe slot identifiers do not remove files', (t) => {
  const f = fixture(t)
  const owned = f.file('vm-a/codex-credentials.json')
  assert.throws(() => cleanupVmFiles({ projectRoot: f.root, vmId: 'vm-a', resetInProgress: true }), {
    code: 'slot_cleanup_busy',
  })
  assert.throws(() => cleanupVmFiles({ projectRoot: f.root, vmId: '../vm-a' }), { code: 'invalid_vm_id' })
  assert.equal(fs.existsSync(owned), true)
})

test('cleanup unlinks slot-local symlinks without touching shared targets', (t) => {
  const f = fixture(t)
  f.file('vm-a/codex-credentials.json')
  const shared = path.join(f.root, 'shared')
  fs.mkdirSync(shared)
  fs.writeFileSync(path.join(shared, 'keep'), 'shared')
  fs.symlinkSync(shared, path.join(f.vms, 'vm-a', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  cleanupVmFiles({ projectRoot: f.root, vmId: 'vm-a' })
  assert.equal(fs.readFileSync(path.join(shared, 'keep'), 'utf8'), 'shared')
})

test('audit excludes registry, DB and Docker owners and reports unverified process ownership', (t) => {
  const f = fixture(t)
  for (const id of ['vm-file', 'vm-db', 'vm-docker', 'vm-orphan', 'vm-unknown-process'])
    f.file(`${id}/codex-credentials.json`)
  f.file('shared/installed-model')
  const report = findSlotResidue({
    projectRoot: f.root,
    registeredIds: new Set(['vm-file', 'vm-db']),
    containerIds: ['vm-docker'],
    kernelProcesses: [
      { vmId: 'vm-orphan', pid: 41, owned: true },
      { vmId: 'vm-unknown-process', pid: 42, owned: false },
    ],
  })
  assert.deepEqual(
    report.candidates.map((row) => row.vmId),
    ['vm-orphan'],
  )
  assert.equal(report.candidates[0].processes[0].pid, 41)
  assert.ok(report.unresolved.some((row) => row.vmId === 'vm-unknown-process'))
  assert.ok(report.unresolved.some((row) => row.vmId === 'shared'))
  assert.equal(fs.existsSync(path.join(f.vms, 'vm-orphan')), true)
})

test('a sidecar cannot make an unrecognized directory eligible for deletion', (t) => {
  const f = fixture(t)
  f.file('custom/keep')
  f.file('custom-chat.json')
  const report = findSlotResidue({ projectRoot: f.root, registeredIds: [] })
  assert.deepEqual(report.candidates, [])
  assert.equal(report.unresolved[0].reason, 'missing_slot_identity')
})

test('read-only DB audit preserves DB-restorable slots and includes profile-only orphans', (t) => {
  const f = fixture(t)
  const file = path.join(f.root, 'audit.db')
  const seed = new DatabaseSync(file)
  seed.exec(`
    CREATE TABLE vms(id TEXT PRIMARY KEY);
    CREATE TABLE slot_browser_profiles(vm_id TEXT);
    CREATE TABLE openai_api_accounts(vm_id TEXT, operation_id TEXT);
    CREATE TABLE api_endpoint_keys(source_vm_id TEXT, api_key TEXT);
    INSERT INTO vms VALUES ('vm-db');
    INSERT INTO slot_browser_profiles VALUES ('vm-db'), ('vm-profile-only');
    INSERT INTO openai_api_accounts VALUES ('vm-api-only', 'original-operation');
    INSERT INTO api_endpoint_keys VALUES ('vm-api-only','private-secret');
  `)
  seed.close()
  const db = new DatabaseSync(file, { readOnly: true })
  const registered = new Set(
    db
      .prepare('SELECT id FROM vms')
      .all()
      .map((row) => row.id),
  )
  const references = slotResidueReferences(db, registered)
  assert.equal(references.has('vm-db'), false)
  assert.deepEqual(references.get('vm-profile-only'), { profiles: 1, accounts: 0, keys: 0 })
  assert.deepEqual(references.get('vm-api-only'), { profiles: 0, accounts: 1, keys: 1 })
  const report = findSlotResidue({ projectRoot: f.root, registeredIds: registered, referencedIds: references.keys() })
  assert.deepEqual(report.candidates.map((row) => row.vmId).sort(), ['vm-api-only', 'vm-profile-only'])
  assert.equal(
    report.candidates.every((row) => row.bytes === 0 && row.files.length === 0),
    true,
  )
  assert.equal(db.prepare('SELECT operation_id FROM openai_api_accounts').get().operation_id, 'original-operation')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM slot_browser_profiles').get().n, 2)
  db.close()
})

test('destroy waits for a real owned kernel exit before container/files cleanup', {
  skip: process.platform === 'win32',
}, async (t) => {
  const f = fixture(t)
  const bin = path.join(f.root, 'kernel')
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs')
const http = require('node:http')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const server = http.createServer((_req, res) => res.end(JSON.stringify({ok:true, pid:process.pid})))
server.listen(config.socket_path)
process.on('SIGTERM', () => setTimeout(() => server.close(() => process.exit(0)), 80))
`,
    { mode: 0o755 },
  )
  const previous = process.env.KIN_CODEX_KERNEL_BIN
  process.env.KIN_CODEX_KERNEL_BIN = bin
  const vm = { id: 'vm-real-delete', family: 'codex', proxy: { url: 'socks5h://127.0.0.1:1080' } }
  const exec = { vmId: vm.id, vm, homeDir: path.join(f.vms, vm.id, 'cli-home') }
  t.after(async () => {
    const child = stopCodexKernel(vm.id)
    if (child) await finishCodexRecycle(child)
    if (previous === undefined) delete process.env.KIN_CODEX_KERNEL_BIN
    else process.env.KIN_CODEX_KERNEL_BIN = previous
  })
  writeCodexKernelConfig(f.root, vm)
  assert.equal((await ensureCodexKernel(exec)).ok, true)
  assert.equal((await codexKernelHealth(exec)).ok, true)
  let destroyed = false
  const result = await destroySlot(vm, f.root, {
    ops: {
      destroy: async () => {
        assert.equal((await codexKernelHealth(exec, { timeoutMs: 100 })).ok, false)
        cleanupVmFiles({ projectRoot: f.root, vmId: vm.id })
        destroyed = true
        return { ok: true }
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(destroyed, true)
  assert.equal(fs.existsSync(path.join(f.vms, vm.id)), false)
})
