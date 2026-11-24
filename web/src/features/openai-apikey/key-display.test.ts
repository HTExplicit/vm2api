import type { OpenaiApiKeyEntry } from '@/types/panel-openai-apikey'
import { describe, expect, it } from 'vitest'
import {
  balanceText,
  batchSummary,
  filterApiKeys,
  maskedKey,
  proxyAddress,
  proxyName,
  targetId,
} from './key-display'

const entry = (extra: Partial<OpenaiApiKeyEntry> = {}) =>
  ({
    vm_id: 'slot-one',
    account_id: 'account-a',
    email: 'one@example.test',
    slot_name: '东京账号',
    organization_id: 'org-one',
    organization_name: 'My Organization',
    enabled: true,
    has_key: true,
    claim_status: 'claimed',
    call_status: 'ready',
    balance: null,
    ...extra,
  }) as OpenaiApiKeyEntry

describe('OpenAi_api list display', () => {
  it('keeps unknown, negative and long decimal balances distinct without rounding', () => {
    expect(balanceText(null)).toBe('未知')
    expect(balanceText('93.3865591')).toBe('$93.38')
    expect(balanceText('-1.239')).toBe('$-1.23')
    expect(balanceText('-0.009')).toBe('$0')
    expect(maskedKey('sk-proj-abcd')).toBe('sk-proj-abcd…')
    expect(maskedKey(null)).toBe('••••••••')
    expect(maskedKey('short')).toBe('••••••••')
  })
  it('shows safe proxy names and addresses without falling back to internal IDs', () => {
    const proxy = {
      id: 'internal-proxy-id',
      name: '美国出口',
      host: 'safe.example.test',
      port: 1080,
      available: true,
    }
    expect(proxyName(proxy)).toBe('美国出口')
    expect(proxyName({ ...proxy, name: '' })).toBe('safe.example.test:1080')
    expect(proxyName({ ...proxy, name: '本地出口', host: null })).toBe(
      '本地出口'
    )
    expect(proxyAddress({ ...proxy, host: null })).toBe('')
    expect(proxyName({ ...proxy, name: '', host: null })).toBe('未绑定')
  })
  it('searches identity and combines configuration filters with call status', () => {
    const rows = [
      entry(),
      entry({
        account_id: 'account-b',
        email: 'two@example.test',
        slot_name: '法国账号',
        enabled: false,
        call_status: 'quota_blocked',
      }),
      entry({
        account_id: 'account-c',
        claim_status: 'pending',
        has_key: false,
        call_status: null,
      }),
    ]
    expect(filterApiKeys(rows, '  ONE@EXAMPLE ', 'all', 'all')).toEqual([
      rows[0],
      rows[2],
    ])
    expect(
      filterApiKeys(rows, 'My Organization', 'bound', 'quota_blocked')
    ).toEqual([rows[1]])
    expect(filterApiKeys(rows, '东京', 'bound', 'ready')).toEqual([rows[0]])
    expect(filterApiKeys(rows, '', 'pending', 'quota_blocked')).toEqual([])
    expect(filterApiKeys(rows, '', 'pending', 'all')).toEqual([rows[2]])
  })
  it('keeps selections separate when a slot changes account and counts partial results honestly', () => {
    expect(targetId(entry())).not.toBe(
      targetId(entry({ account_id: 'changed-account' }))
    )
    expect(
      batchSummary([
        { vm_id: 'one', account_id: 'a', status: 'done' },
        { vm_id: 'two', account_id: 'b', status: 'queued' },
        {
          vm_id: 'three',
          account_id: 'c',
          status: 'error',
          error: { code: 'changed', message: '账号已改变' },
        },
      ])
    ).toBe('已完成 1 · 已排队 1 · 失败 1')
  })
})
