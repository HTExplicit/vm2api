import type { OpenaiApiView, Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { browserInputPoint } from './browser-input'
import {
  hasOpenaiApiFeature,
  isProApiAccount,
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
