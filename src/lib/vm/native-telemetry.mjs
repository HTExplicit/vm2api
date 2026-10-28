/** Native VM telemetry configuration. Policy and identity stay inside cli-node. */
import { readRoutingConfigFile } from '../core/config.mjs'
import { boundProxyUrl, isLocalEgressProxy } from './egress.mjs'

export const TELEMETRY_UPLOAD_INTERVAL_DEFAULT = 600
export const TELEMETRY_UPLOAD_INTERVAL_MIN = 60
export const TELEMETRY_UPLOAD_INTERVAL_MAX = 86_400

/** routing.telemetry.upload_interval_seconds, whole minutes within 1 min–24 h; otherwise the 10 min default. */
export function telemetryUploadInterval(routing) {
  const raw = routing?.telemetry?.upload_interval_seconds
  const n = typeof raw === 'number' ? raw : Number.NaN
  if (Number.isInteger(n) && n % 60 === 0 && n >= TELEMETRY_UPLOAD_INTERVAL_MIN && n <= TELEMETRY_UPLOAD_INTERVAL_MAX)
    return n
  return TELEMETRY_UPLOAD_INTERVAL_DEFAULT
}

export function validateTelemetryRoutingPatch(body = {}) {
  if (!body || typeof body !== 'object' || body.telemetry == null) return []
  if (typeof body.telemetry !== 'object' || Array.isArray(body.telemetry)) return ['telemetry 必须是对象']
  if (!Object.hasOwn(body.telemetry, 'upload_interval_seconds')) return []
  const n = body.telemetry.upload_interval_seconds
  if (!Number.isInteger(n) || n % 60 !== 0 || n < TELEMETRY_UPLOAD_INTERVAL_MIN || n > TELEMETRY_UPLOAD_INTERVAL_MAX) {
    return ['telemetry.upload_interval_seconds 必须是 60–86400 之间、60 的整数倍']
  }
  return []
}

function routingFor(projectRoot, routing) {
  if (routing) return routing
  try {
    return readRoutingConfigFile(projectRoot)
  } catch {
    return null
  }
}

/** Keep the real bound route even when inference uses transparent egress. */
export function buildNativeTelemetry(vm, projectRoot, routing = null) {
  const local = isLocalEgressProxy(vm?.proxy)
  const proxyUrl = local ? '' : boundProxyUrl(vm?.proxy) || ''
  return {
    upload_interval_seconds: telemetryUploadInterval(routingFor(projectRoot, routing)),
    proxy_id: String(vm?.proxy?.id || '').trim() || null,
    proxy_url: proxyUrl,
    // Only an explicitly bound local exit permits direct telemetry.
    proxy_required: !local,
  }
}
