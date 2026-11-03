import type { PropsWithChildren } from 'react'
import type { OpenaiApiKeyEntry } from '@/types/panel-openai-apikey'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiKeyBindDialog } from './bind-dialog'
import { ApiKeyDetailDialog } from './detail-dialog'
import { OpenaiApiKeyPage } from './index'

const controls = vi.hoisted(() => ({
  role: 'admin',
  item: {} as OpenaiApiKeyEntry,
  queries: [] as Array<{ enabled?: boolean; queryKey: string[] }>,
  api: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: controls.api,
  ApiError: class extends Error {},
}))
vi.mock('@tanstack/react-query', () => ({
  queryOptions: (options: unknown) => options,
  useQuery: (options: { enabled?: boolean; queryKey: string[] }) => {
    controls.queries.push(options)
    return {
      data: options.queryKey.includes('me')
        ? { role: controls.role }
        : { items: [controls.item], bind_candidates: [] },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    }
  },
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
vi.mock('@/components/ui/dialog', () => {
  const Part = ({ children }: PropsWithChildren) => <div>{children}</div>
  return {
    Dialog: Part,
    DialogContent: Part,
    DialogHeader: Part,
    DialogTitle: Part,
    DialogDescription: Part,
    DialogFooter: Part,
  }
})
beforeEach(() => {
  controls.role = 'admin'
  controls.queries = []
  controls.api.mockReset()
  controls.item = {
    vm_id: 'slot-one',
    account_id: 'account-a',
    email: 'one@example.test',
    slot_name: '账号一',
    key_id: 'ek-one',
    endpoint_id: 'ep-one',
    pro_eligible: false,
    claim_status: 'claimed',
    enabled: true,
    has_key: true,
    key_suffix: '1234',
    key_prefix: 'sk-proj-abcd',
    setup_status: 'needs_login',
    balance: '-1.239',
    paid_balance: '37.000',
    balance_refresh_interval_minutes: 0,
    balance_error: 'Billing 需要登录',
    balance_refresh_status: 'needs_login',
    balance_refresh_message: '请在账号浏览器完成登录',
    last_error: '请补充登录',
    quota_blocked: true,
    call_status: 'quota_blocked',
    call_error: {
      code: 'insufficient_quota',
      message: '官方配额不足',
      at: '2026-11-03T12:00:00Z',
    },
    proxy: {
      id: 'proxy-one',
      name: '账号绑定代理',
      host: 'proxy.example.test',
      port: 1080,
      available: true,
    },
    today_requests: 12,
    today_cost: null,
    last_used_at: null,
    unpriced_requests: 1,
  }
})

describe('OpenAi_api management surface', () => {
  it('renders account state, precise balance and masked key without fetching secrets', () => {
    const html = renderToStaticMarkup(<OpenaiApiKeyPage />)
    expect(html).toContain('OpenAi_api')
    expect(html).toContain('one@example.test')
    expect(html).toContain('sk-proj-abcd…')
    expect(html).not.toContain('•••• 1234')
    expect(html).toContain('账号绑定代理 · proxy.example.test:1080')
    expect(html).not.toContain('proxy-one')
    expect(html).toContain('需要登录')
    expect(html).toContain('$-1.23')
    expect(html).toContain('额度阻断')
    expect(html).toContain('仅手动刷新')
    expect(html).toContain('今日估算费用')
    expect(html).toContain('未知')
    expect(html).toContain('绑定已有 key')
    expect(html).toContain('#/models?platform=openai')
    expect(controls.api).not.toHaveBeenCalled()
  })
  it('does not request the key list for a non-administrator', () => {
    controls.role = 'super'
    const html = renderToStaticMarkup(<OpenaiApiKeyPage />)
    expect(html).toContain('只有管理员')
    expect(html).not.toContain('one@example.test')
    expect(
      controls.queries.find((row) => row.queryKey.includes('openai-apikey'))
        ?.enabled
    ).toBe(false)
  })
  it('keeps invocation errors and management login separate and exposes account-filtered logs', () => {
    const noop = () => {}
    const html = renderToStaticMarkup(
      <ApiKeyDetailDialog
        item={controls.item}
        busy={false}
        onClose={noop}
        onToggle={noop}
        onRefresh={noop}
        onResume={noop}
        onReplace={noop}
        onDelete={noop}
      />
    )
    expect(html).toContain('最近调用错误 · insufficient_quota')
    expect(html).toContain('需要补充 Platform 登录')
    expect(html).toContain('余额刷新不会自动解除阻断')
    expect(html).toContain('官方 key 内容')
    expect(html).toContain('sk-proj-abcd…')
    expect(html).toContain('代理地址')
    expect(html).toContain('proxy.example.test:1080')
    expect(html).toContain('请在账号浏览器完成登录')
    expect(html).toContain('source_account_id=account-a')
    expect(html).toContain('保留领取、余额和历史日志，不撤销官方 key')
    expect(controls.api).not.toHaveBeenCalled()
  })
  it('explains direct manual saving and an empty eligible-account list', () => {
    const html = renderToStaticMarkup(
      <ApiKeyBindDialog candidates={[]} onClose={() => {}} />
    )
    expect(html).toContain('暂无可绑定账号')
    expect(html).toContain('直接保存，不发起官方验证或模型请求')
    expect(html).toContain('首次绑定默认开启 API 使用')
    expect(controls.api).not.toHaveBeenCalled()
  })
})
