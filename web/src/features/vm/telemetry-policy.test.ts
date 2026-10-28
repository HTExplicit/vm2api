import { describe, expect, it } from 'vitest'
import { telemetryEnabled, telemetrySeedFlags } from './telemetry-policy'

describe('telemetry reads one bit', () => {
  it('is on only when telemetry_disabled is false', () => {
    expect(telemetryEnabled({ telemetry_disabled: false })).toBe(true)
    expect(telemetryEnabled({ telemetry_disabled: true })).toBe(false)
    expect(telemetryEnabled({})).toBe(false)
    expect(telemetryEnabled(undefined)).toBe(false)
    expect(telemetryEnabled({ telemetry_disabled: 'false' })).toBe(false)
  })

  it('derives the other flags from that bit', () => {
    expect(telemetrySeedFlags(true)).toEqual({
      telemetry_disabled: false,
      disable_nonessential_traffic: true,
      do_not_track: false,
    })
    expect(telemetrySeedFlags(false)).toEqual({
      telemetry_disabled: true,
      disable_nonessential_traffic: false,
      do_not_track: true,
    })
  })
})
