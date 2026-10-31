/**
 * Codex usage contract aligned with sub2api OpenAICodexUsageSnapshot.
 *
 * extra keys (direct used %, never inverted):
 *   codex_5h_used_percent / codex_7d_used_percent
 *   codex_primary_* (7d by default) / codex_secondary_* (5h by default)
 * Normalize() maps primary/secondary by window_minutes like sub2api.
 */

function num(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function int(value) {
  const n = num(value)
  return n == null ? null : Math.trunc(n)
}

/**
 * Live `x-codex-*` rate-limit headers -> extra keys.
 *
 * The ChatGPT Codex backend stamps the metered windows on every Responses
 * reply (the 429 included). `-reset-at` is absolute unix seconds; older
 * builds only send the relative `-reset-after-seconds`, so both are read and
 * the absolute form wins. Window lengths are never assumed: `window_minutes`
 * decides which side is the 5h and which is the 7d window.
 */
export function extraFromCodexHeaders(headers = {}, now = Date.now()) {
  const h = lowerHeaders(headers)
  if (!h) return null
  const extra = {}
  let seen = false
  for (const role of ['primary', 'secondary']) {
    const used = num(h[`x-codex-${role}-used-percent`])
    const minutes = int(h[`x-codex-${role}-window-minutes`])
    const resetAtEpoch = int(h[`x-codex-${role}-reset-at`])
    const resetAfter = int(h[`x-codex-${role}-reset-after-seconds`])
    if (used == null) continue
    seen = true
    const resetMs =
      resetAtEpoch != null && resetAtEpoch > 0
        ? resetAtEpoch * 1000
        : resetAfter != null
          ? now + resetAfter * 1000
          : null
    extra[`codex_${role}_used_percent`] = used
    if (minutes != null) extra[`codex_${role}_window_minutes`] = minutes
    if (resetMs != null) {
      extra[`codex_${role}_reset_at`] = new Date(resetMs).toISOString()
      extra[`codex_${role}_reset_after_seconds`] = resetAfter ?? Math.max(0, Math.round((resetMs - now) / 1000))
    }
  }
  if (!seen) return null
  const overSecondary = num(h['x-codex-primary-over-secondary-limit-percent'])
  if (overSecondary != null) extra.codex_primary_over_secondary_percent = overSecondary
  const reached = String(h['x-codex-rate-limit-reached-type'] || '').trim()
  extra.codex_rate_limit_reached_type = reached || null
  extra.codex_usage_updated_at = new Date(now).toISOString()
  return extra
}

/** Fallback park when upstream says "spent" but ships no reset clock. */
export const CODEX_DEFAULT_PARK_MS = 60_000

/**
 * Park verdict for a slot: a window at its cap with a future reset, or an
 * explicit `usage_limit_reached`, means the credential is spent until the
 * soonest window reset. `waiveWindowCaps` (spendable credits) ignores the
 * window caps; an explicit park still holds.
 */
export function codexQuotaPark(extra = {}, now = Date.now(), { waiveWindowCaps = false } = {}) {
  const limits = normalizeCodexLimits(extraToCodexSnapshot(extra))
  let until = null
  let liveCap = false
  for (const key of waiveWindowCaps ? [] : ['5h', '7d']) {
    const used = num(limits[`used_${key}_percent`])
    const resetMs = Date.parse(limits[`reset_${key}_at`] || '')
    if (used == null || used < 100) continue
    if (Number.isFinite(resetMs) && resetMs <= now) continue
    liveCap = true
    if (Number.isFinite(resetMs) && resetMs > now && (until == null || resetMs < until)) until = resetMs
  }
  const manual = Date.parse(extra?.codex_limited_until || '')
  const manualLive = Number.isFinite(manual) && manual > now
  if (manualLive && (until == null || manual < until)) until = manual
  if (liveCap && until == null && !Number.isFinite(manual)) until = now + CODEX_DEFAULT_PARK_MS
  return { limited: until != null, until }
}

/**
 * How long a credits reading may waive the window caps. Each Responses reply
 * refreshes it, so only an idle or parked slot ages out.
 */
export const CODEX_CREDITS_TTL_MS = 10 * 60_000

function flag(value) {
  if (typeof value === 'boolean') return value
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
  if (text === 'true' || text === '1') return true
  if (text === 'false' || text === '0') return false
  return null
}

function creditBalance(value) {
  if (typeof value === 'string') return value.trim() || null
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

/**
 * ChatGPT credits (`/wham/usage` `credits`, or `x-codex-credits-*` headers).
 * Both flags are required, as in the Codex CLI. `balance` stays a string so a
 * long decimal is never rounded through a float.
 */
export function normalizeCodexCredits(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null
  const hasCredits = flag(raw.has_credits ?? raw.hasCredits)
  const unlimited = flag(raw.unlimited)
  if (hasCredits == null || unlimited == null) return null
  return {
    has_credits: hasCredits,
    unlimited,
    balance: creditBalance(raw.balance),
    fetched_at: new Date(now).toISOString(),
  }
}

export function codexCreditsFromHeaders(headers = {}, now = Date.now()) {
  const h = lowerHeaders(headers)
  if (!h) return null
  return normalizeCodexCredits(
    {
      has_credits: h['x-codex-credits-has-credits'],
      unlimited: h['x-codex-credits-unlimited'],
      balance: h['x-codex-credits-balance'],
    },
    now,
  )
}

/**
 * A fresh reading that says the account can still buy past its 5h/7d windows.
 * It only earns the slot another try; the upstream 429 stays the authority.
 */
export function hasSpendableCodexCredits(vm, now = Date.now()) {
  const credits = vm?.codex?.credits ?? vm?.codex_credits
  if (credits?.invalidated_at) return false
  const fetchedAt = Date.parse(credits?.fetched_at || '')
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > CODEX_CREDITS_TTL_MS) return false
  return credits.unlimited === true || credits.has_credits === true
}

/** Public point balance and the same freshness verdict used by admission. */
export function codexCreditsView(credits, now = Date.now()) {
  if (!credits) return null
  const fetchedAt = Date.parse(credits.fetched_at || '')
  const pending = !!credits.invalidated_at || (Number.isFinite(fetchedAt) && now - fetchedAt > CODEX_CREDITS_TTL_MS)
  return {
    has_credits: credits.has_credits,
    unlimited: credits.unlimited,
    balance: credits.balance ?? null,
    fetched_at: credits.fetched_at || null,
    invalidated_at: credits.invalidated_at || null,
    status: pending
      ? 'pending'
      : !Number.isFinite(fetchedAt)
        ? 'unknown'
        : credits.has_credits || credits.unlimited
          ? 'available'
          : 'unavailable',
  }
}

function lowerHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value)
  }
  return out
}

export function extraToCodexSnapshot(extra = {}) {
  if (!extra || typeof extra !== 'object') return emptySnapshot()
  const primaryWindow = primaryIsFiveHour(
    num(extra.codex_primary_window_minutes),
    num(extra.codex_secondary_window_minutes),
  )
    ? '5h'
    : '7d'
  const secondaryWindow = primaryWindow === '5h' ? '7d' : '5h'
  return {
    primary_used_percent: num(
      Object.hasOwn(extra, 'codex_primary_used_percent')
        ? extra.codex_primary_used_percent
        : extra[`codex_${primaryWindow}_used_percent`],
    ),
    primary_reset_after_seconds: int(
      extra.codex_primary_reset_after_seconds ?? extra[`codex_${primaryWindow}_reset_after_seconds`],
    ),
    primary_window_minutes: int(extra.codex_primary_window_minutes ?? extra[`codex_${primaryWindow}_window_minutes`]),
    primary_reset_at: extra.codex_primary_reset_at || extra[`codex_${primaryWindow}_reset_at`] || null,
    secondary_used_percent: num(
      Object.hasOwn(extra, 'codex_secondary_used_percent')
        ? extra.codex_secondary_used_percent
        : extra[`codex_${secondaryWindow}_used_percent`],
    ),
    secondary_reset_after_seconds: int(
      extra.codex_secondary_reset_after_seconds ?? extra[`codex_${secondaryWindow}_reset_after_seconds`],
    ),
    secondary_window_minutes: int(
      extra.codex_secondary_window_minutes ?? extra[`codex_${secondaryWindow}_window_minutes`],
    ),
    secondary_reset_at: extra.codex_secondary_reset_at || extra[`codex_${secondaryWindow}_reset_at`] || null,
    primary_over_secondary_percent: num(extra.codex_primary_over_secondary_percent),
    updated_at: extra.codex_usage_updated_at || extra.updated_at || null,
  }
}

function emptySnapshot() {
  return {
    primary_used_percent: null,
    primary_reset_after_seconds: null,
    primary_window_minutes: null,
    primary_reset_at: null,
    secondary_used_percent: null,
    secondary_reset_after_seconds: null,
    secondary_window_minutes: null,
    secondary_reset_at: null,
    primary_over_secondary_percent: null,
    updated_at: null,
  }
}

function primaryIsFiveHour(primaryMins, secondaryMins) {
  if (primaryMins != null && secondaryMins != null) return primaryMins < secondaryMins
  if (primaryMins != null) return primaryMins <= 360
  if (secondaryMins != null) return secondaryMins > 360
  return false
}

export function normalizeCodexLimits(snapshot = {}) {
  const fiveFromPrimary = primaryIsFiveHour(
    num(snapshot.primary_window_minutes),
    num(snapshot.secondary_window_minutes),
  )
  if (fiveFromPrimary) {
    return {
      used_5h_percent: snapshot.primary_used_percent,
      reset_5h_seconds: snapshot.primary_reset_after_seconds,
      window_5h_minutes: snapshot.primary_window_minutes ?? 300,
      reset_5h_at: snapshot.primary_reset_at,
      used_7d_percent: snapshot.secondary_used_percent,
      reset_7d_seconds: snapshot.secondary_reset_after_seconds,
      window_7d_minutes: snapshot.secondary_window_minutes ?? 10080,
      reset_7d_at: snapshot.secondary_reset_at,
    }
  }
  return {
    used_5h_percent: snapshot.secondary_used_percent,
    reset_5h_seconds: snapshot.secondary_reset_after_seconds,
    window_5h_minutes: snapshot.secondary_window_minutes ?? 300,
    reset_5h_at: snapshot.secondary_reset_at,
    used_7d_percent: snapshot.primary_used_percent,
    reset_7d_seconds: snapshot.primary_reset_after_seconds,
    window_7d_minutes: snapshot.primary_window_minutes ?? 10080,
    reset_7d_at: snapshot.primary_reset_at,
  }
}

function pctToRatio(percent) {
  if (percent == null) return null
  return Math.max(0, Math.min(1, Number(percent) / 100))
}

export function codexLimitsToQuota(limits = {}) {
  return {
    utilization_5h: pctToRatio(limits.used_5h_percent),
    utilization_7d: pctToRatio(limits.used_7d_percent),
    reset_5h: limits.reset_5h_at || null,
    reset_7d: limits.reset_7d_at || null,
    status_5h: statusFromPercent(limits.used_5h_percent),
    status_7d: statusFromPercent(limits.used_7d_percent),
  }
}

function statusFromPercent(percent) {
  if (percent == null) return null
  if (percent >= 100) return 'limited'
  if (percent >= 90) return 'warn'
  if (percent >= 75) return 'caution'
  return 'ok'
}

function isCodexSnapshot(value) {
  return !!value && typeof value === 'object' && Object.hasOwn(value, 'primary_used_percent')
}

/** Accepts extra, a snapshot, or a previously built view (`{ snapshot, ... }`). */
export function buildCodexUsageView(extraOrSnapshot = {}) {
  const input = extraOrSnapshot && typeof extraOrSnapshot === 'object' ? extraOrSnapshot : {}
  const snapshot = isCodexSnapshot(input)
    ? input
    : isCodexSnapshot(input.snapshot)
      ? input.snapshot
      : extraToCodexSnapshot(input)
  const limits = normalizeCodexLimits(snapshot)
  const quota = codexLimitsToQuota(limits)
  return {
    snapshot,
    limits,
    quota,
    unit: 'percent_used',
    windows: [
      {
        id: '5h',
        label: '5h',
        used_percent: limits.used_5h_percent,
        reset_at: limits.reset_5h_at,
        reset_after_seconds: limits.reset_5h_seconds,
        window_minutes: limits.window_5h_minutes,
      },
      {
        id: '7d',
        label: '7d',
        used_percent: limits.used_7d_percent,
        reset_at: limits.reset_7d_at,
        reset_after_seconds: limits.reset_7d_seconds,
        window_minutes: limits.window_7d_minutes,
      },
    ],
  }
}

/** Keep the legacy aliases aligned with the merged, authoritative windows. */
export function normalizeCodexExtra(extra = {}) {
  const limits = normalizeCodexLimits(extraToCodexSnapshot(extra))
  const merged = { ...extra }
  for (const key of ['5h', '7d']) {
    merged[`codex_${key}_used_percent`] = limits[`used_${key}_percent`]
    merged[`codex_${key}_reset_after_seconds`] = limits[`reset_${key}_seconds`]
    merged[`codex_${key}_window_minutes`] = limits[`window_${key}_minutes`]
    merged[`codex_${key}_reset_at`] = limits[`reset_${key}_at`]
  }
  return merged
}

function hasUsageSample(view) {
  return view?.windows?.some((window) => window.used_percent != null) === true
}

/** Last measured windows are display-only; the root quota always remains authoritative. */
export function codexUsageWithSample(extra, previous = {}, { sampledAt = null, pendingReason = null } = {}) {
  const current = buildCodexUsageView(extra)
  const old = previous.last_success || (hasUsageSample(previous) ? buildCodexUsageView(previous) : null)
  let sample = old
  if (sampledAt && hasUsageSample(current)) {
    const sampleExtra = { codex_usage_updated_at: sampledAt }
    for (const key of ['5h', '7d']) {
      const measured = current.windows.find((window) => window.id === key)
      const window = measured.used_percent != null ? measured : old?.windows?.find((item) => item.id === key)
      if (!window) continue
      sampleExtra[`codex_${key}_used_percent`] = window.used_percent
      sampleExtra[`codex_${key}_reset_at`] = window.reset_at
      sampleExtra[`codex_${key}_reset_after_seconds`] = window.reset_after_seconds
      sampleExtra[`codex_${key}_window_minutes`] = window.window_minutes
    }
    sample = buildCodexUsageView(sampleExtra)
  }
  const missing =
    sample?.windows?.some(
      (window) =>
        window.used_percent != null && current.windows.find((item) => item.id === window.id)?.used_percent == null,
    ) === true
  const pending = !!pendingReason || missing || (!sampledAt && previous.pending_refresh === true)
  return {
    ...current,
    pending_refresh: pending,
    pending_reason: pending ? pendingReason || previous.pending_reason || 'quota_sample_missing' : null,
    last_success_at: sampledAt || previous.last_success_at || sample?.snapshot?.updated_at || null,
    last_success: sample,
  }
}
