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
  it('shows a contiguous cumulative bar and keeps digits outside the blocks', () => {
    role.admin = true
    const html = render()
    expect(html).toContain('手动 <span')
    expect(html).toMatch(/tabular-nums[^>]*>6<\/span>/)
    const blocks = [
      ...html.matchAll(
        /<button[^>]*aria-label="slot-a 调度优先级 \d+"[^>]*>.*?<\/button>/g
      ),
    ]
    expect(blocks).toHaveLength(10)
    expect(
      blocks.filter(([block]) => /class="[^"]*bg-primary /.test(block))
    ).toHaveLength(6)
    expect(
      blocks.filter(([block]) => block.includes('aria-pressed="true"'))
    ).toHaveLength(1)
    for (const [block] of blocks) expect(block).not.toMatch(/>\d+</)
    expect(html).toContain(
      'aria-label="slot-a 自动调度优先级" aria-pressed="false"'
    )
    expect(html).not.toMatch(/重置|周窗口|倒计时/)
  })

  it('shows the automatic effective level without selecting a manual block', () => {
    role.admin = true
    const html = render({ schedule_level_mode: 'auto', schedule_level: 4 })
    expect(html).toContain('自动 <span')
    expect(html).toContain(
      'aria-label="slot-a 自动调度优先级" aria-pressed="true"'
    )
    expect(html).not.toMatch(
      /aria-label="slot-a 调度优先级 \d+" aria-pressed="true"/
    )
    expect(
      html.match(/class="[^"]*bg-primary text-primary-foreground/g)
    ).toHaveLength(4)
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
