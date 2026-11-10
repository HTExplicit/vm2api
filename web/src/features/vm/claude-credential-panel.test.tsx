import type {
  ButtonHTMLAttributes,
  ComponentProps,
  PropsWithChildren,
} from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardFlow } from '@/features/import/onboard-flow'
import { VmAccountTab } from './detail-account-tab'
import { VmReauthDialog } from './vm-reauth-dialog'

const controls = vi.hoisted(() => ({
  cursor: 0,
  hooks: [] as unknown[],
  buttons: [] as ButtonHTMLAttributes<HTMLButtonElement>[],
  api: vi.fn(),
  committed: vi.fn(),
  terminal: vi.fn(),
  selectSlot: null as null | ((id: string) => void),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useRef: (initial: unknown) => {
      const index = controls.cursor++
      if (!(index in controls.hooks))
        controls.hooks[index] = { current: initial }
      return controls.hooks[index]
    },
    useState: (initial: unknown) => {
      const index = controls.cursor++
      if (!(index in controls.hooks))
        controls.hooks[index] =
          typeof initial === 'function' ? initial() : initial
      return [
        controls.hooks[index],
        (value: unknown) => {
          controls.hooks[index] =
            typeof value === 'function' ? value(controls.hooks[index]) : value
        },
      ]
    },
    useEffect: () => {
      controls.cursor++
    },
  }
})

const vm = {
  id: 'claude-manual',
  name: 'Claude manual fixture',
  platform: 'anthropic',
  status: 'running',
  has_token: false,
  can_import_credential: true,
  proxy_id: 'fixture-proxy',
}

vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey.includes('dashboard') ? { vms: [vm] } : {},
    refetch: vi.fn(),
  }),
  useMutation: (options: {
    mutationFn: (value: unknown) => Promise<unknown>
    onSuccess?: (result: unknown) => unknown
  }) => ({
    isPending: false,
    mutate: async (value: unknown) => {
      const result = await options.mutationFn(value)
      await options.onSuccess?.(result)
    },
  }),
}))
vi.mock('@/lib/api', () => ({ api: controls.api }))
vi.mock('sonner', () => ({ toast: controls.toast }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: PropsWithChildren) => <span>{children}</span>,
}))
vi.mock('@/features/vm/vm-perms', () => ({
  useVmPerms: () => ({ admin: true, credential: true }),
}))
vi.mock('@/features/vm/login-terminal-start', () => ({
  prepareLoginTerminal: controls.terminal,
}))
vi.mock('@/features/vm/convert-oauth-button', () => ({
  ConvertOauthToSetupButton: () => null,
}))
vi.mock('@/features/vm/credential-editor', () => ({
  CredentialEditorButton: () => null,
}))
vi.mock('@/features/vm/auth-scheme-editor', () => ({
  AuthSchemeEditor: () => null,
}))
vi.mock('@/features/vm/allowed-models-card', () => ({
  AllowedModelsCard: () => null,
}))
vi.mock('@/features/vm/vm-package-dialog', () => ({
  VmPackageButton: () => null,
}))
vi.mock('@/features/import/import-proxy-step', () => ({
  ImportProxyStep: () => null,
}))
vi.mock('@/features/vm/create-vm-form', () => ({
  useCreateVmDraft: ({ onCreated }: { onCreated: (id: string) => void }) => {
    controls.selectSlot = onCreated
    return {}
  },
  CreateVmForm: () => <p>槽位配置</p>,
  SpecSheet: () => null,
  draftSpecRows: () => [],
  machineLine: () => '',
}))
vi.mock('@/components/ui/button', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => {
    controls.buttons.push(props)
    return <button disabled={props.disabled}>{props.children}</button>
  },
}))
vi.mock('@/components/ui/tabs', () => ({
  TabsContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
}))
vi.mock('@/components/ui/tooltip', () => {
  const Part = ({ children }: PropsWithChildren) => <span>{children}</span>
  return { Tooltip: Part, TooltipContent: Part, TooltipTrigger: Part }
})
vi.mock('@/components/ui/dialog', () => {
  const Part = ({ children }: PropsWithChildren) => <div>{children}</div>
  return {
    Dialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) =>
      open ? <div>{children}</div> : null,
    DialogContent: Part,
    DialogDescription: Part,
    DialogHeader: Part,
    DialogTitle: Part,
  }
})

type Surface = 'import' | 'detail' | 'reauth'
let client: QueryClient

function render(surface: Surface) {
  controls.cursor = 0
  controls.buttons = []
  const detailProps: ComponentProps<typeof VmAccountTab> = {
    id: vm.id,
    vm,
    acc: {},
    dash: { data: undefined },
    credType: 'none',
    officialCc: false,
    u5: 0,
    u7: 0,
    tierKey: '',
    todayReadCache: 0,
    todayWriteCache: 0,
    todayHit: null,
    today: { requests: 0, input: 0, output: 0 },
    canRefresh: false,
    refreshBlocked: '',
    busy: () => false,
    onNeedProxy: vi.fn(),
    onAction: vi.fn(),
    onCredentialCommitted: controls.committed,
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {surface === 'import' ? (
        <OnboardFlow />
      ) : surface === 'detail' ? (
        <VmAccountTab {...detailProps} />
      ) : (
        <VmReauthDialog vm={vm} onOpenChange={vi.fn()} />
      )}
    </QueryClientProvider>
  )
}

function click(label: string) {
  const props = controls.buttons.find(
    (button) => renderToStaticMarkup(<>{button.children}</>) === label
  )
  expect(props, label).toBeDefined()
  props!.onClick!({} as never)
}

beforeEach(() => {
  controls.cursor = 0
  controls.hooks = []
  controls.buttons = []
  controls.selectSlot = null
  controls.api.mockReset().mockResolvedValue({
    auth_url: 'https://claude.ai/oauth/authorize?state=fixture',
    session_id: 'fixture-session',
  })
  controls.terminal.mockReset().mockResolvedValue({})
  controls.committed.mockReset()
  client = new QueryClient()
})
afterEach(() => {
  client.clear()
})

describe('Claude manual credential entry after browser login removal', () => {
  it.each(['import', 'detail', 'reauth'] as const)(
    'keeps Cookie, manual links and the official terminal without a browser entry on %s',
    async (surface) => {
      render(surface)
      if (surface === 'import') {
        controls.selectSlot!(vm.id)
        render(surface)
      }
      click('OAuth')
      let html = render(surface)
      expect(html).toContain('sessionKey / access token')
      expect(html).not.toContain('浏览器登录')
      click('授权链接')
      html = render(surface)
      expect(html).toContain('生成授权链接')
      expect(html).not.toContain('浏览器登录')
      click('生成授权链接')
      await new Promise((resolve) => setTimeout(resolve, 0))
      html = render(surface)
      expect(controls.api).toHaveBeenCalledWith(
        `/api/panel/vms/${vm.id}/oauth/generate-auth-url`,
        {
          method: 'POST',
          body: JSON.stringify({ flavor: 'cai', force: false }),
        }
      )
      expect(html).toContain('完整授权码，含 # 后半段')
      expect(html).not.toContain('浏览器登录')
      click('Claude Code')
      html = render(surface)
      expect(html).toContain('打开官方登录终端')
      expect(html).not.toContain('浏览器登录')
      click('打开官方登录终端')
      await new Promise((resolve) => setTimeout(resolve, 0))
      html = render(surface)
      expect(controls.terminal).toHaveBeenCalledWith(vm)
      expect(html).toContain('Claude Code 登录')
      expect(html).toContain('回填 callback code')
      expect(html).not.toContain('浏览器登录')
      expect(
        controls.api.mock.calls.some(([path]) => /\/browser(?:\/|$)/.test(path))
      ).toBe(false)
    }
  )
})
