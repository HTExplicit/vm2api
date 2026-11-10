import type { ButtonHTMLAttributes } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CredentialPanel, type CommitResult } from './credential-panel'

type BrowserProps = {
  provider: string
  flavor: string
  completionMode: string
  onOpenChange: (open: boolean) => void
  onCredentialsSaved: (result?: CommitResult) => void
  onComplete: (result?: CommitResult) => void
}

const controls = vi.hoisted(() => ({
  cursor: 0,
  hooks: [] as unknown[],
  buttons: [] as ButtonHTMLAttributes<HTMLButtonElement>[],
  browser: null as BrowserProps | null,
  admin: true,
  committed: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
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

vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}))
vi.mock('sonner', () => ({
  toast: { info: controls.info, success: controls.success },
}))
vi.mock('@/features/vm/vm-perms', () => ({
  useVmPerms: () => ({ admin: controls.admin }),
}))
vi.mock('@/features/vm/openai-platform-browser-dialog', () => ({
  SlotBrowserDialog: (props: BrowserProps) => {
    controls.browser = props
    return <div aria-label='Claude 登录向导' />
  },
}))
vi.mock('@/components/ui/button', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => {
    controls.buttons.push(props)
    return <button disabled={props.disabled}>{props.children}</button>
  },
}))
vi.mock('@/features/vm/convert-oauth-button', () => ({
  ConvertOauthToSetupButton: () => null,
}))

let client: QueryClient

function render(
  completionMode: 'start_and_schedule' | 'preserve_state' = 'preserve_state'
) {
  controls.cursor = 0
  controls.buttons = []
  controls.browser = null
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CredentialPanel
        vm={{ id: 'claude-a', platform: 'anthropic' }}
        showConvert={false}
        browserCompletionMode={completionMode}
        onCommitted={controls.committed}
      />
    </QueryClientProvider>
  )
}

function click(label: string) {
  const button = controls.buttons.find((props) =>
    renderToStaticMarkup(<>{props.children}</>).includes(label)
  )
  expect(button, label).toBeDefined()
  button!.onClick!({} as never)
}

function choose(
  method: 'Claude Code' | '授权链接',
  completionMode: 'start_and_schedule' | 'preserve_state' = 'preserve_state'
) {
  render(completionMode)
  click('OAuth')
  render(completionMode)
  click(method)
  return render(completionMode)
}

beforeEach(() => {
  controls.cursor = 0
  controls.hooks = []
  controls.buttons = []
  controls.browser = null
  controls.admin = true
  controls.committed.mockReset()
  controls.info.mockReset()
  controls.success.mockReset()
  client = new QueryClient()
})

afterEach(() => {
  client.clear()
})

describe('Claude credential browser entry', () => {
  it('keeps the existing Setup Token and Cookie defaults', () => {
    const html = render()
    expect(html).toContain('sessionKey / access token')
    expect(html).not.toContain('浏览器登录')
    click('OAuth')
    expect(render()).not.toContain('浏览器登录')
  })

  it.each([
    ['Claude Code', 'claude_code'],
    ['授权链接', 'cai'],
  ] as const)(
    'opens %s browser login using its existing OAuth flavor',
    (method, flavor) => {
      expect(choose(method)).toContain('浏览器登录')
      click('浏览器登录')
      expect(render()).toContain('Claude 登录向导')
      expect(controls.browser).toMatchObject({
        provider: 'anthropic',
        flavor,
        completionMode: 'preserve_state',
      })
    }
  )

  it('hides browser login from non-administrators and Console credentials', () => {
    controls.admin = false
    expect(choose('授权链接')).not.toContain('浏览器登录')
    controls.admin = true
    render()
    click('Console')
    expect(render()).not.toContain('浏览器登录')
  })

  it('reports saved credentials separately and marks final browser completion for the parent', () => {
    choose('授权链接')
    click('浏览器登录')
    render()
    const browser = controls.browser!
    const result = { oauth_email: 'claude@example.test' }
    browser.onCredentialsSaved(result)
    expect(controls.info).toHaveBeenCalledWith(
      'Claude 登录凭据已保存，保留当前启停和调度设置'
    )
    expect(controls.committed).not.toHaveBeenCalled()
    browser.onComplete(result)
    expect(controls.committed).toHaveBeenCalledExactlyOnceWith(
      { ...result, completion: 'browser_oauth' },
      'claude-a',
      'Claude 登录完成，已保留当前启停和调度设置'
    )
  })

  it('passes the import wizard completion mode and does not complete on ordinary close', () => {
    choose('Claude Code', 'start_and_schedule')
    click('浏览器登录')
    render('start_and_schedule')
    expect(controls.browser?.completionMode).toBe('start_and_schedule')
    controls.browser!.onOpenChange(false)
    expect(render('start_and_schedule')).not.toContain('Claude 登录向导')
    expect(controls.committed).not.toHaveBeenCalled()
  })
})
