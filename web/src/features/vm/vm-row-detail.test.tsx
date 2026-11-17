import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VmHealthPayload } from './queries'
import { VmRowDetail } from './vm-row-detail'

const controls = vi.hoisted(() => ({
  role: 'admin' as string | null,
  result: {
    data: undefined as VmHealthPayload | undefined,
    isPending: false,
    isError: false,
    error: null as Error | null,
  },
  query: vi.fn(),
  api: vi.fn(),
}))

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: controls.query,
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: controls.api,
}))
vi.mock('./vm-perms', async (importOriginal) => {
  const original = await importOriginal<typeof import('./vm-perms')>()
  return {
    ...original,
    useVmPerms: () => original.vmPermsFor(controls.role),
  }
})
vi.mock('./openai-quota-actions', () => ({
  OpenaiQuotaActions: ({ vm, compact }: { vm: Vm; compact: boolean }) => (
    <span
      data-testid='codex-quota-actions'
      data-vm={vm.id}
      data-compact={compact}
    />
  ),
}))
vi.mock('./openai-api-actions', () => ({
  OpenaiApiActions: ({ vm, compact }: { vm: Vm; compact: boolean }) => (
    <span
      data-testid='openai-api-actions'
      data-vm={vm.id}
      data-compact={compact}
    />
  ),
}))
vi.mock('./claude-reset-actions', () => ({
  ClaudeResetActions: ({ vm, now }: { vm: Vm; now: number }) => (
    <span data-testid='claude-reset-actions' data-vm={vm.id} data-now={now} />
  ),
}))

const NOW = Date.parse('2026-11-16T12:00:00Z')

function health(overrides: Partial<VmHealthPayload> = {}): VmHealthPayload {
  return {
    range: '24h',
    slot_min: 30,
    start: '2026-11-15T12:00:00Z',
    buckets: [[9, 1]],
    top_errors: [],
    ...overrides,
  }
}

function render(overrides: Partial<Vm> = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <VmRowDetail
        vm={{ id: 'slot / one', ...overrides }}
        now={NOW}
        onOpenDetail={() => {}}
        id='slot-detail'
      />
    </QueryClientProvider>
  )
}

function section(html: string, label: string) {
  const match = html.match(
    new RegExp(`<section[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</section>`)
  )
  expect(match, `${label} section`).not.toBeNull()
  return match![1]
}

beforeEach(() => {
  controls.role = 'admin'
  controls.result = {
    data: health(),
    isPending: false,
    isError: false,
    error: null,
  }
  controls.query.mockReset().mockImplementation(() => controls.result)
  controls.api.mockReset().mockResolvedValue(health())
})

describe('VM row request health', () => {
  it('enables the explicit 24h SLA query for admins and preserves its request identity', async () => {
    const html = section(render(), '请求健康')
    expect(controls.query).toHaveBeenCalledTimes(1)
    const options = controls.query.mock.calls[0][0]
    expect(options).toMatchObject({
      queryKey: ['panel', 'vm', 'slot / one', 'health', '24h'],
      enabled: true,
      staleTime: 30_000,
    })
    expect(html).toContain('aria-label="健康时间范围"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('90.0%')
    expect(html).toContain('aria-label="请求健康时间线"')
    expect(controls.api).not.toHaveBeenCalled()
    await options.queryFn()
    expect(controls.api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/vms/slot%20%2F%20one/health?range=24h'
    )
  })

  it.each(['user', 'super'])(
    'disables SLA queries and shows the permission boundary for %s',
    (role) => {
      controls.role = role
      const html = section(render(), '请求健康')
      expect(controls.query.mock.calls[0][0].enabled).toBe(false)
      expect(html).toContain('健康明细仅管理员可查看')
      expect(html).not.toContain('aria-label="健康时间范围"')
      expect(html).not.toContain('aria-label="请求健康时间线"')
      expect(html).not.toContain('90.0%')
      expect(controls.api).not.toHaveBeenCalled()
    }
  )

  it('keeps the query disabled while the role is unknown', () => {
    controls.role = null
    controls.result = { ...controls.result, data: undefined, isPending: true }
    const html = section(render(), '请求健康')
    expect(controls.query.mock.calls[0][0].enabled).toBe(false)
    expect(html).toContain('animate-pulse')
    expect(html).not.toContain('健康明细仅管理员可查看')
    expect(html).not.toContain('该时段无请求')
    expect(controls.api).not.toHaveBeenCalled()
  })

  it('shows unknown data for missing buckets without reporting an empty or successful period', () => {
    controls.result.data = health({ buckets: undefined })
    const html = section(render(), '请求健康')
    expect(html).toContain('请求健康数据未知')
    expect(html).not.toContain('aria-label="请求健康时间线"')
    expect(html).not.toContain('该时段无请求')
    expect(html).not.toContain('100%')
  })

  it('treats explicit null buckets as a successful query with no requests', () => {
    controls.result.data = health({ buckets: null })
    const html = section(render(), '请求健康')
    expect(html).toContain('aria-label="请求健康时间线"')
    expect(html).toContain('该时段无请求')
    expect(html).toMatch(/成功率<\/span><b[^>]*>—<\/b>/)
    expect(html).toMatch(/请求<\/span><b[^>]*>0<\/b>/)
    expect(html).not.toContain('请求健康数据未知')
    expect(html).not.toContain('加载失败')
    expect(html).not.toContain('100%')
  })

  it('shows a measured zero-request period without inventing a success rate', () => {
    controls.result.data = health({
      buckets: Array.from({ length: 48 }, () => [0, 0]),
    })
    const html = section(render(), '请求健康')
    expect(html).toContain('aria-label="请求健康时间线"')
    expect(html).toContain('该时段无请求')
    expect(html).toMatch(/成功率<\/span><b[^>]*>—<\/b>/)
    expect(html).toMatch(/请求<\/span><b[^>]*>0<\/b>/)
    expect(html).not.toContain('请求健康数据未知')
    expect(html).not.toContain('100%')
  })

  it('keeps query failures distinct from unknown data and zero requests', () => {
    controls.result = {
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error('SLA fixture unavailable'),
    }
    const html = section(render(), '请求健康')
    expect(html).toContain('加载失败：SLA fixture unavailable')
    expect(html).not.toContain('请求健康数据未知')
    expect(html).not.toContain('该时段无请求')
    expect(html).not.toContain('aria-label="请求健康时间线"')
  })
})

describe('VM row quota integration', () => {
  it('keeps the Codex sample, historical credits and both quota action entries in the windows card', () => {
    const html = section(
      render({
        platform: 'openai',
        family: 'codex',
        has_token: true,
        codex_usage: {
          pending_refresh: true,
          last_success_at: '2026-11-16T11:00:00Z',
          last_success: {
            windows: [
              { id: '5h', used_percent: 12 },
              { id: '7d', used_percent: 34 },
            ],
          },
        },
        codex_credits: {
          status: 'pending',
          has_credits: true,
          unlimited: false,
          balance: '12.345',
          fetched_at: '2026-11-16T11:00:00Z',
          invalidated_at: null,
        },
      }),
      '用量窗口明细'
    )
    expect(html).toContain('12%')
    expect(html).toContain('34%')
    expect(html).toContain('aria-label="额度待刷新，最近测量：')
    expect(html).toContain('历史余额 12.34 点')
    expect(html).toContain('待确认')
    expect(html).toContain(
      'data-testid="codex-quota-actions" data-vm="slot / one" data-compact="true"'
    )
    expect(html).toContain(
      'data-testid="openai-api-actions" data-vm="slot / one" data-compact="true"'
    )
    expect(html).not.toContain('data-testid="claude-reset-actions"')
  })

  it('keeps the Claude quota action entry and passes the shared clock', () => {
    const html = section(render({ platform: 'anthropic' }), '用量窗口明细')
    expect(html).toContain(
      `data-testid="claude-reset-actions" data-vm="slot / one" data-now="${NOW}"`
    )
    expect(html).not.toContain('data-testid="codex-quota-actions"')
    expect(html).not.toContain('data-testid="openai-api-actions"')
  })

  it.each([
    { reset: undefined, label: '已满 · 重置时间未知' },
    {
      reset: '2026-11-16T11:59:00Z',
      label: '已满 · 等待额度更新',
    },
  ])(
    'keeps a measured full window without promising recovery when its reset is $reset',
    ({ reset, label }) => {
      const html = section(
        render({
          platform: 'openai',
          family: 'codex',
          has_token: true,
          utilization_5h: 1,
          reset_5h: reset,
          codex_usage: {
            windows: [{ id: '5h', used_percent: 100, reset_at: reset }],
          },
        }),
        '用量窗口明细'
      )
      expect(html).toContain('100%')
      expect(html).toContain(label)
      expect(html).not.toContain('后恢复')
    }
  )

  it.each([
    {
      schedule_state: 'restricted',
      restriction_text: '人工 5H 上限',
      label: '调度受限：人工 5H 上限',
    },
    {
      schedule_state: 'unschedulable',
      unschedulable_text: '凭证需要恢复',
      label: '调度不可调度：凭证需要恢复',
    },
  ] as const)(
    'keeps the $schedule_state scheduling explanation beside the quota windows',
    ({ label, ...vm }) => {
      const html = section(render(vm), '用量窗口明细')
      expect(html).toContain(label)
      expect(html).toContain('data-testid="claude-reset-actions"')
    }
  )
})
