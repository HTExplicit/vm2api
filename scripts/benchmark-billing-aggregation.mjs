/**
 * Synthetic billing benchmark against upstream 028; no production DB or network.
 * Run: node scripts/benchmark-billing-aggregation.mjs
 * Requires Node >= 22 and the fixed baseline commit in local Git history.
 * Each timing uses a fresh repository with explicit opts.now (both caches off).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../src/lib/db/database.mjs'
import { UsageLogsRepo as Candidate } from '../src/lib/db/repos/usage-logs-repo.mjs'

const BASE = '77b72613c90f2eda0f90165d524d7a247b9d1974'
const MODULE = 'src/lib/db/repos/usage-logs-repo.mjs'
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const moduleUrl = new URL(`../${MODULE}`, import.meta.url)
const originalSource = execFileSync('git', ['show', `${BASE}:${MODULE}`], { cwd: ROOT, encoding: 'utf8' }).replace(
  /(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
  (_match, prefix, quote, specifier) => `${prefix}${quote}${new URL(specifier, moduleUrl).href}${quote}`,
)
const { UsageLogsRepo: Original } = await import(
  `data:text/javascript;base64,${Buffer.from(originalSource).toString('base64')}`
)

const ROWS = 60_000
const SLOTS = 32
const TRIALS = 3
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-26T12:00:00.000Z')
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

// Today is deliberately wall-clock based, independently of opts.now.
const NativeDate = Date
globalThis.Date = class FixedDate extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : [NOW]))
  }
  static now() {
    return NOW
  }
}

const db = new DatabaseSync(':memory:')
function repository(Repo) {
  const repo = new Repo(db)
  repo.backfillMissingCosts = () => 0
  return repo
}

function measured(Repo) {
  const repo = repository(Repo)
  const start = performance.now()
  const value = repo.billingStats({ accountWindows: windows, now: NOW })
  return { value, repo, elapsed_ms: performance.now() - start }
}

function countAccountQueries(repo) {
  const counts = { all_time: 0, today: 0 }
  const costByAccount = repo.costByAccount.bind(repo)
  repo.costByAccount = (opts = {}) => {
    counts[opts.since ? 'today' : 'all_time']++
    return costByAccount(opts)
  }
  return counts
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const ms = (value) => Math.round(value * 100) / 100

try {
  db.exec('PRAGMA foreign_keys = ON')
  const migrations = applyMigrations(db)
  assert.equal(migrations.length, 49)
  db.prepare('UPDATE schema_migrations SET applied_at = ?').run('2026-09-01T00:00:00.000Z')
  const insert = db.prepare(`
    INSERT INTO usage_logs (
      id, request_id, created_at, log_mode, method, path, protocol,
      model, upstream_model, status, error_code, account_id, vm_id,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost, pricing_model
    ) VALUES (${Array(23).fill('?').join(', ')})
  `)
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
      i % 101 === 0 ? 'unpriced' : 'fixture-priced',
    )
  }
  db.exec('COMMIT')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])

  const timings = { original_ms: [], candidate_ms: [] }
  let lastCandidate
  for (let trial = 0; trial < TRIALS; trial++) {
    // Alternate execution order to reduce systematic warm-page/JIT bias.
    let original
    let candidate
    if (trial % 2 === 0) {
      original = measured(Original)
      candidate = measured(Candidate)
    } else {
      candidate = measured(Candidate)
      original = measured(Original)
    }
    assert.deepStrictEqual(candidate.value, original.value, `complete billingStats result, trial ${trial + 1}`)
    timings.original_ms.push(original.elapsed_ms)
    timings.candidate_ms.push(candidate.elapsed_ms)
    lastCandidate = candidate.repo
  }

  // Capture the actual prepared SQL for all four (VM/empty VM) x Fable shapes.
  lastCandidate._costBucketSince({ account_id: 'empty-account', vm_id: null }, NOW - 7 * DAY)
  lastCandidate._costBucketSince({ account_id: 'empty-account', vm_id: '' }, NOW - 7 * DAY, true)
  assert.equal(lastCandidate._costBucketStatements.size, 4)
  const queryPlans = {}
  for (const [key, statement] of lastCandidate._costBucketStatements) {
    const params = key.startsWith('vm:') ? [vmId(0)] : []
    params.push(iso(NOW - 7 * DAY), key.startsWith('vm:') ? accountId(0) : 'empty-account')
    if (key.endsWith(':true')) params.push(' ', ' ')
    queryPlans[key] = db
      .prepare(`EXPLAIN QUERY PLAN ${statement.sourceSQL}`)
      .all(...params)
      .map((row) => row.detail)
    assert.ok(
      queryPlans[key].some((detail) => detail.includes('idx_reqlog_vm')),
      `${key} uses existing VM/time index`,
    )
    assert.ok(
      queryPlans[key].every((detail) => !detail.startsWith('SCAN usage_logs')),
      `${key} avoids fleet scan`,
    )
  }

  const original = repository(Original)
  const candidate = repository(Candidate)
  const originalQueries = countAccountQueries(original)
  const candidateQueries = countAccountQueries(candidate)
  const scopes = [windows, [windows[0]], [windows[1]], [windows[2]]]
  let firstCandidate
  for (let i = 0; i < scopes.length; i++) {
    const opts = { accountWindows: scopes[i] }
    const actual = candidate.billingStats(opts)
    assert.deepStrictEqual(actual, original.billingStats(opts), `cross-scope complete result ${i + 1}`)
    if (i === 0) firstCandidate = actual
  }
  assert.strictEqual(candidate.billingStats({ accountWindows: scopes[0] }), firstCandidate)
  assert.deepEqual(originalQueries, { all_time: scopes.length, today: scopes.length })
  assert.deepEqual(candidateQueries, { all_time: 1, today: 1 })

  const originalMedian = median(timings.original_ms)
  const candidateMedian = median(timings.candidate_ms)
  const improvement = 1 - candidateMedian / originalMedian
  console.log(
    JSON.stringify(
      {
        baseline: BASE,
        node: process.version,
        database: ':memory:',
        synthetic_rows: ROWS,
        slots: SLOTS,
        cold_trials_each: TRIALS,
        cold_definition: 'fresh repository; explicit opts.now bypasses both caches; no maintenance backfill',
        complete_results_equal: true,
        original_ms: timings.original_ms.map(ms),
        candidate_ms: timings.candidate_ms.map(ms),
        original_median_ms: ms(originalMedian),
        candidate_median_ms: ms(candidateMedian),
        median_improvement_pct: ms(improvement * 100),
        target_improvement_pct: 50,
        target_met: improvement >= 0.5,
        prepared_statement_shapes: lastCandidate._costBucketStatements.size,
        query_plans: queryPlans,
        cross_scope: {
          scopes: scopes.length,
          original_queries: originalQueries,
          candidate_queries: candidateQueries,
          repeated_scope_hit: true,
        },
        production_writes: 0,
      },
      null,
      2,
    ),
  )
  assert.ok(improvement >= 0.5, 'candidate median cold calculation must improve by at least 50%')
} finally {
  db.close()
  globalThis.Date = NativeDate
}
