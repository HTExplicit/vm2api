/**
 * Offline billing isolation benchmark; synthetic temporary WAL database only.
 * Run: node scripts/benchmark-billing-worker.mjs --warmup 5 --rounds 5
 * --root selects the checkout whose real repository and SQLite pool are tested.
 * No gateway, credentials, network, model requests, or production database.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: fileURLToPath(new URL('../', import.meta.url)) },
    output: { type: 'string' },
    rows: { type: 'string', default: '60000' },
    slots: { type: 'string', default: '32' },
    warmup: { type: 'string', default: '5' },
    rounds: { type: 'string', default: '5' },
    target: { type: 'string', default: '80' },
    'timer-ms': { type: 'string', default: '1' },
    help: { type: 'boolean', default: false },
  },
})
if (values.help) {
  console.log(
    'Usage: node scripts/benchmark-billing-worker.mjs [--root PATH] [--output FILE] [--rows 60000] [--slots 32] [--warmup 5] [--rounds 5] [--target 80] [--timer-ms 1]',
  )
  process.exit(0)
}
function integer(name, minimum, maximum) {
  const value = Number(values[name])
  assert.ok(Number.isInteger(value) && value >= minimum && value <= maximum, `invalid --${name}`)
  return value
}
const ROOT = path.resolve(values.root)
const ROWS = integer('rows', 1, 10_000_000)
const SLOTS = integer('slots', 1, 10_000)
const WARMUP = integer('warmup', 0, 100)
const ROUNDS = integer('rounds', 1, 100)
const TARGET = integer('target', 0, 100)
const TIMER_MS = integer('timer-ms', 1, 100)
const moduleAt = (relative) => pathToFileURL(path.join(ROOT, relative)).href
const { createDatabase } = await import(moduleAt('src/lib/db/database.mjs'))
const { UsageLogsRepo } = await import(moduleAt('src/lib/db/repos/usage-logs-repo.mjs'))
const { startSqlitePool, stopSqlitePool, usageRead, readAll } = await import(moduleAt('src/lib/db/sqlite-pool.mjs'))
assert.equal(typeof UsageLogsRepo.prototype.billingStatsReadOnly, 'function', 'checkout lacks read-only billing query')

const tempRoot = fs.realpathSync(os.tmpdir())
const fixtureDir = fs.mkdtempSync(path.join(tempRoot, 'vm2api-billing-worker-bench-'))
const dbPath = path.join(fixtureDir, 'kin.db')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.now()
const iso = (ms) => new Date(ms).toISOString()
const vmId = (slot) => `vm-${String(slot).padStart(2, '0')}`
const accountId = (slot) => `account-${String(slot).padStart(2, '0')}`
const windows = Array.from({ length: SLOTS }, (_, slot) => ({
  vm_id: vmId(slot),
  account_id: accountId(slot),
  reset_5h: iso(NOW + (1 + (slot % 4)) * HOUR),
  reset_7d: iso(NOW + (1 + (slot % 5)) * DAY),
  reset_7d_oi: iso(NOW + (1 + (slot % 3)) * DAY),
}))
const opts = { accountWindows: windows, now: NOW }
const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]
const rounded = (value) => Math.round(value * 1000) / 1000
const mib = (bytes) => rounded(bytes / 1024 / 1024)
const threadCpu = () => (typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null)
const cpuMs = (end, start) =>
  start && end ? rounded((end.user + end.system - start.user - start.system) / 1000) : null
let db
let poolStarted = false

async function measured(query) {
  // Arm and exercise the heartbeat before the query. Keep it alive after a
  // synchronous query so its first overdue callback records the entire stall.
  let previous = performance.now()
  let gaps = []
  let peakRss = process.memoryUsage.rss()
  const timer = setInterval(() => {
    const now = performance.now()
    gaps.push(now - previous)
    previous = now
    peakRss = Math.max(peakRss, process.memoryUsage.rss())
  }, TIMER_MS)
  try {
    await sleep(Math.max(10, TIMER_MS * 3))
    gaps = []
    previous = performance.now()
    const rssBefore = process.memoryUsage.rss()
    const processBefore = process.cpuUsage()
    const threadBefore = threadCpu()
    const started = performance.now()
    const value = await query()
    const elapsed = performance.now() - started
    const threadAfter = threadCpu()
    const processAfter = process.cpuUsage()
    const rssAfter = process.memoryUsage.rss()
    peakRss = Math.max(peakRss, rssAfter)
    await sleep(Math.max(5, TIMER_MS * 2))
    return {
      value,
      metrics: {
        elapsed_ms: rounded(elapsed),
        main_thread_max_gap_ms: rounded(Math.max(0, ...gaps)),
        heartbeat_callbacks: gaps.length,
        process_cpu_ms: cpuMs(processAfter, processBefore),
        main_thread_cpu_ms: cpuMs(threadAfter, threadBefore),
        rss_before_mib: mib(rssBefore),
        rss_after_mib: mib(rssAfter),
        rss_peak_observed_mib: mib(peakRss),
      },
    }
  } finally {
    clearInterval(timer)
  }
}

try {
  db = createDatabase({ dbPath })
  assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal')
  const insert = db.prepare(`INSERT INTO usage_logs (
    id, request_id, created_at, log_mode, method, path, protocol,
    model, upstream_model, status, error_code, account_id, vm_id,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost, pricing_model
  ) VALUES (${Array(23).fill('?').join(', ')})`)
  db.exec('BEGIN')
  for (let i = 0; i < ROWS; i++) {
    const slot = i % SLOTS
    const age = i % 10 < 8 ? (i * 15_485_863) % (7 * DAY) : 7 * DAY + ((i * 32_452_843) % (14 * DAY))
    const fable = i % 3 === 0
    const status = i % 19 === 0 ? 500 : i % 17 === 0 ? 429 : 200
    insert.run(
      `row-${i}`,
      `request-${i}`,
      iso(NOW - age),
      'summary',
      'POST',
      '/v1/responses',
      'openai-responses',
      fable ? 'Fable-fixture' : 'gpt-fixture',
      fable && i % 2 === 0 ? '\t\u00a0\ufeff' : null,
      status,
      status === 500 ? 'upstream_error' : null,
      accountId(slot),
      vmId(slot),
      100 + (i % 2048),
      20 + (i % 512),
      i % 256,
      i % 64,
      0.01010101,
      0.02020202,
      0.0030303,
      0.0040404,
      0.03737373,
      'fixture-priced',
    )
  }
  db.exec('COMMIT')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get().n, ROWS)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])

  function direct() {
    const repo = new UsageLogsRepo(db)
    // Historical cost maintenance is outside this aggregation benchmark. This
    // models its existing 60-second throttle having run immediately beforehand.
    repo._billingBackfillAt = Date.now()
    db.exec('BEGIN')
    try {
      const result = repo.billingStats(opts)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const worker = () => usageRead({ kind: 'repo', method: 'billingStatsReadOnly', args: [opts] })
  const reference = direct()
  const rssBeforePool = process.memoryUsage.rss()
  startSqlitePool(dbPath)
  poolStarted = true
  await readAll('SELECT 1 AS ready')
  const rssAfterPool = process.memoryUsage.rss()

  for (let round = 0; round < WARMUP; round++) {
    assert.deepStrictEqual(direct(), reference, `direct warmup ${round + 1}`)
    assert.deepStrictEqual(await worker(), reference, `worker warmup ${round + 1}`)
  }
  const trials = { direct: [], worker: [] }
  for (let round = 0; round < ROUNDS; round++) {
    for (const mode of round % 2 === 0 ? ['direct', 'worker'] : ['worker', 'direct']) {
      const result = await measured(mode === 'direct' ? direct : worker)
      assert.deepStrictEqual(result.value, reference, `${mode} complete result, round ${round + 1}`)
      trials[mode].push(result.metrics)
    }
  }
  const summarize = (mode) => {
    const samples = trials[mode]
    return Object.fromEntries(
      [
        'elapsed_ms',
        'main_thread_max_gap_ms',
        'heartbeat_callbacks',
        'process_cpu_ms',
        'main_thread_cpu_ms',
        'rss_before_mib',
        'rss_after_mib',
        'rss_peak_observed_mib',
      ].map((key) => [
        key,
        samples.every((sample) => sample[key] === null) ? null : rounded(median(samples.map((sample) => sample[key]))),
      ]),
    )
  }
  const directMedian = summarize('direct')
  const workerMedian = summarize('worker')
  const reduction =
    directMedian.main_thread_max_gap_ms > 0
      ? 100 * (1 - workerMedian.main_thread_max_gap_ms / directMedian.main_thread_max_gap_ms)
      : 0
  const report = {
    schema_version: 1,
    benchmark: 'billing aggregation event-loop isolation',
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    module_root: ROOT,
    synthetic_rows: ROWS,
    slots: SLOTS,
    database: 'temporary file-backed WAL; deleted after benchmark',
    warmup_rounds_each: WARMUP,
    measured_rounds_each: ROUNDS,
    timer_interval_ms: TIMER_MS,
    cold_definition:
      'direct fresh repo; explicit opts.now bypasses snapshot/base caches in both modes; warmed SQLite/JIT; no maintenance backfill',
    complete_results_equal: true,
    baseline: 'UsageLogsRepo.billingStats on main thread',
    candidate: 'real SQLite pool usageRead(repo.billingStatsReadOnly), consistent read transaction',
    pool_start_rss_mib: {
      before: mib(rssBeforePool),
      after: mib(rssAfterPool),
      delta: mib(rssAfterPool - rssBeforePool),
    },
    median: { direct: directMedian, worker: workerMedian },
    main_thread_gap_reduction_pct: rounded(reduction),
    target_reduction_pct: TARGET,
    target_met: reduction >= TARGET,
    samples: trials,
    limitations: [
      'Both modes load the selected checkout; this compares its synchronous and pooled execution, not two Git revisions.',
      'Direct trials include fresh repository statement setup; the live pool retains its normal prepared-statement cache.',
      'Synthetic aggregation isolation, not real model TTFT or gateway throughput.',
      'Process CPU/RSS include all SQLite pool workers; thread CPU is main-thread-only when supported.',
      'Observed RSS samples are not allocation profiling or per-worker attribution.',
      'Historical cost maintenance stays on the writer and is excluded from both timed paths.',
    ],
    network_requests: 0,
    real_model_calls: 0,
    production_writes: 0,
  }
  const json = JSON.stringify(report, null, 2)
  if (values.output) {
    const output = path.resolve(values.output)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, `${json}\n`)
  }
  console.log(json)
  assert.ok(report.target_met, `main-thread heartbeat max-gap reduction must reach ${TARGET}%`)
} finally {
  if (poolStarted) await stopSqlitePool()
  db?.close()
  // Only remove the unique directory created above, below the resolved temp root.
  assert.ok(path.resolve(fixtureDir).startsWith(path.join(tempRoot, 'vm2api-billing-worker-bench-')))
  fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
