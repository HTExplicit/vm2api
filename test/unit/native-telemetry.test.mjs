import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNativeTelemetry,
  telemetryUploadInterval,
  validateTelemetryRoutingPatch,
  TELEMETRY_UPLOAD_INTERVAL_DEFAULT,
} from '../../src/lib/vm/native-telemetry.mjs'

test('telemetryUploadInterval keeps whole-minute bounds and defaults to ten minutes', () => {
  assert.equal(telemetryUploadInterval({}), TELEMETRY_UPLOAD_INTERVAL_DEFAULT)
  assert.equal(telemetryUploadInterval({ telemetry: { upload_interval_seconds: 3600 } }), 3600)
  assert.equal(
    telemetryUploadInterval({ telemetry: { upload_interval_seconds: 3599 } }),
    TELEMETRY_UPLOAD_INTERVAL_DEFAULT,
  )
})

test('validateTelemetryRoutingPatch rejects non-minute and out-of-range intervals', () => {
  assert.deepEqual(validateTelemetryRoutingPatch({}), [])
  assert.deepEqual(validateTelemetryRoutingPatch({ telemetry: { upload_interval_seconds: 3600 } }), [])
  assert.ok(validateTelemetryRoutingPatch({ telemetry: { upload_interval_seconds: 90 } }).length)
})

test('buildNativeTelemetry binds proxy metadata and honors routing interval', () => {
  const vm = { proxy: { id: 'px-1', url: 'socks5h://127.0.0.1:1080' } }
  const cfg = buildNativeTelemetry(vm, '/tmp/project', { telemetry: { upload_interval_seconds: 7200 } })
  assert.equal(cfg.upload_interval_seconds, 7200)
  assert.equal(cfg.proxy_id, 'px-1')
  assert.equal(cfg.proxy_url, 'socks5h://127.0.0.1:1080')
  assert.equal(cfg.proxy_required, true)
})
