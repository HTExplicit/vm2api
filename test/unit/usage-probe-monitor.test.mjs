import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isUsageProbeDue,
  isUsageProbeTarget,
  normalizeUsageProbeConfig,
  createUsageProbeMonitor,
} from '../../src/lib/oauth/usage-probe-monitor.mjs'

const live = {
  id: 'vm-13',
  status: 'running',
  has_refresh: true,
  proxy: { host: '127.0.0.1', port: 1080, url: 'socks5h://127.0.0.1:1080' },
}

test('normalize fills usage-probe defaults', () => {
  const n = normalizeUsageProbeConfig({ interval_sec: 3, concurrency: 99, stale_sec: 10 })
  assert.equal(n.enabled, false)
  assert.equal(n.interval_sec, 30)
  assert.equal(n.stale_sec, 60)
  assert.equal(n.concurrency, 8)
  assert.equal(n.run_on_start, true)
})

test('only live credential + proxy slots are usage-probe targets', () => {
  assert.equal(isUsageProbeTarget(live), true)
  assert.equal(isUsageProbeTarget({ ...live, has_refresh: false, has_token: false }), false)
  assert.equal(isUsageProbeTarget({ ...live, status: 'stopped' }), false)
  assert.equal(isUsageProbeTarget({ ...live, proxy: null }), false)
})

test('a never-sampled window hops official /usage once', () => {
  assert.deepEqual(isUsageProbeDue({ unified: { '5h': { utilization: 0, status: 'active' } } }), {
    due: true,
    reason: 'never_sampled_official',
  })
})

test('a live Extra window stays passive', () => {
  const now = Date.parse('2026-09-23T11:25:00.000Z')
  assert.deepEqual(
    isUsageProbeDue(
      {
        unified: {
          headers: {
            '5h': { utilization: 0.2, status: 'allowed', reset: '2026-09-23T16:00:00.000Z' },
          },
        },
      },
      { now },
    ),
    { due: false, reason: 'list_passive_only' },
  )
})

test('an official sample without Extra stays passive', () => {
  const now = Date.parse('2026-09-23T11:25:00.000Z')
  assert.deepEqual(
    isUsageProbeDue(
      {
        unified: {
          source: 'vm-oauth-usage',
          official: {
            '5h': { utilization: 0.22, status: 'allowed', reset: '2026-09-23T16:00:00.000Z' },
          },
        },
      },
      { now },
    ),
    { due: false, reason: 'list_passive_only' },
  )
})

test('a stale Pro classification is rechecked without an elapsed Extra window', () => {
  const now = Date.parse('2026-09-23T11:25:00.000Z')
  const account = {
    unified: {
      account_tier: 'pro',
      fable: { plan_denied: true, status: 403, probed_at: '2026-09-23T10:00:00.000Z' },
      fable_probe_attempted_at: '2026-09-23T10:00:00.000Z',
    },
  }
  assert.deepEqual(isUsageProbeDue(account, { now }), { due: true, reason: 'pro_tier_recheck' })
  account.unified.fable_probe_attempted_at = '2026-09-23T11:20:00.000Z'
  assert.deepEqual(isUsageProbeDue(account, { now }), { due: false, reason: 'probed_recently' })
})

test('an elapsed Extra window is probed once, then held for the gap', () => {
  const now = Date.parse('2026-09-23T11:25:00.000Z')
  const reset = '2026-09-23T01:20:00.000Z'
  const stale = {
    unified: {
      headers: {
        '5h': { utilization: 0, status: 'active', reset, stale_reason: 'reset_elapsed' },
        '7d': { utilization: 0.5, status: 'allowed', reset: '2026-09-24T07:00:00.000Z' },
      },
    },
  }
  assert.deepEqual(isUsageProbeDue(stale, { now }), {
    due: true,
    reason: 'extra_window_elapsed',
  })
  const probed = {
    ...stale,
    unified: {
      ...stale.unified,
      last_probe: { at: '2026-09-23T11:20:00.000Z', ok: true },
    },
  }
  assert.deepEqual(isUsageProbeDue(probed, { now }), {
    due: false,
    reason: 'probed_recently',
  })
})

test('invalid_grant slots are not usage-probe targets', () => {
  assert.equal(
    isUsageProbeTarget({
      ...live,
      refresh_error: 'invalid_grant',
      claude: { refresh_error: 'invalid_grant', has_refresh: true },
    }),
    false,
  )
})

const liveExtra = {
  headers: {
    '5h': { utilization: 0.2, status: 'allowed', reset: '2026-12-01T16:00:00.000Z' },
  },
}

test('monitor reconciles Extra and does not call probeAccount', async () => {
  const probed = []
  const reconciled = []
  const monitor = createUsageProbeMonitor({
    config: { interval_sec: 60, stale_sec: 300, run_on_start: false },
    listTargets: () => [live, { ...live, id: 'vm-05' }],
    accountForVm: (vm) => ({ account_id: vm.id, unified: liveExtra }),
    reconcile: (vm) => reconciled.push(vm.id),
    probeOne: async (vm) => {
      probed.push(vm.id)
      return { ok: true, source: 'vm-oauth-usage' }
    },
  })
  const run = await monitor.runOnce()
  assert.deepEqual(reconciled, ['vm-13', 'vm-05'])
  assert.equal(run.due, 0)
  assert.equal(probed.length, 0)
  assert.equal(
    run.items.every((item) => item.reason === 'reconcile_extra'),
    true,
  )
})

test('monitor hops /usage only for an elapsed Extra window', async () => {
  const probed = []
  const staleVm = { ...live, id: 'vm-05' }
  const monitor = createUsageProbeMonitor({
    config: { interval_sec: 60, stale_sec: 300, run_on_start: false },
    listTargets: () => [live, staleVm],
    accountForVm: (vm) =>
      vm.id === 'vm-05'
        ? {
            account_id: vm.id,
            unified: {
              headers: {
                '5h': {
                  utilization: 0,
                  status: 'active',
                  reset: '2026-09-23T01:20:00.000Z',
                  stale_reason: 'reset_elapsed',
                },
              },
            },
          }
        : { account_id: vm.id, unified: liveExtra },
    reconcile: () => {},
    probeOne: async (vm) => {
      probed.push(vm.id)
      return { ok: true, source: 'official-cc-usage' }
    },
  })
  const run = await monitor.runOnce()
  assert.deepEqual(probed, ['vm-05'])
  assert.equal(run.due, 1)
  assert.equal(run.items.find((item) => item.vm_id === 'vm-05')?.reason, 'extra_window_elapsed')
  assert.equal(run.items.find((item) => item.vm_id === 'vm-13')?.reason, 'reconcile_extra')
})

test('#163 A17: an in-use account with a sample older than stale_sec hops even before reset', () => {
  const now = Date.parse('2026-09-23T12:00:00.000Z')
  const account = {
    last_probe: { at: '2026-09-23T10:00:00.000Z', source: 'vm-oauth-usage' },
    unified: {
      source: 'vm-oauth-usage',
      official: { '5h': { utilization: 0.3, status: 'allowed', reset: '2026-09-23T14:00:00.000Z' } },
    },
  }
  const staleMs = 300_000
  assert.deepEqual(isUsageProbeDue(account, { now, staleMs, active: true }), { due: true, reason: 'sample_stale' })
  assert.deepEqual(isUsageProbeDue(account, { now, staleMs, active: false }), {
    due: false,
    reason: 'list_passive_only',
  })
  const edge = { ...account, last_probe: { at: new Date(now - staleMs + 1).toISOString() } }
  assert.notEqual(isUsageProbeDue(edge, { now, staleMs, active: true }).reason, 'sample_stale')
  const expired = { ...account, last_probe: { at: new Date(now - staleMs).toISOString() } }
  assert.equal(isUsageProbeDue(expired, { now, staleMs, active: true }).reason, 'sample_stale')
})

test('#163 A18: timer and a 429 event share one inflight /usage hop per VM', async () => {
  let calls = 0
  let finish
  const monitor = createUsageProbeMonitor({
    config: { concurrency: 1, stale_sec: 60 },
    listTargets: () => [live],
    accountForVm: () => ({ unified: {} }),
    isActive: () => true,
    probeOne: () => {
      calls += 1
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  })
  const timed = monitor.runOnce()
  await new Promise((resolve) => setImmediate(resolve))
  const event = monitor.probeNow('vm-13', 'rate_limited_unknown')
  assert.equal(calls, 1)
  finish({ ok: true, source: 'oauth-usage' })
  const [run, evented] = await Promise.all([timed, event])
  assert.equal(calls, 1)
  assert.equal(evented.ok, true)
  assert.equal(run.items.find((item) => item.vm_id === 'vm-13').ok, true)
})

test('#163 A18: a failed hop keeps the old sample and backs off instead of retrying hot', async () => {
  let calls = 0
  const monitor = createUsageProbeMonitor({
    config: { concurrency: 1, stale_sec: 60 },
    listTargets: () => [live],
    accountForVm: () => ({ unified: {} }),
    isActive: () => true,
    probeOne: async () => {
      calls += 1
      return { ok: false }
    },
  })
  const first = await monitor.probeNow('vm-13')
  assert.equal(first.ok, false)
  const second = await monitor.probeNow('vm-13')
  assert.equal(second.reason, 'probe_backoff')
  assert.equal(calls, 1)
})

function codexSlot(now, usage = {}) {
  return {
    ...live,
    platform: 'openai',
    family: 'codex',
    codex_usage: {
      last_success_at: new Date(now).toISOString(),
      pending_refresh: false,
      windows: [
        { id: '5h', used_percent: 0, reset_at: new Date(now + 3600_000).toISOString() },
        { id: '7d', used_percent: 69, reset_at: new Date(now + 7 * 86400_000).toISOString() },
      ],
      ...usage,
    },
  }
}

test('GPT monitor uses successful slot samples and does not query again until stale_sec', async () => {
  let now = Date.parse('2026-10-31T10:00:00.000Z')
  const vm = codexSlot(now)
  const calls = []
  const monitor = createUsageProbeMonitor({
    config: { interval_sec: 60, stale_sec: 300 },
    now: () => now,
    listTargets: () => [vm, { ...vm, id: 'stopped-gpt', status: 'stopped' }],
    accountForVm: () => assert.fail('GPT must not read a leftover Claude account sample'),
    isActive: () => false,
    probeOne: async (slot) => {
      calls.push(slot.id)
      slot.codex_usage.last_success_at = new Date(now).toISOString()
      return { ok: true, source: 'openai-wham-usage' }
    },
  })
  assert.equal((await monitor.runOnce()).due, 0, 'zero is a valid successful reading')
  now += 300_000
  const stale = await monitor.runOnce()
  assert.equal(stale.due, 1)
  assert.equal(stale.items[0].reason, 'sample_stale')
  assert.equal((await monitor.runOnce()).due, 0)
  now += 60_000
  assert.equal((await monitor.runOnce()).due, 0, 'next timer tick recognizes the successful query')
  assert.deepEqual(calls, [vm.id])
})

test('GPT monitor refreshes missing, pending, and elapsed samples using slot metadata', async () => {
  const now = Date.parse('2026-10-31T10:00:00.000Z')
  const cases = [
    {
      usage: { last_success_at: null, snapshot: { updated_at: new Date(now).toISOString() } },
      reason: 'never_sampled_official',
    },
    { usage: { windows: [{ id: '5h', used_percent: null }] }, reason: 'never_sampled_official' },
    { usage: { pending_refresh: true }, reason: 'quota_pending' },
    {
      usage: {
        last_success_at: new Date(now - 240_000).toISOString(),
        windows: [{ id: '5h', used_percent: 100, reset_at: new Date(now - 120_000).toISOString() }],
      },
      reason: 'extra_window_elapsed',
    },
  ]
  for (const { usage, reason } of cases) {
    const vm = codexSlot(now, usage)
    let calls = 0
    const monitor = createUsageProbeMonitor({
      now: () => now,
      listTargets: () => [vm],
      probeOne: async () => {
        calls++
        return { ok: true, source: 'openai-wham-usage' }
      },
    })
    const run = await monitor.runOnce()
    assert.equal(run.items[0].reason, reason)
    assert.equal(calls, 1)
  }
})

test('GPT capped windows refresh stale credits independently of fresh window samples', async () => {
  const startedAt = Date.parse('2026-10-31T10:00:00.000Z')
  const fresh = new Date(startedAt).toISOString()
  const old = new Date(startedAt - 300_000).toISOString()
  const cases = [
    { credits: { fetched_at: old, has_credits: true }, checkedAt: old, due: true },
    { credits: null, checkedAt: null, due: true },
    { credits: { fetched_at: fresh, has_credits: false }, checkedAt: old, due: false },
    { credits: { fetched_at: old, has_credits: true }, checkedAt: fresh, due: false },
    { credits: null, checkedAt: fresh, due: false },
  ]
  for (const { credits, checkedAt, due } of cases) {
    let now = startedAt
    const vm = {
      ...codexSlot(now, {
        windows: [{ id: '7d', used_percent: 100, reset_at: new Date(now + 86400_000).toISOString() }],
      }),
      codex_credits: credits,
      codex_credits_checked_at: checkedAt,
    }
    const calls = []
    const monitor = createUsageProbeMonitor({
      config: { stale_sec: 300 },
      now: () => now,
      listTargets: () => [vm],
      probeOne: async (slot) => {
        calls.push(slot.id)
        slot.codex_credits_checked_at = new Date(now).toISOString()
        return { ok: true, source: 'openai-wham-usage' }
      },
    })
    const run = await monitor.runOnce()
    assert.equal(run.due, Number(due))
    if (due) assert.equal(run.items[0].reason, 'credits_stale')
    assert.equal((await monitor.runOnce()).due, 0, 'a legal check with absent credits suppresses immediate repetition')
    now += 300_000
    vm.codex_usage.last_success_at = new Date(now).toISOString()
    const stale = await monitor.runOnce()
    assert.equal(stale.due, 1, 'new window headers do not refresh the independent credit observation')
    assert.equal(stale.items[0].reason, 'credits_stale')
    assert.equal(calls.length, Number(due) + 1)
  }
})

test('GPT authentication recovery bypasses sample freshness and reset delay, retaining failure backoff', async () => {
  let now = Date.parse('2026-10-31T10:00:00.000Z')
  const vm = {
    ...codexSlot(now, {
      last_success_at: new Date(now - 240_000).toISOString(),
      windows: [{ id: '5h', used_percent: 100, reset_at: new Date(now - 120_000).toISOString() }],
    }),
    auth_block: { reason: 'upstream_401' },
  }
  let calls = 0
  const monitor = createUsageProbeMonitor({
    config: { interval_sec: 60, stale_sec: 300, reset_delay_sec: 3600 },
    now: () => now,
    listTargets: () => [vm],
    probeOne: async () => {
      calls++
      return { ok: false }
    },
  })
  assert.equal((await monitor.runOnce()).items[0].reason, 'credential_recovery')
  assert.equal((await monitor.runOnce()).items[0].reason, 'probe_backoff')
  assert.equal(calls, 1)
  now += 60_000
  assert.equal((await monitor.runOnce()).items[0].reason, 'credential_recovery')
  assert.equal(calls, 2)
})
