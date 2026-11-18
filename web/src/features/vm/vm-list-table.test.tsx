import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { geminiSlot } from './gemini-slot'
import {
  CLASSIC_COLUMNS,
  METRIC_COLUMNS,
  normalizeColumns,
} from './vm-list-columns'
import { VmTable } from './vm-list-table'
import { VmRack } from './vm-rack'
import { VmSchedulingBlock, VmSchedulingEditor } from './vm-scheduling'
import { filterVms } from './vm-table'

vi.mock('./vm-actions-context', () => ({ useVmActions: () => ({}) }))
vi.mock('./vm-action-menu', () => ({ VmActionMenu: () => null }))
vi.mock('./vm-owner-line', () => ({ VmRentedMark: () => null }))
vi.mock('./vm-perms', () => ({ useVmPerms: () => ({ admin: false }) }))
vi.mock('@/components/ui/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/dialog')>()),
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

function render(over: Partial<Vm> = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <VmTable vms={[{ id: 'vm-01', email: 'account@example.com', ...over }]} />
    </QueryClientProvider>
  )
}

describe('VM scheduling priority', () => {
  it.each(['anthropic', 'openai'] as const)(
    'shows and edits the same %s priority throughout the panel',
    (platform) => {
      const vm: Vm = {
        id: 'vm-01',
        platform,
        schedule_level: 8,
        schedule_level_mode: 'manual',
        weight: 42,
      }
      const list = render(vm)
      expect(list).toContain('data-column="sched"')
      expect(list).toContain('data-column="type"')
      expect(list).toContain('手动指定优先级')
      expect(list).toContain('P8 手')
      expect(list).not.toMatch(/等级|权重/)

      const detail = renderToStaticMarkup(<VmSchedulingBlock vm={vm} />)
      expect(detail).toContain('>调度优先级</span>')
      expect(detail).toContain('>8 · 手动</span>')

      const editor = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <VmSchedulingEditor vm={vm} />
        </QueryClientProvider>
      )
      expect(editor).toContain('role="radiogroup" aria-label="调度优先级"')
      expect(editor).toMatch(/role="radio" aria-checked="true"[^>]*>8</)
    }
  )

  it('does not substitute legacy weight when priority is missing', () => {
    expect(render({ weight: 4 })).toMatch(/>P—</)
  })
})

describe('VM row interaction and health', () => {
  it('shows the active request count in the account cell even while scheduling is off', () => {
    const html = render({
      platform: 'openai',
      schedulable: false,
      inflight: 3,
      session_active: 7,
    })
    expect(html).toMatch(
      /data-vm-cell="account"[\s\S]*?data-vm-requesting="3"[^>]*title="请求中 3"/
    )
    expect(html).not.toContain('data-vm-requesting="7"')
  })

  it('omits the account badge for held seats and idle Codex sessions', () => {
    expect(
      render({
        inflight: 4,
        seat_sessions: [
          { index: 1, session_id: 'held', state: 'held', inflight: 0 },
        ],
      })
    ).not.toContain('data-vm-requesting=')
    expect(
      render({ platform: 'openai', inflight: 0, session_active: 7 })
    ).not.toContain('data-vm-requesting=')
  })

  it('keeps separate controls to open and expand the details', () => {
    const html = render()
    expect(html).toContain('aria-label="打开 account@example.com 详情页"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="展开 vm-01 明细"')
    expect(html).not.toContain('role="button"')
  })

  it('shows request success rate and never infers health without requests', () => {
    const buckets = Array.from({ length: 48 }, (_, i): [number, number] =>
      i === 47 ? [99, 1] : [0, 0]
    )
    const html = render({ health_24h: buckets })
    expect(html).toContain('24h 99.0%')
    expect(html).toContain('title="24h 成功 99 / 总数 100"')
    expect(render({ health_24h: null })).toContain('24h 无请求')
    expect(render()).toContain('24h 未知')
    expect(render()).not.toContain('24h 无请求')
    expect(render({ health_24h: null })).not.toContain('主机内存紧张')
  })
})

describe('VM account column kernel label', () => {
  it('shares the VM table and rack with a host Gemini account without VM controls or fake readiness', () => {
    const gemini = geminiSlot({
      id: 'gemini-fixture',
      name: 'Gemini account',
      proxy_id: 'px-011f7746',
      auth_state: 'authorized',
      runtime_ready: false,
      billing_ready: false,
      auth_method: 'oauth',
      kernel_version: '0.3.0-rc.1',
      created_at: null,
      updated_at: null,
      models: [],
      account: null,
    })
    expect(filterVms([gemini], 'px-011f', 'dead', 'gemini')).toEqual([gemini])
    expect(filterVms([gemini], '', 'all', 'gpt')).toEqual([])
    expect(filterVms([gemini], '', 'all', 'claude')).toEqual([])

    const openai = { id: 'vm-02', platform: 'openai', has_token: true }
    const renderSlots = (nodes: ReactNode) =>
      renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          {nodes}
        </QueryClientProvider>
      )
    const table = renderSlots(<VmTable vms={[openai, gemini]} />)
    expect(table).toContain('>GPT</span>')
    expect(table).toContain('data-vm-table')
    for (const html of [
      table,
      renderSlots(<VmRack vms={[gemini]} filter='all' size='l' />),
    ]) {
      for (const label of [
        'Gemini account',
        'CRAGAnti',
        '宿主机',
        '已授权',
        '载荷未启用推理',
        'px-011f7746',
      ]) {
        expect(html).toContain(label)
      }
      expect(html).not.toContain('运行就绪')
    }
    const hostOnly = renderSlots(<VmTable vms={[gemini]} />)
    expect(hostOnly).not.toContain('role="switch"')
    expect(hostOnly).not.toContain('24h 无请求')
  })

  it('prioritizes the full account name and presents the platform, plan and kernel together', () => {
    const name = 'A much longer operations account name'
    const vm: Partial<Vm> = {
      name,
      has_token: true,
      subscription_type: 'max',
      runtime_type: 'kvm',
      node_name: '测试集群',
    }
    const html = render(vm)
    expect(html).toContain('>Claude</span>')
    expect(html).toContain(`aria-label="打开 ${name} 详情页">${name}</button>`)
    expect(html).toContain('>Claude</span>')
    expect(html).toContain('>Max</span>')
    expect(render({ name: '' })).toContain(
      'aria-label="打开 account@example.com 详情页">account@example.com</button>'
    )
    expect(render({ name: '', email: '' })).toContain(
      'aria-label="打开 vm-01 详情页">vm-01</button>'
    )
    expect(render({ platform: 'openai', has_token: true })).toContain(
      '>GPT</span>'
    )
  })
})

describe('classic account table columns', () => {
  it('starts with the official seven columns and makes the full set of sort metrics accessible', () => {
    const html = render()
    expect(
      Array.from(html.matchAll(/data-column="([^"]+)"/g), (m) => m[1])
    ).toEqual(CLASSIC_COLUMNS)
    expect(html).toContain('显示列')
    expect(html).toContain('列表统计')
    expect(html).toContain('data-pin="false"')
    for (const key of METRIC_COLUMNS) expect(html).toContain(`value="${key}"`)
  })
  it('migrates the old order, discards unknowns, and always pins the identity', () => {
    const result = normalizeColumns(
      ['cost', 'bogus', 'vm', 'cost', 'sched'],
      null
    )
    expect(result.order.slice(0, 3)).toEqual(['vm', 'cost', 'sched'])
    expect(result.visible).toEqual(CLASSIC_COLUMNS)
    expect(new Set(result.order).size).toBe(19)
    expect(normalizeColumns({}, ['queue', 'new', 'queue']).visible).toEqual([
      'vm',
      'queue',
    ])
    expect(normalizeColumns(null, []).visible).toEqual(['vm'])
  })
})
