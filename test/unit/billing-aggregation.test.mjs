/**
 * Billing aggregation and cache equivalence against the fixed upstream 028 read
 * path. Synthetic in-memory databases only; run with Node >= 22:
 * node --test test/unit/billing-aggregation.test.mjs
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { UsageLogsRepo as Patched } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { ReferenceBillingRepo as Original } from '../fixtures/billing-stats-028-reference.mjs'
import { applyMigrations } from '../../src/lib/db/database.mjs'

const migrationsDir = fileURLToPath(new URL('../../src/lib/db/migrations', import.meta.url))
const NOW = Date.parse('2026-10-26T12:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (ms) => new Date(ms).toISOString()

function row(id, overrides = {}) {
  return {
    id,
    request_id: id,
    created_at: iso(NOW - HOUR),
    log_mode: 'summary',
    method: 'POST',
    path: '/v1/responses',
    protocol: 'openai-responses',
    model: 'gpt-fixture',
    status: 200,
    account_id: 'A',
    vm_id: 'vm-a',
    input_tokens: 31,
    output_tokens: 17,
    cache_read_tokens: 11,
    cache_creation_tokens: 7,
    input_cost: 0.01010101,
    output_cost: 0.02020202,
    cache_read_cost: 0.0030303,
    cache_creation_cost: 0.0040404,
    total_cost: 0.03737373,
    pricing_model: 'fixture-priced',
    ...overrides,
  }
}

function boundaryRows(prefix, start, overrides = {}) {
  return [-1, 0, 1].map((offset) =>
    row(`${prefix}-${offset}`, {
      created_at: iso(start + offset),
      ...overrides,
    }),
  )
}

const windows = [
  {
    account_id: 'A',
    vm_id: 'vm-a',
    reset_5h: iso(NOW + 2 * HOUR),
    reset_7d: iso(NOW + 2 * DAY),
    reset_7d_oi: iso(NOW + DAY),
  },
]
const fiveStart = NOW - 3 * HOUR
const sevenStart = NOW - 5 * DAY
const fableStart = NOW - 6 * DAY
const findAccount = (result, account, vm = 'vm-a') =>
  result.accounts.find((item) => item.account_id === account && item.vm_id === vm)

const cases = [
  { name: 'empty rolling result', rows: [], accountWindows: null },
  { name: 'empty aligned result', rows: [], accountWindows: windows },
  {
    name: 'rolling 5h/7d and Shanghai day inclusive millisecond boundaries',
    rows: [
      ...boundaryRows('rolling-5h', NOW - 5 * HOUR),
      ...boundaryRows('rolling-7d', NOW - 7 * DAY),
      ...boundaryRows('shanghai-today', Date.parse('2026-10-25T16:00:00.000Z')),
      row('future-accepted', { created_at: iso(NOW + DAY) }),
    ],
    accountWindows: null,
    check(result) {
      assert.equal(result.window_5h.requests, 3)
      assert.equal(result.window_7d.requests, 9)
      assert.equal(result.today.requests, 6)
    },
  },
  {
    name: 'aligned 5h/7d/7d_oi inclusive millisecond boundaries',
    rows: [
      ...boundaryRows('aligned-5h', fiveStart),
      ...boundaryRows('aligned-7d', sevenStart),
      ...boundaryRows('aligned-fable', fableStart, { model: 'FaBlE-test' }),
    ],
    accountWindows: windows,
    check(result) {
      const a = findAccount(result, 'A')
      assert.equal(a.window_5h.requests, 2)
      assert.equal(a.window_7d.requests, 5)
      assert.equal(a.window_fable.requests, 2)
      assert.equal(a.window_5h_start, iso(fiveStart))
      assert.equal(a.window_7d_start, iso(sevenStart))
      assert.equal(a.window_fable.start, iso(fableStart))
    },
  },
  {
    name: 'elapsed reset starts new window at reset instant',
    rows: [
      ...boundaryRows('elapsed-5h', NOW - 2 * HOUR),
      ...boundaryRows('elapsed-7d', NOW - DAY),
      ...boundaryRows('elapsed-oi', NOW - 2 * DAY, { model: 'fable-test' }),
    ],
    accountWindows: [
      {
        account_id: 'A',
        vm_id: 'vm-a',
        reset_5h: iso(NOW - 2 * HOUR),
        reset_7d: iso(NOW - DAY),
        reset_7d_oi: iso(NOW - 2 * DAY),
      },
    ],
    check(result) {
      const a = findAccount(result, 'A')
      assert.equal(a.window_5h.requests, 2)
      assert.equal(a.window_7d.requests, 5)
      assert.equal(a.window_fable.requests, 2)
    },
  },
  {
    name: 'exact account+vm then account then vm window precedence; shared vm isolation',
    rows: [
      row('precise-A', { created_at: iso(NOW - 2 * HOUR) }),
      row('account-A', { vm_id: 'vm-b', created_at: iso(NOW - 2 * HOUR) }),
      row('account-B', { account_id: 'B', vm_id: 'shared', created_at: iso(NOW - 2 * HOUR) }),
      row('vm-C', { account_id: 'C', vm_id: 'shared', created_at: iso(NOW - 2 * HOUR) }),
      row('unmatched-E', { account_id: 'E', vm_id: 'vm-e', created_at: iso(NOW - 2 * HOUR) }),
    ],
    accountWindows: [
      { account_id: 'A', vm_id: 'vm-other', reset_5h: iso(NOW - HOUR) },
      { account_id: 'A', vm_id: 'vm-a', reset_5h: iso(NOW + HOUR) },
      { account_id: 'B', vm_id: 'vm-else', reset_5h: iso(NOW - HOUR) },
      { account_id: 'unrelated', vm_id: 'shared', reset_5h: iso(NOW + HOUR) },
    ],
    check(result) {
      assert.equal(findAccount(result, 'A').window_5h.requests, 1)
      assert.equal(findAccount(result, 'A', 'vm-b').window_5h.requests, 0)
      assert.equal(findAccount(result, 'B', 'shared').window_5h.requests, 0)
      assert.equal(findAccount(result, 'C', 'shared').window_5h.requests, 1)
      assert.equal(findAccount(result, 'E', 'vm-e').window_5h.requests, 1)
    },
  },
  {
    name: 'final_account_id takes priority and empty identities use existing fallback',
    rows: [
      row('final-priority-1', { account_id: 'old-A', final_account_id: 'final-Z' }),
      row('final-priority-2', { account_id: 'old-B', final_account_id: 'final-Z' }),
      row('empty-final', { account_id: 'fallback-A', final_account_id: '' }),
      row('empty-account', { account_id: '', final_account_id: '', vm_id: 'fallback-vm' }),
      row('null-account', { account_id: null, final_account_id: null, vm_id: null }),
      row('empty-vm-account', { account_id: '', final_account_id: '', vm_id: '' }),
    ],
    accountWindows: windows,
    check(result) {
      assert.equal(findAccount(result, 'final-Z').requests, 2)
      assert.equal(findAccount(result, 'fallback-A').requests, 1)
      assert.equal(findAccount(result, 'fallback-vm', 'fallback-vm').requests, 1)
      assert.equal(findAccount(result, '—', null).requests, 1)
      assert.equal(findAccount(result, '', null).requests, 1)
      assert.equal(
        result.accounts.some((a) => a.account_id === 'old-A'),
        false,
      )
    },
  },
  ...[null, windows].map((accountWindows) => ({
    name: `null and empty vm preserve existing group/merge behavior (${accountWindows ? 'aligned' : 'rolling'})`,
    rows: [
      row('null-vm', { account_id: 'N', vm_id: null, total_cost: 0.1 }),
      row('empty-vm', { account_id: 'N', vm_id: '', total_cost: 0.2 }),
      row('other-account-null', { account_id: 'M', vm_id: null, total_cost: 0.3 }),
    ],
    accountWindows,
    check(result) {
      assert.equal(result.accounts.length, 3)
      if (accountWindows) {
        assert.deepEqual(
          result.accounts.filter((a) => a.account_id === 'N').map((a) => a.window_5h.requests),
          [2, 2],
        )
        assert.equal(findAccount(result, 'M', null).window_5h.requests, 1)
      }
    },
  })),
  {
    name: 'fable matching trims JS whitespace, folds case, and prefers nonempty upstream model',
    rows: [
      row('fable-model', { model: '  FaBlE-test  ', upstream_model: null }),
      row('fable-empty-upstream', { model: 'FABLE-test', upstream_model: '' }),
      row('fable-whitespace-upstream', { model: 'Fable-test', upstream_model: ' \t\r\n ' }),
      row('fable-nbsp-upstream', { model: 'Fable-test', upstream_model: '\u00a0\u2003\ufeff' }),
      row('fable-ignored-model', { model: 'Fable-test', upstream_model: ' CLAUDE-SONNET ' }),
      row('fable-upstream', { model: 'claude-sonnet', upstream_model: ' \t xFaBlEy \n' }),
      row('nonfable-model', { model: 'claude-sonnet', upstream_model: null }),
    ],
    accountWindows: windows,
    check(result) {
      assert.equal(findAccount(result, 'A').window_fable.requests, 5)
    },
  },
  {
    name: 'SLA success/error predicates include cancelled/auth/quota classifications',
    rows: [
      row('sla-success'),
      row('sla-error-code', { status: 200, error_code: 'upstream_error' }),
      row('sla-server-error', { status: 500, error_code: 'upstream_error' }),
      row('sla-429', { status: 429 }),
      row('sla-queue', { status: 529, error_code: 'pool_queue_timeout' }),
      row('sla-ingress', { status: 401, error_code: 'invalid_api_key' }),
      row('sla-cancel', { status: 499, error_code: 'client_cancelled' }),
      row('sla-credential', { status: 403, error_code: 'upstream_auth_error' }),
      row('sla-null-status', { status: null }),
    ],
    accountWindows: windows,
    check(result) {
      const a = findAccount(result, 'A')
      assert.equal(a.window_5h.success, 5)
      assert.equal(a.window_5h.errors, 3)
      assert.equal(a.window_7d.success, 5)
      assert.equal(a.window_7d.errors, 3)
    },
  },
  {
    name: 'unpriced counts require positive total tokens; individual negative tokens and costs clamp',
    rows: [
      row('unpriced-zero', {
        pricing_model: 'unpriced',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      }),
      row('unpriced-positive', {
        pricing_model: 'unpriced',
        input_tokens: 1,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      }),
      row('unpriced-negative-total', {
        pricing_model: 'unpriced',
        input_tokens: -7,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        input_cost: -0.1,
        output_cost: -0.2,
        cache_read_cost: -0.3,
        cache_creation_cost: -0.4,
        total_cost: -1,
      }),
      row('unpriced-positive-mixed', {
        pricing_model: 'unpriced',
        input_tokens: -2,
        output_tokens: 5,
        cache_read_tokens: 1,
        cache_creation_tokens: 0,
      }),
    ],
    accountWindows: windows,
    check(result) {
      const a = findAccount(result, 'A')
      assert.equal(a.window_5h.unpriced, 2)
      assert.equal(a.window_5h.input_tokens, 1)
      assert.equal(a.window_5h.output_tokens, 6)
      assert.equal(a.window_5h.prompt_tokens, -7)
      assert.equal(a.window_5h.total_cost, 0.11212119)
    },
  },
  {
    name: 'historical account with no rows in current aligned windows',
    rows: [row('old-only', { created_at: iso(NOW - 20 * DAY) })],
    accountWindows: windows,
    check(result) {
      const a = findAccount(result, 'A')
      assert.equal(a.window_5h.requests, 0)
      assert.equal(a.window_7d.requests, 0)
      assert.equal(a.window_fable.requests, 0)
      assert.equal(Object.hasOwn(a.window_5h, 'prompt_tokens'), false)
    },
  },
  {
    name: 'eight decimal cost arithmetic matches per-row official rounding',
    rows: Array.from({ length: 96 }, (_, index) =>
      row(`precision-${index}`, {
        model: index % 2 ? 'fable-test' : 'gpt-fixture',
        input_cost: index % 2 ? 0.00000001 : 0.12345678,
        output_cost: 0.01000001,
        cache_read_cost: 0.00000003,
        cache_creation_cost: 0.00000007,
        total_cost: index % 2 ? 0.01000012 : 0.13345689,
      }),
    ),
    accountWindows: windows,
    check(result) {
      assert.equal(findAccount(result, 'A').window_5h.requests, 96)
      assert.equal(findAccount(result, 'A').window_5h.input_cost, 5.92592592)
    },
  },
  {
    name: 'missing/invalid resets fall back; numeric seconds and ms remain accepted',
    rows: [
      row('fallback-missing', { account_id: 'missing' }),
      row('fallback-invalid', { account_id: 'invalid' }),
      row('reset-seconds', { account_id: 'seconds' }),
      row('reset-ms', { account_id: 'milliseconds' }),
    ],
    accountWindows: [
      { account_id: 'missing', vm_id: 'vm-a' },
      { account_id: 'invalid', vm_id: 'vm-a', reset_5h: 'invalid', reset_7d: 'invalid', reset_7d_oi: 'invalid' },
      { account_id: 'seconds', vm_id: 'vm-a', reset_5h: (NOW + HOUR) / 1000, reset_7d: String((NOW + DAY) / 1000) },
      { account_id: 'milliseconds', vm_id: 'vm-a', reset_5h: NOW + HOUR, reset_7d: String(NOW + DAY) },
    ],
  },
]

// pricing.shanghaiDayStartIso() reads the wall clock independently of opts.now.
// Fix both for a repeatable full-object comparison, then restore the native Date.
const NativeDate = Date
let clockNow = NOW
globalThis.Date = class FixedDate extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : [clockNow]))
  }
  static now() {
    return clockNow
  }
}

function insertRows(db, records) {
  for (const record of records) {
    const columns = Object.keys(record)
    db.prepare(`INSERT INTO usage_logs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
      ...columns.map((column) => record[column]),
    )
  }
}

function fixtureDatabase(records) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const applied = applyMigrations(db, { migrationsDir })
  assert.equal(applied.length, 49, 'test schema must include all SQL migrations through slot browser profiles')
  db.prepare('UPDATE schema_migrations SET applied_at = ?').run('2026-09-01T00:00:00.000Z')
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    'usage_logs_pruned_through',
    JSON.stringify('2026-09-15T00:00:00.000Z'),
  )
  insertRows(db, records)
  return db
}

const cacheScopes = [
  windows,
  [{ account_id: 'B', vm_id: 'vm-b', reset_5h: iso(NOW + HOUR) }],
  [{ account_id: 'A', vm_id: 'vm-a', reset_5h: iso(NOW + 3 * HOUR) }],
]
let cacheCasesChecked = 0
function cacheCase(name, verify, records = [row('cache-A'), row('cache-B', { account_id: 'B', vm_id: 'vm-b' })]) {
  clockNow = NOW
  const db = fixtureDatabase(records)
  try {
    const original = new Original(db)
    const patched = new Patched(db)
    original.backfillMissingCosts = () => 0
    patched.backfillMissingCosts = () => 0
    const calls = { total: 0, since: 0 }
    const costByAccount = patched.costByAccount.bind(patched)
    patched.costByAccount = (options = {}) => {
      calls[options.since ? 'since' : 'total']++
      return costByAccount(options)
    }
    const compareFresh = (accountWindows) => {
      const actual = patched.billingStats({ accountWindows })
      const expected = original.billingStats({ now: clockNow, accountWindows })
      assert.deepStrictEqual(actual, expected, `${name}: cached result versus fresh original`)
      return actual
    }
    verify({ db, original, patched, calls, compareFresh })
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    cacheCasesChecked++
    console.log(`PASS cache: ${name}`)
  } finally {
    db.close()
  }
}

let rowsChecked = 0
try {
  for (const fixture of cases) {
    const db = fixtureDatabase(fixture.rows)
    try {
      const original = new Original(db)
      const patched = new Patched(db)
      original.backfillMissingCosts = () => 0
      patched.backfillMissingCosts = () => 0
      const options = { now: NOW, accountWindows: fixture.accountWindows }
      const expected = original.billingStats(options)
      fixture.check?.(expected)
      const actual = patched.billingStats(options)
      assert.deepStrictEqual(actual, expected, fixture.name)
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
      rowsChecked += fixture.rows.length
      console.log(`PASS ${fixture.name}`)
    } finally {
      db.close()
    }
  }

  cacheCase(
    'different scopes share all-time/today base; repeated scope uses outer cache',
    ({ patched, calls, compareFresh }) => {
      const first = compareFresh(cacheScopes[0])
      const base = patched._billingBaseCache
      assert.ok(base && Number.isFinite(base.expires_at), 'candidate exposes a live _billingBaseCache')
      compareFresh(cacheScopes[1])
      assert.strictEqual(patched._billingBaseCache, base, 'another scope must reuse the same base')
      assert.strictEqual(patched.billingStats({ accountWindows: cacheScopes[0] }), first)
      assert.deepEqual(calls, { total: 1, since: 1 }, 'total and today run once across scopes')
    },
  )

  cacheCase('outer entry cannot extend an existing base into a second TTL', ({ patched, calls, compareFresh }) => {
    compareFresh(cacheScopes[0])
    const base = patched._billingBaseCache
    assert.equal(base.expires_at, NOW + 10_000)
    clockNow = NOW + 9_000
    compareFresh(cacheScopes[1])
    const entries = [...patched._billingStatsCache.values()]
    assert.equal(entries.length, 2)
    assert.ok(
      entries.every((entry) => entry.expires_at <= base.expires_at),
      'outer expiry is bounded by base expiry',
    )
    assert.deepEqual(calls, { total: 1, since: 1 })
    clockNow = NOW + 10_000
    compareFresh(cacheScopes[1])
    assert.deepEqual(calls, { total: 2, since: 2 }, 'entry created at +9s must refresh at +10s')
  })

  cacheCase('base is reused before 10s and recomputed exactly at TTL', ({ patched, calls, compareFresh }) => {
    compareFresh(cacheScopes[0])
    const firstBase = patched._billingBaseCache
    clockNow = NOW + 9_999
    compareFresh(cacheScopes[1])
    assert.strictEqual(patched._billingBaseCache, firstBase)
    assert.deepEqual(calls, { total: 1, since: 1 })
    clockNow = NOW + 10_000
    compareFresh(cacheScopes[2])
    assert.notStrictEqual(patched._billingBaseCache, firstBase)
    assert.deepEqual(calls, { total: 2, since: 2 })
    assert.equal(patched._billingBaseCache.expires_at, NOW + 20_000)
  })

  const shanghaiMidnight = Date.parse('2026-10-26T16:00:00.000Z')
  for (const sameScope of [false, true]) {
    cacheCase(
      `Shanghai day change invalidates base before its TTL on ${sameScope ? 'the same' : 'a new'} scope`,
      ({ patched, calls, compareFresh }) => {
        clockNow = shanghaiMidnight - 5_000
        const before = compareFresh(cacheScopes[0])
        const firstBase = patched._billingBaseCache
        assert.equal(before.today.requests, 2, 'official today bucket also includes future-dated synthetic row')
        clockNow = shanghaiMidnight + 1_000
        assert.ok(clockNow < firstBase.expires_at, 'cross day while previous 10s base is still live')
        const after = compareFresh(cacheScopes[sameScope ? 0 : 1])
        assert.equal(after.today_start, iso(shanghaiMidnight))
        assert.equal(after.today.requests, 1)
        assert.notStrictEqual(patched._billingBaseCache, firstBase)
        assert.deepEqual(calls, { total: 2, since: 2 })
      },
      [
        row('day-before', { created_at: iso(shanghaiMidnight - 6_000) }),
        row('day-after', { created_at: iso(shanghaiMidnight + 1_000) }),
      ],
    )
  }

  cacheCase(
    'explicit opts.now bypasses both caches and leaves their live entries untouched',
    ({ db, original, patched, calls, compareFresh }) => {
      compareFresh(cacheScopes[0])
      const base = patched._billingBaseCache
      const outerEntries = [...patched._billingStatsCache.entries()]
      insertRows(db, [row('cache-new-write')])
      for (let i = 0; i < 2; i++) {
        const options = { now: clockNow, accountWindows: cacheScopes[0] }
        const actual = patched.billingStats(options)
        assert.deepStrictEqual(actual, original.billingStats(options))
        assert.equal(actual.total.requests, 3, 'explicit time reads rows added after cached base')
        assert.strictEqual(patched._billingBaseCache, base, 'explicit time does not replace base')
        assert.deepStrictEqual([...patched._billingStatsCache.entries()], outerEntries)
      }
      assert.deepEqual(calls, { total: 3, since: 3 }, 'each explicit time call recomputes total and today')
    },
  )

  cacheCase('explicit opts.now does not populate an initially empty base', ({ original, patched, calls }) => {
    for (let i = 0; i < 2; i++) {
      const options = { now: clockNow, accountWindows: cacheScopes[i] }
      assert.deepStrictEqual(patched.billingStats(options), original.billingStats(options))
      assert.equal(patched._billingBaseCache == null, true)
      assert.equal(patched._billingStatsCache.size, 0)
    }
    assert.deepEqual(calls, { total: 2, since: 2 })
  })
} finally {
  globalThis.Date = NativeDate
}

console.log(
  JSON.stringify({
    passed: cases.length + cacheCasesChecked,
    equivalence_cases: cases.length,
    cache_cases: cacheCasesChecked,
    rows: rowsChecked,
    fixed_now: iso(NOW),
    comparison: 'complete billingStats deepStrictEqual',
    database: ':memory:',
    production_writes: 0,
  }),
)
