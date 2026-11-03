import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { codexKernelTracked } from '../../src/lib/transport/codex-kernel-supervisor.mjs'
import { startSlotReady } from '../../src/lib/vm/slot-runtime.mjs'

test('explicit GPT startup reuses an existing healthy kernel with eager startup disabled', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-start-ready-'))
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\codex-start-ready-${process.pid}-${Date.now()}`
      : path.join(root, 'healthy.sock')
  const vm = {
    id: 'vm-codex-ready',
    platform: 'openai',
    proxy: { url: 'socks5h://127.0.0.1:1080' },
    runtime: { type: 'docker', codex_kernel_socket: socketPath },
  }
  let probes = 0
  const server = http.createServer((req, res) => {
    probes += 1
    assert.equal(req.url, '/internal/health')
    assert.ok(req.headers['x-kin-internal-token'])
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, vm_id: vm.id, worker_version: 'existing-kernel-fixture' }))
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  const previousBin = process.env.KIN_CODEX_KERNEL_BIN
  process.env.KIN_CODEX_KERNEL_BIN = process.execPath
  t.after(async () => {
    if (previousBin === undefined) delete process.env.KIN_CODEX_KERNEL_BIN
    else process.env.KIN_CODEX_KERNEL_BIN = previousBin
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const routing = Object.freeze({ inference: Object.freeze({ eager_start: false }) })
  let containerStarts = 0
  const opts = {
    routing,
    ensureKernel: true,
    ops: {
      startSlot: async () => {
        containerStarts += 1
        return { ok: true, action: 'already-running', runtime: vm.runtime }
      },
    },
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await startSlotReady(vm, root, opts)
    assert.equal(result.ok, true)
    assert.equal(result.kernel.kernel.reused, true)
    assert.equal(result.kernel.kernel.health.vm_id, vm.id)
    assert.equal(result.kernel.kernel.health.worker_version, 'existing-kernel-fixture')
  }
  assert.equal(containerStarts, 2)
  assert.equal(probes, 2)
  assert.equal(codexKernelTracked(vm.id), false, 'healthy listener reuse must not spawn a replacement')
  assert.equal(routing.inference.eager_start, false)
})
