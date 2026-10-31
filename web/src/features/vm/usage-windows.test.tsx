import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CodexCreditSummary } from './codex-credit-summary'
import { VmUsageWindows } from './usage-windows'

function render(
  five: number | null,
  seven: number | null,
  pending = false,
  credits?: Vm['codex_credits']
) {
  const vm: Vm = {
    id: 'vm-fixture',
    platform: 'openai',
    family: 'codex',
    has_token: true,
    codex_credits: credits,
    utilization_5h: pending || five == null ? null : five / 100,
    utilization_7d: pending || seven == null ? null : seven / 100,
    codex_usage: {
      pending_refresh: pending,
      last_success_at: '2026-10-31T12:34:00Z',
      windows: [
        { id: '5h', used_percent: pending ? null : five },
        { id: '7d', used_percent: pending ? null : seven },
      ],
      last_success: pending
        ? {
            windows: [
              { id: '5h', used_percent: five },
              { id: '7d', used_percent: seven },
            ],
          }
        : null,
    },
  }
  return renderToStaticMarkup(<VmUsageWindows vm={vm} now={0} />)
}

describe('Codex quota readings after a quota error', () => {
  it('renders unknown readings as dashes, not fabricated 0% or 100%', () => {
    const html = render(null, null)
    expect(html.match(/>—</g)).toHaveLength(2)
    expect(html).not.toMatch(/>\d+%</)
  })

  it('renders a measured cap without inventing the missing window', () => {
    const html = render(100, null)
    expect(html).toContain('100%')
    expect(html.match(/>—</g)).toHaveLength(1)
  })

  it('renders real refreshed measurements normally', () => {
    const html = render(2, 32)
    expect(html).toContain('2%')
    expect(html).toContain('32%')
    expect(html).not.toContain('>—<')
    expect(html).not.toContain('待刷新')
  })

  it('keeps the last measurements and shows the pending refresh with its sample time', () => {
    const html = render(2, 32, true)
    expect(html).toContain('2%')
    expect(html).toContain('32%')
    expect(html).toContain('待刷新')
    expect(html).toContain('最近测量：')
    expect(html).toContain(new Date('2026-10-31T12:34:00Z').toLocaleString())
  })

  it('preserves the precise points balance and distinguishes available, unavailable and historical samples', () => {
    const sample = {
      has_credits: true,
      unlimited: false,
      balance: '12.345678901',
      fetched_at: '2026-10-31T12:34:00Z',
      invalidated_at: null,
      status: 'available' as const,
    }
    const available = render(100, 32, false, sample)
    expect(available).toContain('余额 12.345678901 点')
    expect(available).toContain('订阅额度已满，可使用点数')
    expect(available).toContain('100%')
    expect(available).not.toContain('$12')
    const historical = render(100, 32, false, {
      ...sample,
      status: 'pending',
    })
    expect(historical).toContain('历史余额 12.345678901 点')
    expect(historical).toContain('待确认')
    expect(historical).not.toContain('订阅额度已满，可使用点数')
    const zero = render(2, 32, false, {
      ...sample,
      has_credits: false,
      balance: '0',
      status: 'unavailable',
    })
    expect(zero).toContain('余额 0 点')
    expect(zero).toContain('点数不可用')
    expect(render(2, 32)).toContain('余额 未知')
    expect(render(2, 32, false, { ...sample, unlimited: true })).toContain(
      '余额 不限额'
    )
  })

  it('keeps compact balance facts and check time accessible without adding expiry information', () => {
    const checkedAt = '2026-10-31T12:35:00Z'
    const html = renderToStaticMarkup(
      <CodexCreditSummary
        compact
        vm={{
          id: 'vm-compact',
          platform: 'openai',
          has_token: true,
          codex_credits: {
            has_credits: true,
            unlimited: false,
            balance: '123.000456',
            fetched_at: '2026-10-31T12:34:00Z',
            invalidated_at: null,
            status: 'available',
          },
          codex_credits_checked_at: checkedAt,
        }}
      />
    )
    expect(html).toContain('余额 123.000456 点')
    expect(html).toContain('最近余额采样：')
    expect(html).toContain('最近检查：')
    expect(html).toContain(new Date(checkedAt).toLocaleString())
    expect(html).not.toContain('到期')
  })

  it('shows points and organization API balance together without trailing zeroes', () => {
    const html = renderToStaticMarkup(
      <CodexCreditSummary
        vm={{
          id: 'vm-api',
          platform: 'openai',
          has_token: true,
          codex_credits: {
            has_credits: true,
            unlimited: false,
            balance: '12.3400',
            status: 'available',
            fetched_at: '',
            invalidated_at: null,
          },
          openai_api: {
            pro_eligible: true,
            claim_status: 'claimed',
            setup_status: 'ready',
            has_key: true,
            enabled: true,
            balance: '37.000',
            balance_checked_at: '2026-10-31T12:34:00Z',
          },
        }}
      />
    )
    expect(html).toContain('余额 12.34 点')
    expect(html).toContain('API $37')
    expect(html).not.toContain('37.000')
    expect(html).not.toContain('12.3400')
  })

  it('keeps API balance visible without OAuth tokens and preserves failed refresh history', () => {
    const base: Vm = {
      id: 'vm-api',
      platform: 'openai',
      has_token: false,
      plan_type: 'free',
      openai_api: {
        pro_eligible: false,
        claim_status: 'claimed',
        setup_status: 'needs_login',
        has_key: true,
        enabled: true,
        balance: '12.345678901',
        balance_error: '需要重新登录',
      },
    }
    const html = renderToStaticMarkup(<CodexCreditSummary vm={base} />)
    expect(html).toContain('API $12.345678901')
    expect(html).toContain('待刷新')
    expect(html).not.toContain('点数不可用')
    const unknown = renderToStaticMarkup(
      <CodexCreditSummary
        vm={{ ...base, openai_api: { ...base.openai_api!, balance: null } }}
      />
    )
    expect(unknown).toContain('API 未知')
    expect(unknown).not.toContain('API $0')
  })
})
