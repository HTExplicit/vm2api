import type { OpenaiApiView } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  OpenaiApiCreditDetails,
  openaiApiCreditDetailRows,
} from './openai-api-credit-details'

const state: OpenaiApiView = {
  pro_eligible: false,
  claim_status: 'claimed',
  enabled: false,
  has_key: true,
  setup_status: 'ready',
  balance: '37.000',
}

describe('organization API balance details', () => {
  it('keeps precise purchased and expiring balances without fabricating unknown values', () => {
    expect(openaiApiCreditDetailRows(state)).toEqual([])
    const html = renderToStaticMarkup(
      <OpenaiApiCreditDetails
        state={{
          ...state,
          paid_balance: '0.000',
          next_expiring_amount: '12.3400000000000000001',
          next_expiring_at: '2026-11-12T03:36:08Z',
        }}
      />
    )
    expect(html).toContain('购买余额')
    expect(html).toContain('$0')
    expect(html).toContain('最近到期额度')
    expect(html).toContain('$12.3400000000000000001')
    expect(html).toContain(new Date('2026-11-12T03:36:08Z').toLocaleString())
    expect(html).not.toContain('0.000')
  })
})
