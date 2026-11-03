import type { OpenaiApiKeyEntry } from '@/types/panel-openai-apikey'
import { describe, expect, it } from 'vitest'
import {
  balanceText,
  batchSummary,
  filterApiKeys,
  maskedKey,
  proxyAddress,
  proxyDescription,
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
    expect(proxyDescription(proxy)).toBe('美国出口 · safe.example.test:1080')
    expect(proxyName({ ...proxy, name: '' })).toBe('safe.example.test:1080')
    expect(proxyName({ ...proxy, name: '本地出口', host: null })).toBe(
      '本地出口'
    )
    expect(proxyAddress({ ...proxy, host: null })).toBe('')
    expect(proxyName({ ...proxy, name: '', host: null })).toBe('未绑定')
    expect(proxyDescription({ ...proxy, name: '已改名出口' })).toContain(
      '已改名出口'
    )
  })
  it('searches slot, email and organization and combines status with intended switch', () => {
    const rows = [
      entry(),
      entry({
        account_id: 'account-b',
        email: 'two@example.test',
        slot_name: '法国账号',
        enabled: false,
        call_status: 'quota_blocked',
      }),
    ]
    expect(filterApiKeys(rows, '  ONE@EXAMPLE ', 'all', 'all')).toEqual([
      rows[0],
    ])
    expect(
      filterApiKeys(rows, 'My Organization', 'off', 'quota_blocked')
    ).toEqual([rows[1]])
    expect(filterApiKeys(rows, '东京', 'on', 'ready')).toEqual([rows[0]])
    expect(filterApiKeys(rows, '', 'on', 'quota_blocked')).toEqual([])
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
