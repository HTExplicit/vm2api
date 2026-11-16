import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STATUS_BAR_ITEMS } from './status-bar-options'
import { VmAccountIdentity } from './vm-account-identity'
import { VmTable } from './vm-list-table'
import { VmSchedulingBlock, VmSchedulingEditor } from './vm-scheduling'

const visibility = vi.hoisted(() => ({ label: true, bar: true, proxy: true }))
vi.mock('./status-bar-options', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./status-bar-options')>()),
  useStatusBarShow: () => ({ show: visibility, toggle: vi.fn() }),
}))
afterEach(() =>
  Object.assign(visibility, { label: true, bar: true, proxy: true })
)

vi.mock('./vm-actions-context', () => ({ useVmActions: () => ({}) }))
vi.mock('./vm-action-menu', () => ({ VmActionMenu: () => null }))
vi.mock('./vm-owner-line', () => ({ VmRentedMark: () => null }))
vi.mock('./vm-perms', () => ({ useVmPerms: () => ({ admin: false }) }))
vi.mock('./use-vm-column-order', () => ({
  useVmColumnOrder: () => ({
    order: ['vm', 'status', 'usage'],
    isDefault: true,
  }),
}))
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
      expect(list).not.toContain('>调度</span>')
      expect(list).toContain('>用量窗口</span>')
      expect(list).toContain('data-slot="vm-usage-cell"')
      expect(list).toContain('aria-label="vm-01 调度优先级"')
      expect(list).toContain('aria-description="手动调度优先级，当前等级 8"')
      expect(list).not.toMatch(/background-color:[^";]+[^>]*>调度优先级/)
      expect(list.replace(/<[^>]*>/g, '')).not.toMatch(/等级|权重/)

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
    expect(render({ weight: 4 })).toContain(
      'aria-description="自动调度优先级，当前等级 未知"'
    )
  })
})

describe('VM row interaction and request health', () => {
  it('keeps full details separate from the row expansion control', () => {
    const html = render()
    expect(html).toContain('aria-label="打开 vm-01 详情页"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls="vm-row-detail-vm-01"')
    expect(html).not.toContain('role="button"')
  })

  it('distinguishes known request SLA, no requests and unknown data', () => {
    const buckets: [number, number][] = Array.from({ length: 48 }, (_, i) =>
      i === 47 ? [99, 1] : [0, 0]
    )
    const html = render({
      health_24h: buckets,
      inflight: 3,
      seats_max: 5,
      seats_used: 2,
    })
    expect(html).toContain('>99.0%</span>')
    expect(html).toContain('99/100 成功')
    expect(
      render({ health_24h: Array.from({ length: 48 }, () => [0, 0]) })
    ).toContain('24h 无请求')
    expect(render({ health_24h: null })).toContain('24h 无请求')
    expect(render()).toContain('24h 未知')
    expect(render()).not.toContain('24h 无请求')
  })
})

describe('official status header and independent display options', () => {
  const active: Partial<Vm> = {
    has_token: true,
    schedule_state: 'on',
    availability: { key: 'ok', usable: true, text: '池内可用' },
    inflight: 3,
    seats_max: 5,
    seats_used: 2,
    queue_depth: 1,
    health_24h: [[99, 1]],
  }

  it('restores the official menu keys and labels without changing their storage names', () => {
    expect(STATUS_BAR_ITEMS).toEqual([
      ['label', '状态'],
      ['bar', '健康'],
      ['proxy', '代理'],
    ])
  })

  it('shows the actual status, positive in-flight count and occupied or queued seats', () => {
    const html = render(active)
    expect(html).toContain('>池内可用</span>')
    expect(html).toContain('title="在飞 3"')
    expect(html).toContain('席位 2/5 · 排队 1')
    expect(render({ ...active, seats_used: 0, queue_depth: 1 })).toContain(
      '席位 0/5 · 排队 1'
    )
    expect(render({ ...active, seats_used: 2, queue_depth: 0 })).toContain(
      '席位 2/5'
    )
  })

  it.each([
    { name: 'no in-flight requests', over: { inflight: 0 } },
    {
      name: 'bad account',
      over: { availability: { key: 'bad', usable: false, text: '无效凭证' } },
    },
    {
      name: 'no credential',
      over: {
        has_token: false,
        availability: { key: 'none', usable: false, text: '无凭证' },
      },
    },
    { name: 'manually off', over: { schedule_state: 'off' } },
  ] satisfies Array<{ name: string; over: Partial<Vm> }>)(
    'hides the in-flight marker for $name',
    ({ over }) => {
      expect(render({ ...active, ...over })).not.toContain('title="在飞 ')
    }
  )

  it.each(['cool', 'quota'] as const)(
    'keeps positive in-flight requests visible for %s status',
    (key) => {
      expect(
        render({
          ...active,
          availability: { key, usable: false, text: '仍有在途请求' },
        })
      ).toContain('title="在飞 3"')
    }
  )

  it.each([
    { seats_max: null, seats_used: 2, queue_depth: 1 },
    { seats_max: undefined, seats_used: 2, queue_depth: 1 },
    { seats_max: 5, seats_used: 0, queue_depth: 0 },
  ])(
    'hides the seat marker without a seat limit or active occupancy',
    (over) => {
      expect(render({ ...active, ...over })).not.toContain('席位 ')
    }
  )

  it('hides only the entire status header when 状态 is disabled', () => {
    Object.assign(visibility, { label: false, bar: true, proxy: false })
    const html = render(active)
    expect(html).not.toMatch(/池内可用|title="在飞 |席位 /)
    expect(html).toContain(
      'role="img" aria-label="近 24h 请求健康：99/100 成功"'
    )
    expect(html).toContain('>99.0%</span>')
    expect(html).toContain('99/100 成功')
  })

  it('hides the health bar, percentage and summary together when 健康 is disabled', () => {
    Object.assign(visibility, { label: true, bar: false, proxy: false })
    const html = render(active)
    expect(html).toContain('>池内可用</span>')
    expect(html).toContain('title="在飞 3"')
    expect(html).toContain('席位 2/5 · 排队 1')
    expect(html).not.toMatch(/近 24h 请求健康|99\.0%|99\/100 成功/)
  })

  it('keeps the proxy display independent of both status and health', () => {
    Object.assign(visibility, { label: false, bar: false, proxy: true })
    const html = render(active)
    expect(html).toContain('title="缺代理"')
    expect(html).not.toMatch(/池内可用|title="在飞 |席位 |近 24h 请求健康/)
    visibility.proxy = false
    expect(render(active)).not.toContain('title="缺代理"')
  })
})

describe('VM account column kernel label', () => {
  it.each(['wrap', 'cc'] as const)(
    'renders %s as a silver standard kernel',
    (dataplane) => {
      const html = render({ resolved_dataplane: dataplane })
      expect(html).toMatch(/class="[^"]*bg-zinc-200[^"]*"[^>]*>默认<\/span>/)
      expect(html).not.toContain('>crag</span>')
      expect(html).toContain('account@example.com')
    }
  )

  it.each(['legacy', 'v2'] as const)(
    'renders CRAG %s as orange crag',
    (version) => {
      const html = render({
        resolved_dataplane: 'crag',
        resolved_crag_kernel_version: version,
      })
      expect(html).toMatch(/class="[^"]*bg-orange-200[^"]*"[^>]*>crag<\/span>/)
      expect(html).not.toContain('>默认</span>')
    }
  )

  it('uses the resolved route instead of the configured override', () => {
    expect(render({ dataplane: 'wrap', resolved_dataplane: 'crag' })).toContain(
      '>crag</span>'
    )
    expect(render({ dataplane: 'crag', resolved_dataplane: 'wrap' })).toContain(
      '>默认</span>'
    )
  })

  it('supports older responses without a resolved route', () => {
    expect(render({ dataplane: 'crag' })).toContain('>crag</span>')
    expect(render()).toContain('>默认</span>')
  })

  it('shows the platform mark, stable VM number, email and enrollment independently of the auth scheme', () => {
    const vm: Partial<Vm> = {
      has_token: true,
      auth_scheme: 'authorization_bearer',
      subscription_type: 'max',
      runtime_type: 'kvm',
      node_name: '测试集群',
    }
    const html = render(vm)
    expect(html).toContain('aria-label="anthropic"')
    for (const label of [
      'vm-01',
      'account@example.com',
      'Max',
      'kvm',
      'oauth',
      '测试集群',
    ]) {
      expect(html).toMatch(new RegExp(`>${label}</(?:span|div)>`))
    }
    expect(html).not.toContain('订阅 未知')
    expect(html).not.toContain('01·account')
    expect(
      render({
        ...vm,
        credential_mode: 'setup-token',
        oauth_registration: 'oauth',
      })
    ).toContain('>oauth</span>')
    expect(
      render({
        ...vm,
        credential_mode: 'setup-token',
        oauth_registration: 'console',
      })
    ).toContain('>console</span>')
    expect(render({ platform: 'openai', has_token: true })).toContain(
      'aria-label="openai"'
    )
    expect(render({ platform: 'openai', has_token: true })).toContain(
      '>local</span>'
    )
  })

  it('keeps the measured OpenAI plan and pending quota marker in the shared identity', () => {
    const vm: Vm = {
      id: 'vm-01',
      platform: 'openai',
      has_token: true,
      plan_type: 'team',
      chatgpt_plan_type: 'plus',
      codex_usage: {
        pending_refresh: true,
        last_success_at: '2026-11-15T01:00:00Z',
      },
    }
    const html = render(vm)
    expect(html).toContain('>Business</span>')
    expect(html).not.toContain('>Plus</span>')
    expect(html).not.toContain('aria-label="额度待刷新，最近测量：')
    expect(renderToStaticMarkup(<VmAccountIdentity vm={vm} />)).toContain(
      'aria-label="额度待刷新，最近测量：'
    )
    expect(html).not.toContain('订阅 未知')
  })
})
