import type { OpenaiApiView, Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { browserInputPoint } from './browser-input'
import {
  hasOpenaiApiFeature,
  isProApiAccount,
  isOpenaiApiKeyCandidate,
  isOpenaiApiBalancePending,
  openaiApiClaimLabel,
  openaiApiClaimLocked,
} from './openai-api-state'

const vm: Vm = { id: 'a', platform: 'openai', family: 'codex' }
const state: OpenaiApiView = {
  pro_eligible: true,
  claim_status: 'unknown',
  enabled: false,
  has_key: false,
  setup_status: 'idle',
  balance: null,
}

describe('account API feature gates', () => {
  it('recognizes exactly the three Pro tiers and their credential spellings', () => {
    for (const plan_type of [
      'prolite',
      'pro',
      'promax',
      'chatgptprolite',
      'chatgptpro',
      'chatgptpromax',
    ]) {
      expect(isProApiAccount({ ...vm, plan_type })).toBe(true)
    }
    for (const plan_type of [
      'free',
      'plus',
      'team',
      'business',
      'edu',
      'chatgptteamplan',
      'enterprise',
      'pro-trial',
    ]) {
      expect(isProApiAccount({ ...vm, plan_type })).toBe(false)
    }
    expect(
      isProApiAccount({ ...vm, plan_type: null, chatgpt_plan_type: 'prolite' })
    ).toBe(true)
    expect(
      isProApiAccount({
        ...vm,
        plan_type: 'pro',
        openai_api: { ...state, pro_eligible: false },
      })
    ).toBe(false)
    expect(
      isProApiAccount({
        ...vm,
        platform: 'claude',
        family: 'claude',
        plan_type: 'pro',
      })
    ).toBe(false)
  })

  it('locks pending and claimed accounts without depending on Pro or OAuth state', () => {
    expect(openaiApiClaimLocked({ ...state, claim_status: 'pending' })).toBe(
      true
    )
    expect(openaiApiClaimLocked({ ...state, claim_status: 'claimed' })).toBe(
      true
    )
    expect(openaiApiClaimLocked({ ...state, claim_status: 'eligible' })).toBe(
      false
    )
    expect(
      openaiApiClaimLabel({ ...state, claim_status: 'claimed' })
    ).toContain('后续按期自动发放')
    expect(openaiApiClaimLabel({ ...state, claim_status: 'pending' })).toBe(
      '发放中'
    )
    expect(
      hasOpenaiApiFeature({
        ...vm,
        plan_type: 'free',
        has_token: false,
        status: 'stopped',
        openai_api: { ...state, pro_eligible: false, has_key: true },
      })
    ).toBe(true)
    expect(
      hasOpenaiApiFeature({
        ...vm,
        plan_type: 'free',
        openai_api: { ...state, pro_eligible: false, claim_status: 'claimed' },
      })
    ).toBe(true)
    expect(hasOpenaiApiFeature({ ...vm, plan_type: 'free' })).toBe(false)
  })

  it('offers configured account keys independently of balance, subscription and API state', () => {
    for (const balance of ['37.000', '0', '-1.25', null, '', 'NaN']) {
      expect(
        isOpenaiApiKeyCandidate({
          ...vm,
          plan_type: 'free',
          openai_api: {
            ...state,
            has_key: true,
            enabled: false,
            quota_blocked: true,
            balance,
            balance_error: '待登录',
          },
        })
      ).toBe(true)
    }
    expect(
      isOpenaiApiKeyCandidate({
        ...vm,
        openai_api: { ...state, balance: '37', has_key: false },
      })
    ).toBe(false)
    expect(
      isOpenaiApiKeyCandidate({
        ...vm,
        family: 'claude',
        platform: 'anthropic',
        openai_api: { ...state, balance: '37', has_key: true },
      })
    ).toBe(false)
  })

  it('marks old successful balances pending without discarding the candidate', () => {
    const now = Date.parse('2026-11-01T00:10:00Z')
    const current = {
      ...state,
      balance: '37',
      balance_checked_at: '2026-11-01T00:09:00Z',
    }
    expect(isOpenaiApiBalancePending(current, now)).toBe(false)
    expect(
      isOpenaiApiBalancePending({ ...current, balance_error: '需要登录' }, now)
    ).toBe(true)
    expect(
      isOpenaiApiBalancePending(
        { ...current, balance_checked_at: '2026-11-01T00:00:00Z' },
        now
      )
    ).toBe(true)
    expect(
      isOpenaiApiBalancePending(
        { ...current, balance_checked_at: undefined },
        now
      )
    ).toBe(true)
    expect(isOpenaiApiBalancePending({ ...current, balance: null }, now)).toBe(
      false
    )
    expect(
      openaiApiClaimLabel({
        ...state,
        claim_status: 'eligible',
        offer_stale: true,
      })
    ).toBe('资格已过期，请重新查询')
  })

  it('uses the configured refresh interval and keeps manual-only samples independent of age', () => {
    const now = Date.parse('2026-11-01T00:30:00Z')
    const sample = {
      ...state,
      balance: '-0.01',
      balance_checked_at: '2026-11-01T00:10:00Z',
      balance_refresh_interval_minutes: 30,
    }
    expect(isOpenaiApiBalancePending(sample, now)).toBe(false)
    expect(isOpenaiApiBalancePending(sample, now + 10 * 60_000)).toBe(true)
    const manual = { ...sample, balance_refresh_interval_minutes: 0 }
    expect(isOpenaiApiBalancePending(manual, now + 24 * 60 * 60_000)).toBe(
      false
    )
    expect(
      isOpenaiApiBalancePending(
        { ...manual, balance_checked_at: undefined },
        now
      )
    ).toBe(false)
    expect(
      isOpenaiApiBalancePending({ ...manual, balance_error: '查询失败' }, now)
    ).toBe(true)
  })

  it('scales browser interaction coordinates into the actual remote viewport', () => {
    expect(
      browserInputPoint(
        260,
        170,
        { left: 10, top: 20, width: 500, height: 300 },
        { width: 1000, height: 600 }
      )
    ).toEqual({ x: 500, y: 300 })
  })
})
