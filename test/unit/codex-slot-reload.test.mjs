import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { codexKernelHealth } from '../../src/lib/transport/codex-kernel-client.mjs'
import {
  ensureCodexKernel,
  codexKernelTracked,
  finishCodexRecycle,
  stopCodexKernel,
  stopCodexKernelAndWait,
  writeCodexKernelConfig,
} from '../../src/lib/transport/codex-kernel-supervisor.mjs'
import {
  ensureSlotInferenceRuntime,
  reloadSlotReady,
  restoreCodexSlotReady,
  slotExec,
} from '../../src/lib/vm/slot-runtime.mjs'
import { renameVmId } from '../../src/lib/vm/vm-rename.mjs'
import { runtimePatch } from '../../src/lib/vm/vm-runtime.mjs'
import { codexKernelPaths } from '../../src/lib/transport/codex-kernel-client.mjs'
import { slotExecContainer } from '../../src/lib/vm/slot-exec.mjs'
import { slotNetworkForVm } from '../../src/lib/vm/egress.mjs'

async function fixture(t) {
  // Keep the Unix-socket path below macOS's length limit.
  const root = fs.mkdtempSync('/tmp/ck-reload-')
  const bin = path.join(root, 'kernel')
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs')
const http = require('node:http')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, pid: process.pid, proxy: config.proxy_url }))
})
server.listen(config.socket_path)
process.on('SIGTERM', () => {
  setTimeout(() => server.close(() => process.exit(0)), 100)
})
`,
    { mode: 0o755 },
  )
  const previousBin = process.env.KIN_CODEX_KERNEL_BIN
  process.env.KIN_CODEX_KERNEL_BIN = bin
  const slots = []
  t.after(async () => {
    for (const { exec } of slots) {
      const child = stopCodexKernel(exec.vmId)
      if (child) await finishCodexRecycle(child)
    }
    if (previousBin === undefined) delete process.env.KIN_CODEX_KERNEL_BIN
    else process.env.KIN_CODEX_KERNEL_BIN = previousBin
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    async slot(id) {
      const vm = { id, platform: 'openai', proxy: { url: 'socks5h://127.0.0.1:1080' }, runtime: { type: 'docker' } }
      const exec = { vmId: id, vm, homeDir: path.join(root, 'vms', id, 'cli-home') }
      slots.push({ exec })
      fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
      fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm))
      writeCodexKernelConfig(root, vm)
      assert.equal((await ensureCodexKernel(exec)).ok, true)
      return { vm, exec, health: await codexKernelHealth(exec) }
    },
  }
}

const reloadContainer = async (vm) => ({ ok: true, action: 'reloaded', runtime: vm.runtime })

function startupFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-startup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = {
    id: 'vm-startup',
    platform: 'openai',
    status: 'running',
    schedule_off: true,
    schedulable: false,
    proxy: { id: 'px-fixture', url: 'socks5h://127.0.0.1:1080' },
    runtime: { type: 'docker' },
  }
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const file = path.join(root, 'vms', `${vm.id}.json`)
  const save = () => fs.writeFileSync(file, JSON.stringify(vm))
  save()
  const calls = []
  const container = { running: true, role: 'codex', restarting: false, networkMode: slotNetworkForVm(vm) }
  const ops = {
    ensureProxyEgress: async () => ({ ok: true }),
    inspectContainer: () => container,
    writeCodexKernelConfig: () => calls.push('config'),
    ensureCodexKernel: async () => {
      calls.push('kernel')
      return { ok: true, reused: true }
    },
    reloadSlot: async () => {
      calls.push('reload')
      return { ok: true, runtime: vm.runtime }
    },
    stopCodexKernelAndWait: async () => {
      calls.push('stop')
      return { ok: true }
    },
  }
  return { root, vm, file, save, calls, container, ops }
}

test('startup recovery keeps a matching identity container and the operator-off switch', async (t) => {
  const f = startupFixture(t)
  const result = await restoreCodexSlotReady(f.vm, f.root, { ops: f.ops })
  assert.equal(result.ok, true)
  assert.equal(result.action, 'kernel-only')
  assert.equal(result.reused, true)
  assert.deepEqual(f.calls, ['config', 'kernel'])
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'))
  assert.equal(saved.schedule_off, true)
  assert.equal(saved.schedulable, false)
})

test('startup recovery falls back to full reload for absent, old-role, restarting or mismatched containers', async (t) => {
  const f = startupFixture(t)
  for (const container of [
    null,
    { ...f.container, role: 'claude' },
    { ...f.container, restarting: true },
    { ...f.container, networkMode: 'other-network' },
  ]) {
    f.calls.length = 0
    const result = await restoreCodexSlotReady(f.vm, f.root, {
      ops: { ...f.ops, inspectContainer: () => container },
    })
    assert.equal(result.ok, true)
    assert.equal(result.action, 'full-reload')
    assert.deepEqual(f.calls, ['reload', 'stop', 'config', 'kernel'])
  }
})

test('startup recovery rejects failed egress and rechecks stop or proxy changes after its await', async (t) => {
  const f = startupFixture(t)
  const failed = await restoreCodexSlotReady(f.vm, f.root, {
    ops: { ...f.ops, ensureProxyEgress: async () => ({ ok: false, error: 'exit unavailable' }) },
  })
  assert.equal(failed.code, 'egress_unavailable')
  assert.deepEqual(f.calls, [])
  const stopped = await restoreCodexSlotReady(f.vm, f.root, {
    ops: {
      ...f.ops,
      ensureProxyEgress: async () => {
        f.vm.status = 'stopped'
        f.save()
        return { ok: true }
      },
    },
  })
  assert.equal(stopped.skipped, true)
  assert.deepEqual(f.calls, [])
  f.vm.status = 'running'
  f.save()
  const changed = await restoreCodexSlotReady(f.vm, f.root, {
    ops: {
      ...f.ops,
      ensureProxyEgress: async () => {
        f.vm.proxy.id = 'px-other'
        f.save()
        return { ok: true }
      },
    },
  })
  assert.equal(changed.code, 'slot_intent_changed')
  assert.deepEqual(f.calls, [])
})

test('startup recovery does not start an inference kernel after a stop during full reload', async (t) => {
  const f = startupFixture(t)
  const result = await restoreCodexSlotReady(f.vm, f.root, {
    ops: {
      ...f.ops,
      inspectContainer: () => null,
      stopCodexKernelAndWait: async () => {
        f.vm.status = 'stopped'
        f.save()
        return { ok: true }
      },
    },
  })
  assert.equal(result.skipped, true)
  assert.deepEqual(f.calls, ['reload'])
})

test('startup recovery reuses a healthy kernel, restores a missing one and honors the final spawn check', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-startup-real')
  first.vm.status = 'running'
  fs.writeFileSync(path.join(f.root, 'vms', `${first.vm.id}.json`), JSON.stringify(first.vm))
  const ops = {
    ensureProxyEgress: async () => ({ ok: true }),
    inspectContainer: () => ({ running: true, role: 'codex', networkMode: slotNetworkForVm(first.vm) }),
    reloadSlot: async () => assert.fail('a matching identity container must not be reloaded'),
  }
  const reused = await restoreCodexSlotReady(first.vm, f.root, { ops })
  assert.equal(reused.ok, true)
  assert.equal(reused.reused, true)
  assert.equal((await codexKernelHealth(first.exec)).pid, first.health.pid)
  await stopCodexKernelAndWait(first.exec)
  const restored = await restoreCodexSlotReady(first.vm, f.root, { ops })
  assert.equal(restored.ok, true)
  assert.equal(restored.reused, false)
  assert.notEqual((await codexKernelHealth(first.exec)).pid, first.health.pid)
  await stopCodexKernelAndWait(first.exec)
  const skipped = await ensureCodexKernel(first.exec, {
    startupRecoveryCheck: () => ({ ok: true, skipped: true, reason: 'slot_intent_changed' }),
  })
  assert.equal(skipped.skipped, true)
  assert.equal(codexKernelTracked(first.vm.id), false)
})

test('GPT reload replaces the host kernel and adopts the new proxy without touching another slot', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-a')
  const peer = await f.slot('vm-b')
  first.vm.proxy.url = 'socks5h://127.0.0.1:2080'

  const result = await reloadSlotReady(first.vm, f.root, { ops: { reloadSlot: reloadContainer } })

  assert.equal(result.ok, true)
  const current = await codexKernelHealth(first.exec)
  assert.notEqual(current.pid, first.health.pid, 'a container reload must not reuse the old host kernel')
  assert.equal(current.proxy, first.vm.proxy.url, 'the process must read the new proxy at startup')
  assert.equal((await codexKernelHealth(peer.exec)).pid, peer.health.pid)
})

test('GPT reload with eager_start disabled stops the old kernel and leaves lazy startup enabled', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-lazy')

  const result = await reloadSlotReady(first.vm, f.root, {
    routing: { inference: { eager_start: false } },
    ops: { reloadSlot: reloadContainer },
  })

  assert.equal(result.ok, true)
  assert.equal((await codexKernelHealth(first.exec)).ok, false)
})

test('a failed container reload leaves its running Codex kernel alone', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-failed')

  const result = await reloadSlotReady(first.vm, f.root, {
    ops: { reloadSlot: async () => ({ ok: false, error: 'container unavailable' }) },
  })

  assert.equal(result.ok, false)
  assert.equal((await codexKernelHealth(first.exec)).pid, first.health.pid)
})

test('GPT reload reports failure when the replacement kernel cannot become ready', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-start-fail')

  const result = await reloadSlotReady(first.vm, f.root, {
    ops: {
      reloadSlot: reloadContainer,
      ensureCodexKernel: async () => ({ ok: false, reason: 'health_timeout' }),
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'health_timeout')
})

test('a concurrent ensure waits for the exiting kernel before starting its replacement', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-overlap')

  const stopping = stopCodexKernelAndWait(first.exec)
  const starting = ensureCodexKernel(first.exec)
  assert.equal((await stopping).ok, true)
  assert.equal((await starting).ok, true)
  assert.notEqual((await codexKernelHealth(first.exec)).pid, first.health.pid)
})

test('a stop timeout preserves the tracked process and its socket', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-timeout')

  const stopped = await stopCodexKernelAndWait(first.exec, { termMs: 0, killMs: 0 })

  assert.equal(stopped.ok, false)
  assert.equal(stopped.reason, 'recycle_timeout')
  assert.equal(codexKernelTracked(first.vm.id), true)
  assert.equal(fs.existsSync(path.join(f.root, 'vms', first.vm.id, 'run', 'codex-kernel.sock')), true)
})

test('an untracked listener is reported instead of unlinking its live socket', async (t) => {
  const f = await fixture(t)
  const vm = { id: 'vm-untracked', platform: 'openai', proxy: { url: 'socks5h://127.0.0.1:1080' } }
  const exec = { vmId: vm.id, vm, homeDir: path.join(f.root, 'vms', vm.id, 'cli-home') }
  const written = writeCodexKernelConfig(f.root, vm)
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true })))
  await new Promise((resolve) => server.listen(written.socketPath, resolve))
  try {
    const stopped = await stopCodexKernelAndWait(exec)
    assert.equal(stopped.ok, false)
    assert.equal(stopped.reason, 'untracked_kernel')
    assert.equal((await codexKernelHealth(exec)).ok, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('GPT reload reports a failed stop without starting another kernel', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-stop-fail')
  let starts = 0

  const result = await reloadSlotReady(first.vm, f.root, {
    ops: {
      reloadSlot: reloadContainer,
      stopCodexKernelAndWait: async () => ({ ok: false, reason: 'recycle_timeout' }),
      ensureCodexKernel: async () => {
        starts += 1
        return { ok: true }
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'codex_kernel_reload_failed')
  assert.equal(starts, 0)
  assert.equal((await codexKernelHealth(first.exec)).pid, first.health.pid)
})

test('a stopped Codex slot starts after rename using rebuilt paths and the same credentials and identity', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-before')
  assert.equal((await stopCodexKernelAndWait(first.exec)).ok, true)
  const oldRun = path.join(f.root, 'vms', first.vm.id, 'run')
  const vm = {
    ...first.vm,
    status: 'stopped',
    schedule_off: true,
    schedulable: false,
    schedule_manual: true,
    schedule_disabled_reason: 'operator',
    fingerprint: { guest_machine_id: 'same-machine', device_id: 'same-device' },
  }
  runtimePatch(
    vm,
    { name: 'kin-before', running: false, hostname: 'before' },
    {
      worker_run_dir: oldRun,
      worker_socket: path.join(oldRun, 'worker.sock'),
      worker_token_file: path.join(oldRun, 'internal.token'),
      kernel_socket: path.join(oldRun, 'kernel.sock'),
      codex_kernel_socket: path.join(oldRun, 'codex-kernel.sock'),
    },
  )
  vm.runtime.identity_collected_at = '2026-11-16T00:00:00Z'
  vm.runtime.guest_platform = 'linux'
  vm.runtime.guest_os_version = '24.04'
  vm.runtime.guest_arch = 'x64'
  const credentials = Buffer.from('{"accounts":[{"access_token":"mock-account-token","refresh_token":"mock-refresh"}]}')
  fs.writeFileSync(path.join(f.root, 'vms', vm.id, 'codex-credentials.json'), credentials)
  fs.writeFileSync(path.join(f.root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const installation = fs.readFileSync(path.join(oldRun, 'codex-installation-id'))
  const token = fs.readFileSync(path.join(oldRun, 'internal.token'))
  const renamed = renameVmId(f.root, vm.id, 'vm-after', { discardContainer: () => ({ ok: true }) })
  assert.equal(renamed.ok, true)
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'vms/vm-after.json')))
  const exec = slotExec(f.root, saved)
  const paths = codexKernelPaths(exec)
  assert.equal(paths.runDir, path.join(f.root, 'vms/vm-after/run'))
  assert.equal(paths.socketPath, path.join(paths.runDir, 'codex-kernel.sock'))
  assert.equal(paths.tokenPath, path.join(paths.runDir, 'internal.token'))
  assert.equal(paths.configPath, path.join(paths.runDir, 'codex-kernel.json'))
  assert.equal(paths.credentialPath, path.join(f.root, 'vms/vm-after/codex-credentials.json'))
  assert.equal(slotExecContainer(saved), 'kin-after')
  try {
    const started = await ensureSlotInferenceRuntime(saved, f.root)
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.equal((await codexKernelHealth(exec)).ok, true)
    const config = JSON.parse(fs.readFileSync(paths.configPath))
    assert.equal(config.vm_id, saved.id)
    assert.equal(config.socket_path, paths.socketPath)
    assert.equal(config.credential_path, paths.credentialPath)
    assert.equal(config.device_id, installation.toString().trim())
    assert.equal(config.internal_token, token.toString().trim())
    assert.deepEqual(fs.readFileSync(paths.credentialPath), credentials)
    assert.deepEqual(saved.proxy, vm.proxy)
    assert.deepEqual(saved.fingerprint, vm.fingerprint)
    for (const key of ['schedule_off', 'schedulable', 'schedule_manual', 'schedule_disabled_reason']) {
      assert.equal(saved[key], vm[key])
    }
    assert.equal(saved.runtime.stopped, true)
    assert.equal(saved.runtime.identity_collected_at, vm.runtime.identity_collected_at)
    assert.equal(config.telemetry_runtime.runtime_os, 'linux')
  } finally {
    assert.equal((await stopCodexKernelAndWait(exec)).ok, true)
  }
})
