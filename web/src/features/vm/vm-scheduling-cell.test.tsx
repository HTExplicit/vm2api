import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VmSchedulingCell } from './vm-scheduling-cell'

const role = vi.hoisted(() => ({ admin: true }))
vi.mock('./vm-perms', () => ({ useVmPerms: () => role }))

function render(over: Partial<Vm> = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <VmSchedulingCell
        vm={{
          id: 'slot-a',
          schedule_level: 6,
          schedule_level_mode: 'manual',
          ...over,
        }}
      />
    </QueryClientProvider>
  )
}

describe('list scheduling controls', () => {
  it('shows a cumulative manual bar with mode and level in its description', () => {
    role.admin = true
    const html = render()
    expect(html).toContain('aria-description="手动调度优先级，当前等级 6"')
    expect(html).not.toMatch(/>手动[^<]*<|>\d+</)
    const blocks = [
      ...html.matchAll(
        /<button[^>]*aria-label="slot-a 调度优先级 \d+"[^>]*>.*?<\/button>/g
      ),
    ]
    expect(blocks).toHaveLength(10)
    expect([
      ...html.matchAll(
        /<button[^>]*aria-label="slot-a (?:自动调度优先级|调度优先级 \d+)"/g
      ),
    ]).toHaveLength(11)
    expect(
      blocks.filter(([block]) => block.includes('bg-sky-600'))
    ).toHaveLength(6)
    expect(
      blocks.filter(([block]) => block.includes('aria-pressed="true"'))
    ).toHaveLength(1)
    for (const [block] of blocks) expect(block).not.toMatch(/>\d+</)
    expect(html).toContain(
      'aria-label="slot-a 自动调度优先级" aria-pressed="false"'
    )
    expect(html).toContain('data-slot="priority-auto-segment"')
    expect(html.indexOf('aria-label="slot-a 自动调度优先级"')).toBeLessThan(
      html.indexOf('aria-label="slot-a 调度优先级 1"')
    )
    expect(html).not.toMatch(/>自动</)
    expect(html).not.toMatch(/重置|周窗口|倒计时/)
  })

  it('shows the automatic effective level without selecting a manual block', () => {
    role.admin = true
    const html = render({ schedule_level_mode: 'auto', schedule_level: 4 })
    expect(html).toContain('aria-description="自动调度优先级，当前等级 4"')
    expect(html).not.toMatch(/>自动[^<]*\d|>\d+</)
    expect(html).toContain(
      'aria-label="slot-a 自动调度优先级" aria-pressed="true"'
    )
    expect(html).not.toMatch(
      /aria-label="slot-a 调度优先级 \d+" aria-pressed="true"/
    )
    expect(html.match(/--status-ok-solid/g)).toHaveLength(5)
  })

  it('keeps priority editable when scheduling is manually off', () => {
    role.admin = true
    const html = render({ schedule_state: 'off', schedulable: false })
    expect(html).toContain('role="switch" aria-checked="false"')
    expect(html).toContain('aria-label="slot-a 调度优先级 10"')
    expect(html).not.toMatch(
      /<button[^>]* disabled=""[^>]*aria-label="slot-a 调度优先级/
    )
  })

  it('shows priority read-only for a non-administrator', () => {
    role.admin = false
    const html = render()
    expect(html).toContain('aria-label="slot-a 调度优先级"')
    expect(html).not.toContain('aria-label="slot-a 调度优先级 1"')
    expect(html).not.toContain('aria-label="slot-a 自动调度优先级"')
    expect(html).toContain('data-slot="priority-auto-segment"')
    expect(html).toContain('title="手动调度优先级，当前等级 6"')
    role.admin = true
  })

  it('preserves the credential-blocked switch explanation', () => {
    role.admin = true
    expect(
      render({
        schedule_state: 'unschedulable',
        schedulable: false,
        unschedulable_reason: 'credential_blocked',
      })
    ).toContain('认证失败，已停止分配。刷新或重新导入凭据，认证成功后自动恢复')
  })
})
