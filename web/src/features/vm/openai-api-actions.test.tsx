import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'
import type { OpenaiApiView } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenaiApiDialog } from './openai-api-actions'

const controls = vi.hoisted(() => ({
  state: {} as OpenaiApiView,
  pending: false,
  buttons: [] as ButtonHTMLAttributes<HTMLButtonElement>[],
  api: vi.fn(),
  cached: vi.fn(),
  invalidate: vi.fn(),
  success: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: controls.api }))
vi.mock('sonner', () => ({
  toast: { success: controls.success, error: vi.fn() },
}))
vi.mock('@tanstack/react-query', () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({ data: controls.state, isError: false }),
  useQueryClient: () => ({
    setQueryData: controls.cached,
    invalidateQueries: controls.invalidate,
  }),
  useMutation: (options: {
    mutationFn: (variables: { name: string }) => Promise<OpenaiApiView>
    onSuccess: (data: OpenaiApiView, variables: { name: string }) => void
    onSettled: () => Promise<unknown>
  }) => ({
    isPending: controls.pending,
    variables: controls.pending ? { name: 'resume' } : undefined,
    mutate: async (variables: { name: string }) => {
      const data = await options.mutationFn(variables)
      options.onSuccess(data, variables)
      await options.onSettled()
    },
  }),
}))
vi.mock('@/components/ui/dialog', () => {
  const Content = ({ children }: PropsWithChildren) => <div>{children}</div>
  return {
    Dialog: Content,
    DialogContent: Content,
    DialogDescription: Content,
    DialogHeader: Content,
    DialogTitle: Content,
  }
})
vi.mock('@/components/ui/button', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => {
    controls.buttons.push(props)
    return <button disabled={props.disabled}>{props.children}</button>
  },
}))
vi.mock('@/features/vm/codex-credit-summary', () => ({
  CodexCreditSummary: () => null,
}))
vi.mock('@/features/vm/openai-platform-browser-dialog', () => ({
  OpenaiPlatformBrowserDialog: () => null,
}))

function render() {
  return renderToStaticMarkup(
    <OpenaiApiDialog
      vm={{
        id: 'slot / one',
        family: 'codex',
        platform: 'openai',
        openai_api: controls.state,
      }}
      open
      onOpenChange={() => {}}
    />
  )
}

function resumeButton() {
  return controls.buttons.find((props) =>
    renderToStaticMarkup(<>{props.children}</>).includes('额度阻断')
  )
}

beforeEach(() => {
  controls.state = {
    pro_eligible: false,
    claim_status: 'unknown',
    has_key: true,
    enabled: false,
    setup_status: 'ready',
    balance: '-0.01',
    balance_refresh_interval_minutes: 0,
    quota_blocked: true,
  }
  controls.pending = false
  controls.buttons = []
  controls.api.mockReset()
  controls.cached.mockReset()
  controls.invalidate.mockReset()
  controls.success.mockReset()
})

describe('account API quota recovery', () => {
  it('shows the upstream block separately from balance and sends only the resume action', async () => {
    const html = render()
    expect(html).toContain('上游已返回额度或配额不足')
    expect(html).toContain('余额刷新不会自动解除阻断')
    expect(html).toContain('仅手动刷新')
    const button = resumeButton()
    expect(button?.disabled).toBe(false)
    const next = { ...controls.state, quota_blocked: false }
    controls.api.mockResolvedValue(next)
    await button!.onClick!({} as never)
    expect(controls.api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/vms/slot%20%2F%20one/openai-api/resume',
      { method: 'POST', body: '{}' }
    )
    expect(controls.cached).toHaveBeenCalledWith(
      ['panel', 'vm', 'slot / one', 'openai-api'],
      expect.objectContaining({ quota_blocked: false, enabled: false })
    )
    expect(controls.invalidate).toHaveBeenCalledTimes(4)
  })

  it('does not offer quota recovery for an account without an upstream block', () => {
    controls.state = {
      ...controls.state,
      quota_blocked: false,
      balance_refresh_interval_minutes: 30,
    }
    const html = render()
    expect(html).not.toContain('解除额度阻断')
    expect(html).toContain('余额每 30 分钟自动刷新')
    expect(resumeButton()).toBeUndefined()
    expect(controls.api).not.toHaveBeenCalled()
  })

  it('disables the recovery button while its action is pending', () => {
    controls.pending = true
    const html = render()
    expect(html).toContain('解除中…')
    expect(
      controls.buttons.some(
        (props) => props.disabled && props.children === '解除中…'
      )
    ).toBe(true)
  })
})
