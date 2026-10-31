import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VmUsageWindows } from './usage-windows'

function render(five: number | null, seven: number | null, pending = false) {
  const vm: Vm = {
    id: 'vm-fixture',
    platform: 'openai',
    family: 'codex',
    has_token: true,
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
})
