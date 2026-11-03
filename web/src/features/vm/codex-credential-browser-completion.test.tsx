import type { ButtonHTMLAttributes } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexCredentialPanel } from './codex-credential-panel'
import type { CommitResult } from './credential-panel'

type BrowserProps = {
  vmId: string
  purpose: 'oauth' | 'platform'
  open: boolean
  onOpenChange: (open: boolean) => void
  onCredentialsSaved?: (result?: CommitResult) => void
  onComplete?: (result?: CommitResult) => void
}

const controls = vi.hoisted(() => ({
  cursor: 0,
  hooks: [] as unknown[],
  buttons: [] as ButtonHTMLAttributes<HTMLButtonElement>[],
  browser: null as BrowserProps | null,
  api: vi.fn(),
  committed: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

// Preserve the real query client/context while rendering local parent state
// explicitly in this project's DOM-free React test environment.
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

vi.mock('@/lib/api', () => ({ api: controls.api }))
vi.mock('sonner', () => ({
  toast: {
    info: controls.info,
    success: controls.success,
    error: controls.error,
  },
}))
vi.mock('@/features/vm/vm-perms', () => ({
  useVmPerms: () => ({ admin: true }),
}))
vi.mock('@/features/vm/openai-platform-browser-dialog', () => ({
  SlotBrowserDialog: (props: BrowserProps) => {
    controls.browser = props
    return <div aria-label='GPT 登录向导' />
  },
}))
vi.mock('@/components/ui/button', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => {
    controls.buttons.push(props)
    return <button disabled={props.disabled}>{props.children}</button>
  },
}))

let client: QueryClient

function render(withCommitted = true) {
  controls.cursor = 0
  controls.buttons = []
  controls.browser = null
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CodexCredentialPanel
        vm={{ id: 'slot-a', family: 'codex', platform: 'openai' }}
        onCommitted={withCommitted ? controls.committed : undefined}
      />
    </QueryClientProvider>
  )
}

function openBrowser(withCommitted = true) {
  render(withCommitted)
  const entry = controls.buttons.find((props) =>
    renderToStaticMarkup(<>{props.children}</>).includes('浏览器登录')
  )
  expect(entry?.disabled).toBe(false)
  entry!.onClick!({} as never)
  expect(render(withCommitted)).toContain('GPT 登录向导')
  expect(controls.browser).toMatchObject({
    vmId: 'slot-a',
    purpose: 'oauth',
    open: true,
  })
  return controls.browser!
}

beforeEach(() => {
  controls.cursor = 0
  controls.hooks = []
  controls.buttons = []
  controls.browser = null
  controls.api.mockReset()
  controls.committed.mockReset()
  controls.info.mockReset()
  controls.success.mockReset()
  controls.error.mockReset()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

afterEach(() => {
  client.clear()
  vi.restoreAllMocks()
})

describe('GPT browser credential parent completion', () => {
  it('refreshes saved credentials and explains the remaining boot step without completing', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const browser = openBrowser()
    browser.onCredentialsSaved?.({ oauth_email: 'user@example.test' })

    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual(
      [
        ['panel', 'dashboard'],
        ['panel', 'vm', 'slot-a'],
        ['panel', 'vms'],
      ]
    )
    expect(controls.info).toHaveBeenCalledExactlyOnceWith(
      'GPT 登录凭据已保存，请开机完成配置'
    )
    expect(controls.committed).not.toHaveBeenCalled()
    expect(controls.success).not.toHaveBeenCalled()
    expect(controls.api).not.toHaveBeenCalled()
    expect(render()).toContain('GPT 登录向导')
  })

  it.each([false, true])(
    'does not complete on an ordinary close (credentials saved: %s)',
    (saved) => {
      const browser = openBrowser()
      if (saved)
        browser.onCredentialsSaved?.({ oauth_email: 'user@example.test' })
      browser.onOpenChange(false)

      expect(render()).not.toContain('GPT 登录向导')
      expect(controls.committed).not.toHaveBeenCalled()
      expect(controls.success).not.toHaveBeenCalled()
      expect(controls.api).not.toHaveBeenCalled()
    }
  )

  it('commits the original result only after the child reports final completion', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const result = { oauth_email: 'user@example.test' }
    const browser = openBrowser()
    browser.onCredentialsSaved?.(result)
    expect(controls.committed).not.toHaveBeenCalled()

    browser.onComplete?.(result)
    expect(controls.committed).toHaveBeenCalledExactlyOnceWith(
      result,
      'slot-a',
      'GPT 登录完成，已开机并开启调度'
    )
    expect(invalidate).toHaveBeenCalledTimes(6)
    expect(controls.success).not.toHaveBeenCalled()

    browser.onOpenChange(false)
    render()
    expect(controls.committed).toHaveBeenCalledOnce()
  })

  it('can complete a recovered login whose saved result was unavailable', () => {
    const browser = openBrowser()
    browser.onComplete?.()
    expect(controls.committed).toHaveBeenCalledExactlyOnceWith(
      {},
      'slot-a',
      'GPT 登录完成，已开机并开启调度'
    )
  })

  it('shows final success locally when no outer completion handler is provided', () => {
    const browser = openBrowser(false)
    browser.onCredentialsSaved?.()
    expect(controls.success).not.toHaveBeenCalled()

    browser.onComplete?.()
    expect(controls.success).toHaveBeenCalledExactlyOnceWith(
      'GPT 登录完成，已开机并开启调度'
    )
    expect(controls.committed).not.toHaveBeenCalled()
  })
})
