import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { openaiApiAccountChoices } from './key-account-choices'

const account = (id: string, balance: string | null): Vm => ({
  id,
  family: 'codex',
  plan_type: 'free',
  openai_api: {
    pro_eligible: false,
    claim_status: 'claimed',
    setup_status: 'ready',
    enabled: false,
    has_key: true,
    balance,
  },
})

describe('OpenAI API key account choices', () => {
  it('shows only funded new choices and keeps selected old choices removable', () => {
    const vms = [
      account('positive', '1.2'),
      account('zero', '0'),
      account('negative', '-0.1'),
      account('unknown', null),
    ]
    expect(openaiApiAccountChoices(vms).map((vm) => vm.id)).toEqual([
      'positive',
    ])
    expect(
      openaiApiAccountChoices(
        vms,
        ['zero', 'unknown'],
        ['zero', 'unknown']
      ).map((vm) => vm.id)
    ).toEqual(['positive', 'zero', 'unknown'])
    expect(
      openaiApiAccountChoices(vms, ['zero', 'unknown'], ['unknown']).map(
        (vm) => vm.id
      )
    ).toEqual(['positive', 'unknown'])
    expect(
      openaiApiAccountChoices(vms, [], ['zero']).map((vm) => vm.id)
    ).toEqual(['positive'])
  })
})
