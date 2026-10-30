import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { workerHealth } from '../../src/lib/transport/go-worker-client.mjs'
import { toPublicKernelHealth } from '../../src/lib/transport/rust-kernel-client.mjs'

process.env.KIN_CRS_MOCK = '0'

// No server or IPC handle here: pending health must keep the thread alive,
// while the completed request must let this file entry exit naturally.
if (process.argv.includes('--client-once')) {
  const controller = new AbortController()
  const cancel = process.argv.includes('--cancel')
  const pending = workerHealth(JSON.parse(process.env.HEALTH_FIXTURE_EXEC), {
    timeoutMs: 600,
    signal: controller.signal,
  })
  if (cancel) setTimeout(() => controller.abort(), 30)
  const result = await pending
  console.log(JSON.stringify(result))
  process.exitCode = (cancel ? result.code === 'ABORT_ERR' : result.status === 200 && result.ok === true) ? 0 : 1
} else {
  test('health I/O and deadlines run independently of the caller event loop', { timeout: 15000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-health-thread-'))
    const tokenPath = path.join(directory, 'synthetic.token')
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\vm2api-health-thread-${process.pid}-${Date.now()}`
        : path.join(directory, 'health.sock')
    const token = 'synthetic-local-health-token'
    fs.writeFileSync(tokenPath, `  ${token}\n`)
    const exec = { vm: { runtime: { worker_socket: socketPath, worker_token_file: tokenPath } } }
    const source = `
      import http from 'node:http';
      let mode = {};
      const server = http.createServer((req, res) => {
        const selected = { ...mode };
        setTimeout(() => {
          res.writeHead(selected.status ?? 200, { 'content-type': 'application/json' });
          res.end(selected.raw ?? JSON.stringify({
            ...(selected.body ?? { ok: true, version: 'local-fixture' }),
            fixture: { responded_at: Date.now(), path: req.url, method: req.method,
              headers: [req.headers['x-kin-internal-token'], req.headers['x-internal-token']] },
          }));
        }, selected.delayMs ?? 0);
      });
      process.on('message', (message) => {
        if (message.type === 'configure') {
          mode = message.mode;
          process.send({ type: 'configured' });
        } else if (message.type === 'stop') {
          server.close(() => process.exit(0));
          server.closeAllConnections();
        }
      });
      server.listen(process.argv[1], () => process.send({ type: 'ready' }));
    `
    const server = spawn(process.execPath, ['--input-type=module', '-e', source, socketPath], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    async function configure(mode) {
      const response = once(server, 'message')
      server.send({ type: 'configure', mode })
      assert.equal((await response)[0].type, 'configured')
    }
    function blockCaller(durationMs) {
      const end = performance.now() + durationMs
      while (performance.now() < end) {
        // Deliberately block only the main thread, beyond the health deadline.
      }
    }
    try {
      assert.equal((await once(server, 'message'))[0].type, 'ready')

      await t.test('cold thread finishes fast health during a 1000ms main-thread block', async () => {
        await configure({ delayMs: 15 })
        const pending = workerHealth(exec, { timeoutMs: 600 })
        blockCaller(1000)
        const unblocked = Date.now()
        const result = await pending
        assert.equal(result.status, 200)
        assert.equal(result.ok, true)
        assert.ok(result.fixture.responded_at < unblocked - 100)
        assert.equal(result.fixture.path, '/internal/health')
        assert.equal(result.fixture.method, 'GET')
        assert.deepEqual(result.fixture.headers, [token, token])
      })

      await t.test('a truly slow 1000ms kernel still exhausts the 600ms budget', async () => {
        await configure({ delayMs: 1000 })
        const pending = workerHealth(exec, { timeoutMs: 600 })
        blockCaller(800)
        const result = await pending
        assert.equal(result.status, 0)
        assert.equal(result.ok, false)
        assert.equal(result.code, 'worker_timeout')
        assert.match(result.error, /600ms/)
      })

      await t.test('bad JSON and failed internal authentication cannot pass public health', async () => {
        await configure({ raw: 'synthetic-invalid-json' })
        const invalid = await workerHealth(exec, { timeoutMs: 600 })
        assert.equal(invalid.status, 200)
        assert.equal(invalid.error.code, 'worker_invalid_json')
        const publicInvalid = toPublicKernelHealth(invalid, 'rust')
        assert.equal(publicInvalid.process_up, false)
        assert.equal(publicInvalid.reachable, false)
        assert.equal(publicInvalid.error_code, 'worker_invalid_json')

        await configure({ status: 401, body: { ok: false, error: { code: 'unauthorized' } } })
        const rejected = await workerHealth(exec, { timeoutMs: 600 })
        assert.equal(rejected.status, 401)
        assert.equal(rejected.ok, false)
        assert.equal(toPublicKernelHealth(rejected, 'rust').process_up, false)
      })

      await t.test('busy kernels retain live process health', async () => {
        await configure({ body: { ok: true, healthy: true, ready_slots: 0, cli_pid: 12 } })
        const result = toPublicKernelHealth(await workerHealth(exec, { timeoutMs: 600 }), 'rust')
        assert.equal(result.status, 200)
        assert.equal(result.process_up, true)
        assert.equal(result.healthy, true)
        assert.equal(result.reachable, false)
      })

      await t.test('pre-aborted and in-flight requests preserve cancellation', async () => {
        await configure({ delayMs: 1000 })
        const cancelled = new AbortController()
        cancelled.abort()
        const first = await workerHealth(exec, { timeoutMs: 600, signal: cancelled.signal })
        assert.equal(first.code, 'ABORT_ERR')
        const controller = new AbortController()
        const pending = workerHealth(exec, { timeoutMs: 600, signal: controller.signal })
        setTimeout(() => controller.abort(), 30)
        const second = await pending
        assert.equal(second.code, 'ABORT_ERR')
        assert.equal(second.status, 0)
      })

      await t.test('a CLI awaits health and exits after completion or cancellation', async () => {
        for (const cancel of [false, true]) {
          await configure({ delayMs: cancel ? 1000 : 150 })
          const cli = spawn(
            process.execPath,
            [fileURLToPath(import.meta.url), '--client-once', ...(cancel ? ['--cancel'] : [])],
            {
              env: { ...process.env, HEALTH_FIXTURE_EXEC: JSON.stringify(exec) },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          )
          let stdout = ''
          let stderr = ''
          cli.stdout.on('data', (chunk) => (stdout += chunk))
          cli.stderr.on('data', (chunk) => (stderr += chunk))
          const watchdog = setTimeout(() => cli.kill(), 5000)
          const [code, signal] = await once(cli, 'close')
          clearTimeout(watchdog)
          assert.equal(signal, null, 'idle health thread must not keep the CLI alive')
          assert.equal(code, 0, stderr)
          const result = JSON.parse(stdout)
          if (cancel) assert.equal(result.code, 'ABORT_ERR')
          else assert.equal(result.ok, true, 'pending health must settle before CLI exit')
        }
      })

      await t.test('mock health still works without a configured socket', async () => {
        process.env.KIN_CRS_MOCK = '1'
        try {
          const result = await workerHealth({ vmId: 'synthetic', vm: { claude: {} } })
          assert.equal(result.source, 'go-worker-mock')
          assert.equal(result.vm_id, 'synthetic')
        } finally {
          process.env.KIN_CRS_MOCK = '0'
        }
      })
    } finally {
      if (server.connected) {
        const stopped = once(server, 'exit')
        server.send({ type: 'stop' })
        await stopped
      }
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
}
