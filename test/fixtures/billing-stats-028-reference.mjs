/**
 * Fixed billing read path from upstream 028 (77b72613c90f2eda0f90165d524d7a247b9d1974).
 * Keep this reference independent of UsageLogsRepo so regression tests need no
 * network or Git history. Only billing helpers and read methods are retained;
 * billingStats always computes a fresh snapshot for cache comparisons.
 */
import { emptyCostBucket, shanghaiDayStartIso, sumCostBuckets as sumCostColumns, UNPRICED_MODEL } from '../../src/lib/admin/pricing.mjs'
import { cacheHitStats } from '../../src/lib/admin/cache-metrics.mjs'
import { extraWindowSince, WINDOW_5H_MS, WINDOW_7D_MS } from '../../src/lib/pool/quota-window.mjs'
import { SLA_SUCCESS_PRED, SLA_ERROR_PRED, PROMPT_TOKENS_SQL, TOTAL_TOKENS_SQL, totalTokens } from '../../src/lib/db/repos/usage-log-preds.mjs'

const PRUNED_THROUGH_KEY = 'usage_logs_pruned_through'

function sumCostBuckets(rows) {
  return {
    ...sumCostColumns(rows),
    prompt_tokens: rows.reduce((sum, row) => sum + (Number(row.prompt_tokens) || 0), 0),
  }
}

function timeCond(since, until) {
  const where = []
  const params = []
  if (since) {
    where.push('created_at >= ?')
    params.push(new Date(since).toISOString())
  }
  if (until) {
    where.push('created_at <= ?')
    params.push(new Date(until).toISOString())
  }
  return { cond: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

function accountEventKey(row) {
  return `${row?.account_id || ''}\0${row?.vm_id || ''}`
}

function resolveAccountWindow(windows, row) {
  const list = Array.isArray(windows) ? windows : []
  return (
    list.find((w) => w.account_id === row.account_id && (w.vm_id || null) === (row.vm_id || null)) ||
    list.find((w) => w.account_id && w.account_id === row.account_id) ||
    list.find((w) => w.vm_id && w.vm_id === row.vm_id) ||
    null
  )
}

function groupCostEvents(rows = []) {
  const map = new Map()
  for (const row of rows) {
    const key = accountEventKey(row)
    const list = map.get(key) || []
    list.push(row)
    map.set(key, list)
  }
  return map
}

function isFableRow(row) {
  const upstream = String(row?.upstream_model ?? '').trim()
  const model = String(row?.model ?? '').trim()
  return (upstream || model).toLowerCase().includes('fable')
}

function unpricedWithTokens(row) {
  return row?.pricing_model === UNPRICED_MODEL && totalTokens(row) > 0
}

function bucketEventsSince(rows = [], sinceMs) {
  const since = Number(sinceMs)
  const picked = rows.filter((row) => {
    const at = Date.parse(row.created_at)
    return Number.isFinite(at) && (!Number.isFinite(since) || at >= since)
  })
  if (!picked.length) return { ...emptyCostBucket(), unpriced: 0 }
  return {
    ...sumCostBuckets(
      picked.map((row) => ({
        requests: 1,
        success: Number(row.success || 0),
        errors: Number(row.errors || 0),
        input_tokens: Number(row.input_tokens || 0),
        output_tokens: Number(row.output_tokens || 0),
        cache_read_tokens: Number(row.cache_read_tokens || 0),
        cache_creation_tokens: Number(row.cache_creation_tokens || 0),
        prompt_tokens: Number(row.prompt_tokens || 0),
        input_cost: Number(row.input_cost || 0),
        output_cost: Number(row.output_cost || 0),
        cache_read_cost: Number(row.cache_read_cost || 0),
        cache_creation_cost: Number(row.cache_creation_cost || 0),
        total_cost: Number(row.total_cost || 0),
      })),
    ),
    unpriced: picked.filter(unpricedWithTokens).length,
  }
}

export class ReferenceBillingRepo {
  constructor(db) { this.db = db }
  billingStats(opts = {}) { return this._computeBillingStats(opts) }

  _costSelect(cond, params) {
    const row = this.db
      .prepare(`
      SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
        COALESCE(SUM(input_cost), 0) AS input_cost,
        COALESCE(SUM(output_cost), 0) AS output_cost,
        COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
        COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
        COALESCE(SUM(total_cost), 0) AS total_cost,
        COALESCE(SUM(CASE WHEN pricing_model = '${UNPRICED_MODEL}' AND (${TOTAL_TOKENS_SQL}) > 0 THEN 1 ELSE 0 END), 0) AS unpriced
      FROM usage_logs ${cond}
    `)
      .get(...params)
    const out = {
      requests: Number(row?.requests || 0),
      input_tokens: Number(row?.input_tokens || 0),
      output_tokens: Number(row?.output_tokens || 0),
      cache_read_tokens: Number(row?.cache_read_tokens || 0),
      cache_creation_tokens: Number(row?.cache_creation_tokens || 0),
      prompt_tokens: Number(row?.prompt_tokens || 0),
      input_cost: Number(row?.input_cost || 0),
      output_cost: Number(row?.output_cost || 0),
      cache_read_cost: Number(row?.cache_read_cost || 0),
      cache_creation_cost: Number(row?.cache_creation_cost || 0),
      total_cost: Number(row?.total_cost || 0),
      unpriced: Number(row?.unpriced || 0),
    }
    return { ...out, ...cacheHitStats(out) }
  }

  costByAccount({ since = null, until = null } = {}) {
    const { cond, params } = timeCond(since, until)
    const rows = this.db
      .prepare(`
      SELECT
        COALESCE(NULLIF(final_account_id, ''), NULLIF(account_id, ''), vm_id, '—') AS account_id,
        vm_id,
        COUNT(*) AS requests,
        SUM(CASE WHEN ${SLA_SUCCESS_PRED} THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
        COALESCE(SUM(input_cost), 0) AS input_cost,
        COALESCE(SUM(output_cost), 0) AS output_cost,
        COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
        COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
        COALESCE(SUM(total_cost), 0) AS total_cost,
        COALESCE(SUM(CASE WHEN pricing_model = '${UNPRICED_MODEL}' AND (${TOTAL_TOKENS_SQL}) > 0 THEN 1 ELSE 0 END), 0) AS unpriced
      FROM usage_logs ${cond}
      GROUP BY 1, vm_id
      ORDER BY total_cost DESC
    `)
      .all(...params)
    return rows.map((r) => ({
      account_id: r.account_id,
      vm_id: r.vm_id || null,
      requests: Number(r.requests || 0),
      success: Number(r.success || 0),
      errors: Number(r.errors || 0),
      input_tokens: Number(r.input_tokens || 0),
      output_tokens: Number(r.output_tokens || 0),
      cache_read_tokens: Number(r.cache_read_tokens || 0),
      cache_creation_tokens: Number(r.cache_creation_tokens || 0),
      prompt_tokens: Number(r.prompt_tokens || 0),
      input_cost: Number(r.input_cost || 0),
      output_cost: Number(r.output_cost || 0),
      cache_read_cost: Number(r.cache_read_cost || 0),
      cache_creation_cost: Number(r.cache_creation_cost || 0),
      total_cost: Number(r.total_cost || 0),
      unpriced: Number(r.unpriced || 0),
    }))
  }

  _computeBillingStats({ accountWindows = null, now = Date.now() } = {}) {
    const todayStart = shanghaiDayStartIso()
    const fiveHStart = new Date(now - WINDOW_5H_MS).toISOString()
    const sevenDStart = new Date(now - WINDOW_7D_MS).toISOString()
    const accountsTotal = this.costByAccount()
    const accountsToday = this.costByAccount({ since: todayStart })
    // The per-account queries already cover every row. Re-sum them for the
    // global buckets instead of scanning the entire usage table two more times.
    // This matters on multi-GB databases where each synchronous full scan also
    // blocks unrelated HTTP requests on the Node event loop.
    const totalBucket = sumCostBuckets(accountsTotal)
    const todayBucket = sumCostBuckets(accountsToday)
    const total = { ...totalBucket, ...cacheHitStats(totalBucket) }
    const today = { ...todayBucket, ...cacheHitStats(todayBucket) }
    const keyOf = (a) => a.account_id + '\0' + (a.vm_id || '')
    const todayById = new Map(accountsToday.map((a) => [keyOf(a), a]))
    const aligned = Array.isArray(accountWindows) && accountWindows.length > 0
    let eventsSince = sevenDStart
    if (aligned) {
      let earliest = Date.parse(sevenDStart)
      for (const win of accountWindows) {
        for (const [reset, dur] of [
          [win.reset_5h, WINDOW_5H_MS],
          [win.reset_7d, WINDOW_7D_MS],
          [win.reset_7d_oi, WINDOW_7D_MS],
        ]) {
          const start = extraWindowSince(reset, dur, now)
          if (start != null && start < earliest) earliest = start
        }
      }
      eventsSince = new Date(earliest).toISOString()
    }
    const events = aligned ? this._costEventsSince(eventsSince) : null
    const fiveById = aligned ? null : new Map(this.costByAccount({ since: fiveHStart }).map((a) => [keyOf(a), a]))
    const sevenById = aligned ? null : new Map(this.costByAccount({ since: sevenDStart }).map((a) => [keyOf(a), a]))
    const eventsByKey = aligned ? groupCostEvents(events) : null
    const accounts = accountsTotal.map((a) => {
      const t = todayById.get(keyOf(a)) || emptyCostBucket()
      const win = aligned ? resolveAccountWindow(accountWindows, a) : null
      const since5 = aligned ? (extraWindowSince(win?.reset_5h, WINDOW_5H_MS, now) ?? Date.parse(fiveHStart)) : null
      const since7 = aligned ? (extraWindowSince(win?.reset_7d, WINDOW_7D_MS, now) ?? Date.parse(sevenDStart)) : null
      const w = aligned
        ? bucketEventsSince(eventsByKey.get(keyOf(a)) || [], since5)
        : fiveById.get(keyOf(a)) || emptyCostBucket()
      const w7 = aligned
        ? bucketEventsSince(eventsByKey.get(keyOf(a)) || [], since7)
        : sevenById.get(keyOf(a)) || emptyCostBucket()
      let window_fable = null
      if (aligned && win?.reset_7d_oi) {
        const sinceFable = extraWindowSince(win.reset_7d_oi, WINDOW_7D_MS, now) ?? Date.parse(sevenDStart)
        const fable = bucketEventsSince((eventsByKey.get(keyOf(a)) || []).filter(isFableRow), sinceFable)
        window_fable = {
          cost: Number(fable.total_cost || 0),
          tokens: totalTokens(fable),
          requests: Number(fable.requests || 0),
          unpriced: Number(fable.unpriced || 0),
          start: new Date(sinceFable).toISOString(),
        }
      }
      return {
        ...a,
        today: { ...t },
        window_5h: { ...w },
        window_7d: { ...w7 },
        today_cost: Number(t.total_cost || 0),
        today_requests: Number(t.requests || 0),
        today_input_tokens: Number(t.input_tokens || 0),
        today_output_tokens: Number(t.output_tokens || 0),
        today_cache_read_tokens: Number(t.cache_read_tokens || 0),
        today_cache_creation_tokens: Number(t.cache_creation_tokens || 0),
        today_input_cost: Number(t.input_cost || 0),
        today_output_cost: Number(t.output_cost || 0),
        today_cache_cost: Number(t.cache_read_cost || 0) + Number(t.cache_creation_cost || 0),
        window_5h_cost: Number(w.total_cost || 0),
        window_5h_requests: Number(w.requests || 0),
        window_5h_tokens: totalTokens(w),
        window_5h_unpriced: Number(w.unpriced || 0),
        window_5h_input_tokens: Number(w.input_tokens || 0),
        window_5h_output_tokens: Number(w.output_tokens || 0),
        window_5h_cache_read_tokens: Number(w.cache_read_tokens || 0),
        window_5h_cache_creation_tokens: Number(w.cache_creation_tokens || 0),
        window_5h_input_cost: Number(w.input_cost || 0),
        window_5h_output_cost: Number(w.output_cost || 0),
        window_5h_cache_cost: Number(w.cache_read_cost || 0) + Number(w.cache_creation_cost || 0),
        window_5h_start: aligned ? new Date(since5).toISOString() : fiveHStart,
        window_7d_cost: Number(w7.total_cost || 0),
        window_7d_requests: Number(w7.requests || 0),
        window_7d_success: Number(w7.success || 0),
        window_7d_errors: Number(w7.errors || 0),
        window_7d_tokens: totalTokens(w7),
        window_7d_unpriced: Number(w7.unpriced || 0),
        window_7d_start: aligned ? new Date(since7).toISOString() : sevenDStart,
        window_fable,
      }
    })
    const window5h = aligned
      ? {
          ...sumCostBuckets(accounts.map((a) => a.window_5h)),
          ...cacheHitStats(sumCostBuckets(accounts.map((a) => a.window_5h))),
        }
      : this._costSelect('WHERE created_at >= ?', [fiveHStart])
    const window7d = aligned
      ? {
          ...sumCostBuckets(accounts.map((a) => a.window_7d)),
          ...cacheHitStats(sumCostBuckets(accounts.map((a) => a.window_7d))),
        }
      : this._costSelect('WHERE created_at >= ?', [sevenDStart])
    const coverage = this.logCoverageStart()
    return {
      source: 'anthropic-official',
      currency: 'USD',
      today_start: todayStart,
      log_coverage_start: coverage,
      window_5h_start: aligned
        ? accounts.reduce((min, a) => (!min || a.window_5h_start < min ? a.window_5h_start : min), fiveHStart)
        : fiveHStart,
      window_7d_start: aligned
        ? accounts.reduce((min, a) => (!min || a.window_7d_start < min ? a.window_7d_start : min), sevenDStart)
        : sevenDStart,
      today,
      window_5h: window5h,
      window_7d: window7d,
      total,
      accounts,
    }
  }

  /**
   * Earliest instant whose traffic is still fully in usage_logs: the later of the DB's
   * creation (first migration) and the recorded prune boundary. Neither the oldest
   * surviving row (a quiet hour looks like a gap) nor the current retain_days (raising
   * it does not bring deleted rows back) can stand in for that boundary.
   */
  logCoverageStart() {
    const created = Date.parse(
      this.db.prepare("SELECT MIN(applied_at) AS t FROM schema_migrations WHERE version = '001'").get()?.t || '',
    )
    const pruned = Date.parse(this._prunedThrough() || '')
    const start = Math.max(Number.isFinite(created) ? created : -Infinity, Number.isFinite(pruned) ? pruned : -Infinity)
    return Number.isFinite(start) ? new Date(start).toISOString() : null
  }

  _prunedThrough() {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = '${PRUNED_THROUGH_KEY}'`).get()
    try {
      return row ? JSON.parse(row.value) : null
    } catch {
      return null
    }
  }

  _costEventsSince(since) {
    return this.db
      .prepare(
        `
      SELECT
        COALESCE(NULLIF(final_account_id, ''), NULLIF(account_id, ''), vm_id, '—') AS account_id,
        vm_id,
        created_at,
        model,
        upstream_model,
        pricing_model,
        CASE WHEN ${SLA_SUCCESS_PRED} THEN 1 ELSE 0 END AS success,
        CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END AS errors,
        COALESCE(input_tokens, 0) AS input_tokens,
        COALESCE(output_tokens, 0) AS output_tokens,
        COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
        COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
        (${PROMPT_TOKENS_SQL}) AS prompt_tokens,
        COALESCE(input_cost, 0) AS input_cost,
        COALESCE(output_cost, 0) AS output_cost,
        COALESCE(cache_read_cost, 0) AS cache_read_cost,
        COALESCE(cache_creation_cost, 0) AS cache_creation_cost,
        COALESCE(total_cost, 0) AS total_cost
      FROM usage_logs
      WHERE created_at >= ?
    `,
      )
      .all(since)
  }

}
