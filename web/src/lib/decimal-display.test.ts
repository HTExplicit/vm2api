import { describe, expect, it } from 'vitest'
import { formatBalanceAmount, trimDecimalZeros } from './decimal-display'

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

describe('formatBalanceAmount', () => {
  it('truncates fractional digits without rounding or losing large integer precision', () => {
    expect(formatBalanceAmount('31.781779775')).toBe('31.78')
    expect(formatBalanceAmount('93.3865591')).toBe('93.38')
    expect(formatBalanceAmount('999.999')).toBe('999.99')
    expect(formatBalanceAmount('-1.239')).toBe('-1.23')
    expect(formatBalanceAmount('123456789012345678901234567890.129999')).toBe(
      '123456789012345678901234567890.12'
    )
  })

  it('retains zero trimming and normalizes signed amounts truncated to zero', () => {
    expect(formatBalanceAmount('37.000')).toBe('37')
    expect(formatBalanceAmount('12.309')).toBe('12.3')
    expect(formatBalanceAmount('0.009')).toBe('0')
    expect(formatBalanceAmount('-0.009')).toBe('0')
    expect(formatBalanceAmount('-0.019')).toBe('-0.01')
    expect(formatBalanceAmount(37)).toBe('37')
  })
})
