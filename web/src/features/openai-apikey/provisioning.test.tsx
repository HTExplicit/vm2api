import type { ButtonHTMLAttributes } from 'react'
import type { OpenaiApiKeyEntry } from '@/types/panel-openai-apikey'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiKeyProvisioning } from './provisioning'

const controls = vi.hoisted(() => ({
  buttons: [] as ButtonHTMLAttributes<HTMLButtonElement>[],
  api: vi.fn(),
  invalidate: vi.fn(),
  browser: vi.fn(() => null),
}))
vi.mock('@/lib/api', () => ({ api: controls.api }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@tanstack/react-query', () => ({
  queryOptions: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: controls.invalidate }),
  useMutation: (options: {
    mutationFn: (action: string) => Promise<unknown>
    onSuccess: (data: unknown, action: string) => void
    onSettled: () => Promise<unknown>
  }) => ({
    isPending: false,
    mutate: async (action: string) => {
      options.onSuccess(await options.mutationFn(action), action)
      await options.onSettled()
    },
  }),
}))
vi.mock('@/components/ui/button', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => {
    controls.buttons.push(props)
    return <button disabled={props.disabled}>{props.children}</button>
  },
}))
vi.mock('@/features/vm/openai-platform-browser-dialog', () => ({
  OpenaiPlatformBrowserDialog: controls.browser,
}))

const candidate = {
  vm_id: 'slot / one',
  account_id: 'account-one',
  claim_status: 'eligible',
  pro_eligible: true,
  has_key: false,
  setup_status: 'idle',
  destinations: [
    { destination_account_id: 'org-demo', display_name: '示例组织' },
  ],
} as OpenaiApiKeyEntry
function render(item: Partial<OpenaiApiKeyEntry> = {}) {
  return renderToStaticMarkup(
    <ApiKeyProvisioning
      item={{ ...candidate, ...item }}
      busy={false}
      onBind={() => {}}
    />
  )
}
function button(label: string) {
  return controls.buttons.find((item) => item.children === label)
}
beforeEach(() => {
  controls.buttons = []
  controls.api.mockReset()
  controls.invalidate.mockReset()
  controls.browser.mockClear()
})

describe('OpenAI account provisioning', () => {
  it('claims the selected offer without starting Platform setup', async () => {
    const html = render()
    expect(html).toContain('领取赠额')
    expect(html).not.toContain('配置 API Key')
    await button('领取赠额')!.onClick!({} as never)
    expect(controls.api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/vms/slot%20%2F%20one/openai-api/claim',
      {
        method: 'POST',
        body: JSON.stringify({
          account_id: 'account-one',
          destination_account_id: 'org-demo',
        }),
      }
    )
    expect(controls.invalidate).toHaveBeenCalledWith({
      queryKey: ['panel', 'openai-apikey'],
    })
    expect(controls.browser).not.toHaveBeenCalled()
  })

  it('offers explicit setup and binding during delivery without opening a window', () => {
    const html = render({
      claim_status: 'pending',
      organization_id: 'org-demo',
      setup_status: 'needs_login',
    })
    expect(html).toContain('发放中')
    expect(html).toContain('配置 API Key')
    expect(html).toContain('绑定已有 Key')
    expect(html).toContain('刷新发放状态')
    expect(controls.api).not.toHaveBeenCalled()
    expect(controls.browser).not.toHaveBeenCalled()
  })

  it('presents a previously bound account as a connection instead of key creation', () => {
    const html = render({
      claim_status: 'claimed',
      has_key: true,
      setup_status: 'needs_login',
    })
    expect(html).toContain('连接 Platform')
    expect(html).not.toContain('配置 API Key')
    expect(html).not.toContain('绑定已有 Key')
    expect(controls.browser).not.toHaveBeenCalled()
  })
})
