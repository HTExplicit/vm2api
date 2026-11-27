import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CodexCreditSummary } from './codex-credit-summary'
import { ClaudeQuotaObservations, VmUsageWindows } from './usage-windows'
import { vmWindows } from './vm-rack-model'
import { windowTiming } from './window-timing'

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

describe('Claude official quota observations', () => {
  const snapshot = {
    official: {
      updated_at: '2026-11-01T00:00:00Z',
      '5h': {
        utilization: null,
        sampled_at: null,
        reset: null,
        status: null,
        stale: false,
      },
      '7d': {
        utilization: 0,
        sampled_at: null,
        reset: null,
        status: 'allowed',
        stale: false,
      },
    },
    passive: {
      '5h': null,
      '7d': {
        utilization: 0.76,
        sampled_at: '2026-10-31T00:00:00Z',
        reset: null,
        status: 'allowed_warning',
        stale: false,
      },
    },
  }
  function claude(overrides = {}) {
    return renderToStaticMarkup(
      <ClaudeQuotaObservations
        vm={
          {
            id: 'fixture',
            has_token: true,
            platform: 'anthropic',
            utilization_7d: 0.76,
            quota_observations: snapshot,
            ...overrides,
          } as Vm
        }
        now={Date.parse('2026-11-01T00:05:00Z')}
      />
    )
  }
  it('keeps VmUsageWindows clean for rack baseline alignment', () => {
    const html = renderToStaticMarkup(
      <VmUsageWindows
        vm={
          {
            id: 'fixture',
            has_token: true,
            platform: 'anthropic',
            utilization_7d: 0.76,
            quota_observations: snapshot,
          } as Vm
        }
        now={Date.parse('2026-11-01T00:05:00Z')}
      />
    )
    expect(html).toContain('76%')
    expect(html).not.toContain('官方侧存储')
  })
  it('stays hidden when official storage matches displayed utilization and is not stale', () => {
    expect(claude({ utilization_7d: 0 })).toBe('')
  })
  it('shows official zero beside conservative usage, source and distinct timestamps', () => {
    const html = claude()
    expect(html).toContain('官方侧存储：')
    expect(html).toContain('0%')
    expect(html).toContain('76%')
    expect(html).toContain('与当前展示不同')
    expect(html).toContain('2026-11-01T00:00:00Z')
    expect(html).toContain('2026-10-31T00:00:00Z')
    expect(html).toContain('窗口采样时间未知')
  })
  it('does not attribute a reconciled 5% value to the older official query', () => {
    const html = claude({
      quota_observations: {
        ...snapshot,
        official: {
          ...snapshot.official,
          '7d': { ...snapshot.official['7d'], utilization: 0.05 },
        },
      },
    })
    expect(html).toContain('官方侧存储：')
    expect(html).toContain('5%')
    expect(html).toContain('2026-11-01T00:00:00Z')
    expect(html).toContain('重置后可能被响应头校正，并非官方查询原始回执')
    expect(html).toContain('不保证对应单窗口采样')
    expect(html).not.toContain('官方查询记录')
    expect(html).not.toContain('官方记录更新时间')
    expect(html).not.toContain('官方查询：')
  })
  it('does not invent official snapshots for old servers or other platforms', () => {
    expect(claude({ quota_observations: undefined })).not.toContain(
      '官方侧存储'
    )
    expect(claude({ platform: 'openai', family: 'codex' })).not.toContain(
      '官方侧存储'
    )
  })
  it('retains stale official observations with a warning, not a new zero', () => {
    const html = claude({
      quota_observations: {
        ...snapshot,
        official: {
          ...snapshot.official,
          '7d': { ...snapshot.official['7d'], utilization: null, stale: true },
        },
      },
    })
    expect(html).toContain('官方侧存储：')
    expect(html).toContain('陈旧')
    expect(html).toContain('未知')
    expect(html).not.toMatch(/>0%</)
  })
})

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

  it('truncates displayed points and distinguishes available, unavailable and historical samples', () => {
    const sample = {
      has_credits: true,
      unlimited: false,
      balance: '12.345678901',
      fetched_at: '2026-10-31T12:34:00Z',
      invalidated_at: null,
      status: 'available' as const,
    }
    const available = render(100, 32, false, sample)
    expect(available).toContain('余额 12.34 点')
    expect(available).not.toContain('12.345678901')
    expect(available).toContain('订阅额度已满，可使用点数')
    expect(available).toContain('100%')
    expect(available).not.toContain('$12')
    const historical = render(100, 32, false, {
      ...sample,
      status: 'pending',
    })
    expect(historical).toContain('历史余额 12.34 点')
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
    expect(render(2, 32, false, { ...sample, balance: '-1.239' })).toContain(
      '余额 -1.23 点'
    )
    const tiny = render(2, 32, false, { ...sample, balance: '-0.009' })
    expect(tiny).toContain('余额 0 点')
    expect(tiny).not.toContain('余额 -0')
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
    expect(html).toContain('余额 123 点')
    expect(html).not.toContain('123.000456')
    expect(html).toContain('最近余额采样：')
    expect(html).toContain('最近检查：')
    expect(html).toContain(new Date(checkedAt).toLocaleString())
    expect(html).not.toContain('到期')
  })

  it('shows only subscription points in the virtual machine summary', () => {
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
    expect(html).not.toContain('API $37')
    expect(html).not.toContain('37.000')
    expect(html).not.toContain('12.3400')
  })
})

describe('window timing from measured quota and reset', () => {
  const reset = '2026-11-16T10:00:00Z'
  const now = Date.parse(reset) - 2.5 * 3600_000
  it('keeps true zero usage separate from unknown usage', () => {
    const base = { key: '5h' as const, label: '5H', reset, note: null }
    expect(windowTiming({ ...base, pct: 0 }, now)).toMatchObject({
      elapsedPct: 50,
      pace: 0,
      fullInMs: null,
    })
    expect(windowTiming({ ...base, pct: null }, now)).toMatchObject({
      elapsedPct: 50,
      pace: null,
      fullInMs: null,
    })
  })
  it('projects only a measured pace that fills before the real reset', () => {
    expect(
      windowTiming({ key: '5h', label: '5H', reset, note: null, pct: 75 }, now)
    ).toMatchObject({ elapsedPct: 50, pace: 1.5, fullInMs: 3_000_000 })
    expect(
      windowTiming(
        { key: '5h', label: '5H', reset: null, note: null, pct: 75 },
        now
      )
    ).toMatchObject({ elapsedPct: null, pace: null, fullInMs: null })
  })

  it('uses the same Codex sample duration and leaves an unknown duration unestimated', () => {
    const sample: Vm = {
      id: 'codex-timing',
      family: 'codex',
      platform: 'openai',
      has_token: true,
      codex_usage: {
        pending_refresh: true,
        windows: [{ id: '5h', used_percent: null }],
        last_success: {
          windows: [
            {
              id: '5h',
              used_percent: 75,
              reset_at: reset,
              window_minutes: 120,
            },
          ],
        },
      },
    }
    const measured = vmWindows(sample)[0]
    expect(measured.durationMs).toBe(120 * 60_000)
    expect(
      windowTiming(measured, Date.parse(reset) - 60 * 60_000)
    ).toMatchObject({ elapsedPct: 50, pace: 1.5, fullInMs: 1_200_000 })
    const unknown = vmWindows({
      ...sample,
      codex_usage: {
        windows: [{ id: '5h', used_percent: 75, reset_at: reset }],
      },
    })[0]
    expect(unknown.durationMs).toBeNull()
    expect(windowTiming(unknown, now)).toMatchObject({
      elapsedPct: null,
      pace: null,
      fullInMs: null,
    })
  })
})
