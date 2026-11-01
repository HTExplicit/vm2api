const DEFAULT_INTERVAL_MINUTES = 10

export function balanceRefreshIntervalMinutes(routing = {}) {
  const value = routing?.openai_api?.balance_refresh_interval_minutes
  return Number.isInteger(value) && value >= 0 && value <= 1440 ? value : DEFAULT_INTERVAL_MINUTES
}

export function normalizeOpenaiApiConfig(value) {
  const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return { ...config, balance_refresh_interval_minutes: balanceRefreshIntervalMinutes({ openai_api: config }) }
}

export function validateOpenaiApiPatch(patch) {
  if (patch === undefined) return
  const value = patch?.balance_refresh_interval_minutes
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    (Object.hasOwn(patch, 'balance_refresh_interval_minutes') &&
      (!Number.isInteger(value) || value < 0 || value > 1440))
  ) {
    throw Object.assign(new RangeError('API 余额刷新间隔必须为 0–1440 的整数分钟，0 表示仅手动刷新'), {
      code: 'invalid_openai_api_config',
      status: 400,
    })
  }
}
