import { describe, expect, it } from 'vitest'
import { trimDecimalZeros } from './decimal-display'

describe('trimDecimalZeros', () => {
  it('removes fractional trailing zeroes while preserving effective precision', () => {
    expect(trimDecimalZeros('37.000')).toBe('37')
    expect(trimDecimalZeros('12.3400')).toBe('12.34')
    expect(trimDecimalZeros('0.000')).toBe('0')
    expect(trimDecimalZeros('-0.000')).toBe('0')
    expect(trimDecimalZeros('123.000456')).toBe('123.000456')
    expect(trimDecimalZeros('12.345678901')).toBe('12.345678901')
    expect(trimDecimalZeros('100')).toBe('100')
    expect(trimDecimalZeros(37)).toBe('37')
  })
})
