#!/usr/bin/env node
/**
 * Offline Codex admission benchmark. Imports the real handler from --root and
 * substitutes only the kernel/config boundary; no Docker, network or account.
 *
 * node scripts/benchmark-codex-admission.mjs --root . --slots 21 --pool limited --clients 50
 * Defaults: 21/60 slots x healthy/limited x 2/50 clients; five warm-up rounds
 * (20 requests each) and five measured rounds (100 requests each), 200 ms hop.
 * A fresh child per case avoids sharing scheduler/cache state across cases.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const self = fileURLToPath(import.meta.url)
const args = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`)
  args.set(
    key.slice(2),
    process.argv[i + 1]?.startsWith('--') || i + 1 === process.argv.length ? true : process.argv[++i],
  )
}
if (args.has('help')) {
  console.log(
    'Options: --root DIR --slots 21,60 --pool healthy,limited --clients 2,50 --requests 100 --warmup 5 --warmup-requests 20 --rounds 5 --hop-ms 200 --per-slot N --output FILE',
  )
  process.exit(0)
}
const integer = (key, fallback, min = 1) => {
  const value = Number(args.get(key) ?? fallback)
  assert.ok(Number.isSafeInteger(value) && value >= min, `--${key} must be an integer >= ${min}`)
  return value
}
const list = (key, fallback) =>
  String(args.get(key) ?? fallback)
    .split(',')
    .map((value) => value.trim())
const root = path.resolve(String(args.get('root') ?? fileURLToPath(new URL('../', import.meta.url))))
const config = {
  requests: integer('requests', 100),
  warmup_rounds: integer('warmup', 5, 0),
  warmup_requests: integer('warmup-requests', 20),
  measured_rounds: integer('rounds', 5),
  hop_ms: integer('hop-ms', 200),
  kernel_frames: 10,
  network_requests: 0,
}
const rounded = (value) => Math.round(value * 1000) / 1000
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

if (!args.has('child')) {
  const cases = []
  for (const slots of list('slots', '21,60').map(Number)) {
    assert.ok(Number.isSafeInteger(slots) && slots >= 2, 'slots must be integers >= 2')
    for (const pool of list('pool', 'healthy,limited')) {
      assert.ok(['healthy', 'limited'].includes(pool), 'pool must be healthy or limited')
      for (const clients of list('clients', '2,50').map(Number)) {
        assert.ok(Number.isSafeInteger(clients) && clients > 0, 'clients must be positive integers')
        const childArgs = [
          self,
          '--child',
          '--root',
          root,
          '--slots',
          String(slots),
          '--pool',
          pool,
          '--clients',
          String(clients),
        ]
        for (const key of ['requests', 'warmup', 'warmup-requests', 'rounds', 'hop-ms', 'per-slot']) {
          if (args.has(key)) childArgs.push(`--${key}`, String(args.get(key)))
        }
        const result = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, childArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (chunk) => {
            stdout += chunk
          })
          child.stderr.on('data', (chunk) => {
            stderr += chunk
          })
          child.on('error', reject)
          child.on('close', (code) => {
            if (code !== 0)
              return reject(new Error(`case ${slots}/${pool}/${clients} exited ${code}: ${stderr}\n${stdout}`))
            const line = stdout.split(/\r?\n/).find((value) => value.startsWith('BENCHMARK_CASE='))
            if (!line) return reject(new Error(`case result missing: ${stdout}\n${stderr}`))
            resolve(JSON.parse(line.slice('BENCHMARK_CASE='.length)))
          })
        })
        cases.push(result)
        console.error(
          `Codex ${slots}/${pool}/${clients}: CPU ${result.summary.cpu_ms_per_completed} ms/request, loop p99 ${result.summary.event_loop_p99_ms} ms, ${result.summary.throughput_rps} rps`,
        )
      }
    }
  }
  const report = {
    benchmark: 'codex-admission',
    schema_version: 1,
    root,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu_model: os.cpus()[0]?.model,
    cpu_count: os.cpus().length,
    config,
    cases,
    complete: true,
    production_writes: 0,
    real_model_calls: 0,
  }
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (args.has('output')) fs.writeFileSync(path.resolve(String(args.get('output'))), output)
  process.stdout.write(output)
} else {
  const slots = integer('slots', 21, 2)
  const pool = String(args.get('pool') ?? 'healthy')
  const clients = integer('clients', 50)
  const perSlot = integer('per-slot', slots === 21 ? 2 : 1)
  const tempRoot = fs.realpathSync(os.tmpdir())
  const fixture = fs.mkdtempSync(path.join(tempRoot, 'vm2api-codex-bench-'))
  const vmDir = path.join(fixture, 'vms')
  const slotIds = new Set()
  const restrictedIds = new Set()
  const reset = new Date(Date.now() + 3 * 3_600_000).toISOString()
  fs.mkdirSync(vmDir)
  for (let index = 0; index < slots; index++) {
    const id = `vm-bench-${String(index).padStart(3, '0')}`
    slotIds.add(id)
    const limited = pool === 'limited' && index % 3 === 0
    if (limited) restrictedIds.add(id)
    const extra = {
      codex_5h_used_percent: 10 + (index % 30),
      codex_5h_reset_at: reset,
      codex_5h_window_minutes: 300,
      codex_7d_used_percent: limited ? 100 : 20 + (index % 40),
      codex_7d_reset_at: reset,
      codex_7d_window_minutes: 10080,
      codex_usage_updated_at: new Date().toISOString(),
    }
    fs.mkdirSync(path.join(vmDir, id))
    fs.writeFileSync(
      path.join(vmDir, `${id}.json`),
      JSON.stringify({
        id,
        name: id,
        platform: 'openai',
        family: 'codex',
        schedulable: true,
        status: 'running',
        has_token: true,
        policy: { maxConcurrency: perSlot, concurrencyOverride: true },
        codex: { extra },
      }),
    )
    fs.writeFileSync(
      path.join(vmDir, id, 'codex-credentials.json'),
      JSON.stringify({
        accounts: [
          {
            id: `${id}-account`,
            access_token: 'offline-access',
            refresh_token: 'offline-refresh',
            chatgpt_account_id: id,
          },
        ],
      }),
    )
  }
  // Count only synthetic slot-file I/O, excluding module loading and the report.
  const names = ['readFileSync', 'statSync', 'readdirSync', 'existsSync', 'writeFileSync', 'renameSync']
  const counters = Object.fromEntries(names.map((name) => [name, 0]))
  const originalFs = new Map()
  for (const name of names) {
    const original = fs[name]
    originalFs.set(name, original)
    fs[name] = function counted(...values) {
      const file = values[0] instanceof URL ? fileURLToPath(values[0]) : String(values[0] ?? '')
      if (file === vmDir || file.startsWith(vmDir + path.sep)) counters[name]++
      return original.apply(this, values)
    }
  }
  syncBuiltinESMExports()
  const load = (relative) => import(pathToFileURL(path.join(root, relative)).href)
  const { handleCodexProtocol } = await load('src/lib/protocol/handle-codex.mjs')
  const { resetOpenAIAccountRuntime } = await load('src/lib/pool/openai-account-runtime.mjs')
  const { openDatabase, closeDatabase } = await load('src/lib/db/database.mjs')
  const routing = {
    pool: { fallback_wait_timeout_ms: 60_000 },
    codex: { quota: { limit_5h: 0.9, limit_7d: 1 } },
    failover: { total_retry_deadline_ms: 120_000 },
  }
  const frames = [
    { type: 'response.created', response: { id: 'resp_offline', status: 'in_progress' } },
    ...Array.from({ length: 8 }, (_, index) => ({ type: 'response.output_text.delta', delta: `offline-${index} ` })),
    {
      type: 'response.completed',
      response: {
        id: 'resp_offline',
        status: 'completed',
        model: 'gpt-5.5',
        output: [],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      },
    },
  ]
  let selectedIds = new Set()
  let admissionTimes = []
  const ops = {
    writeCodexKernelConfig() {},
    ensureCodexKernel: async () => ({ ok: true, reused: true }),
    codexKernelHealth: async () => ({ ok: true, healthy: true }),
    streamCodexKernel: async ({ onEvent, exec }) => {
      assert.ok(slotIds.has(exec.vmId), 'only a synthetic slot may reach the kernel')
      assert.ok(!restrictedIds.has(exec.vmId), 'quota-restricted slots must never be admitted')
      selectedIds.add(exec.vmId)
      for (const frame of frames) {
        await sleep(config.hop_ms / frames.length)
        await onEvent(`data: ${JSON.stringify(frame)}`)
        await onEvent('')
      }
      return {
        ok: true,
        status: 200,
        terminalState: 'verified',
        committed: true,
        usage: { input_tokens: 12, output_tokens: 8 },
        headers: {
          'x-codex-primary-used-percent': '12',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-after-seconds': '10800',
          'x-codex-secondary-used-percent': '20',
          'x-codex-secondary-window-minutes': '10080',
          'x-codex-secondary-reset-after-seconds': '10800',
        },
      }
    },
  }
  async function one(index) {
    const req = Object.assign(new EventEmitter(), {
      headers: { 'user-agent': 'codex_cli_rs/0.150.0' },
      apiKeyKind: 'master',
      socket: { remoteAddress: '127.0.0.1' },
    })
    const res = Object.assign(new EventEmitter(), {
      headersSent: false,
      statusCode: 0,
      write() {
        return true
      },
      end() {},
    })
    const logBag = {}
    let status = 0
    let admitted = false
    const start = performance.now()
    await handleCodexProtocol({
      req,
      res,
      protocol: 'openai.responses',
      ctx: { path: '/v1/responses', body: { model: 'gpt-5.5', input: `offline ${index}`, stream: true } },
      inbound: { stream: true },
      logBag,
      stats: { errors: 0, requests: 0, by_route: {} },
      json: (_res, code, body) => {
        status = code
        return body
      },
      writeSSEHeaders(response) {
        response.headersSent = true
        status = 200
      },
      routing,
      projectRoot: fixture,
      ops: {
        ...ops,
        ensureCodexKernel: async (...values) => {
          if (!admitted) {
            admitted = true
            admissionTimes.push(performance.now() - start)
          }
          return ops.ensureCodexKernel(...values)
        },
      },
    })
    return { status, error: logBag.error_code ?? null, ms: performance.now() - start }
  }
  async function run(count) {
    resetOpenAIAccountRuntime()
    admissionTimes = []
    selectedIds = new Set()
    let index = 0
    const values = []
    await Promise.all(
      Array.from({ length: Math.min(clients, count) }, async () => {
        while (index < count) values.push(await one(index++))
      }),
    )
    return values
  }
  async function measure(count) {
    for (const name of names) counters[name] = 0
    const loop = monitorEventLoopDelay({ resolution: 5 })
    loop.enable()
    await sleep(10)
    loop.reset()
    let peak = process.memoryUsage().rss
    const rssStart = peak
    const rssTimer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss)
    }, 5)
    const cpu = process.cpuUsage()
    const elu = performance.eventLoopUtilization()
    const start = performance.now()
    const values = await run(count)
    const wall = performance.now() - start
    const used = process.cpuUsage(cpu)
    const busy = performance.eventLoopUtilization(elu)
    clearInterval(rssTimer)
    peak = Math.max(peak, process.memoryUsage().rss)
    await sleep(10)
    loop.disable()
    const completed = values.filter((value) => value.status === 200 && !value.error).length
    const failures = values.filter((value) => value.status !== 200 || value.error)
    assert.equal(completed, count, `all requests succeed: ${JSON.stringify(failures.slice(0, 3))}`)
    const io = { ...counters }
    return {
      completed,
      failures: failures.length,
      wall_ms: rounded(wall),
      throughput_rps: rounded((completed * 1000) / wall),
      cpu_ms_per_completed: rounded((used.user + used.system) / 1000 / completed),
      cpu_user_ms: rounded(used.user / 1000),
      cpu_system_ms: rounded(used.system / 1000),
      event_loop_p99_ms: rounded(loop.percentile(99) / 1e6),
      event_loop_max_ms: rounded(loop.max / 1e6),
      event_loop_utilization: rounded(busy.utilization),
      request_p50_ms: rounded(
        percentile(
          values.map((value) => value.ms),
          0.5,
        ),
      ),
      request_p99_ms: rounded(
        percentile(
          values.map((value) => value.ms),
          0.99,
        ),
      ),
      admission_p99_ms: rounded(percentile(admissionTimes, 0.99)),
      selected_slots: selectedIds.size,
      rss_start_bytes: rssStart,
      rss_peak_bytes: peak,
      fs_counts: io,
      fs_per_completed: Object.fromEntries(names.map((name) => [name, rounded(io[name] / completed)])),
    }
  }
  try {
    openDatabase({ dbPath: ':memory:' })
    for (let index = 0; index < config.warmup_rounds; index++) await run(config.warmup_requests)
    const rounds = []
    for (let index = 0; index < config.measured_rounds; index++) rounds.push(await measure(config.requests))
    const fields = [
      'wall_ms',
      'throughput_rps',
      'cpu_ms_per_completed',
      'event_loop_p99_ms',
      'event_loop_max_ms',
      'event_loop_utilization',
      'request_p50_ms',
      'request_p99_ms',
      'admission_p99_ms',
      'rss_peak_bytes',
    ]
    const summary = Object.fromEntries(
      fields.map((field) => [field, rounded(median(rounds.map((round) => round[field])))]),
    )
    summary.completed = rounds.reduce((sum, round) => sum + round.completed, 0)
    summary.failures = rounds.reduce((sum, round) => sum + round.failures, 0)
    summary.fs_per_completed = Object.fromEntries(
      names.map((name) => [name, rounded(median(rounds.map((round) => round.fs_per_completed[name])))]),
    )
    console.log(
      `BENCHMARK_CASE=${JSON.stringify({ slots, pool, clients, per_slot: perSlot, restricted_slots: restrictedIds.size, config, rounds, summary })}`,
    )
  } finally {
    closeDatabase()
    for (const [name, original] of originalFs) fs[name] = original
    syncBuiltinESMExports()
    assert.equal(path.dirname(path.resolve(fixture)), tempRoot)
    assert.ok(path.basename(fixture).startsWith('vm2api-codex-bench-'))
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
