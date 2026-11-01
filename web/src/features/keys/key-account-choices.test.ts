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
  it('shows configured keys at any balance and keeps selected accounts without a key removable', () => {
    const vms = [
      account('positive', '1.2'),
      account('zero', '0'),
      account('negative', '-0.1'),
      account('unknown', null),
      {
        ...account('missing', '10'),
        openai_api: { ...account('missing', '10').openai_api!, has_key: false },
      },
    ]
    expect(openaiApiAccountChoices(vms).map((vm) => vm.id)).toEqual([
      'positive',
      'zero',
      'negative',
      'unknown',
    ])
    expect(
      openaiApiAccountChoices(vms, ['missing'], ['missing']).map((vm) => vm.id)
    ).toEqual(['positive', 'zero', 'negative', 'unknown', 'missing'])
    expect(
      openaiApiAccountChoices(vms, ['missing'], []).map((vm) => vm.id)
    ).toEqual(['positive', 'zero', 'negative', 'unknown'])
  })
})
