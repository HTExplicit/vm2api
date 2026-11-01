import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenaiPlatformBrowserDialog } from './openai-platform-browser-dialog'

const controls = vi.hoisted(() => ({
  cursor: 0,
  hooks: [] as unknown[],
  effects: [] as (() => void | (() => void))[],
  cleanup: [] as (() => void)[],
  buttons: [] as ButtonHTMLAttributes<HTMLButtonElement>[],
  api: vi.fn(),
  complete: vi.fn(),
}))

// Exercise the component's real effects and event handlers with explicit renders;
// this project uses the Node test environment without a browser DOM.
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
      if (!(index in controls.hooks)) controls.hooks[index] = initial
      return [
        controls.hooks[index],
        (value: unknown) => {
          controls.hooks[index] =
            typeof value === 'function' ? value(controls.hooks[index]) : value
        },
      ]
    },
    useEffect: (effect: () => void | (() => void)) => {
      const index = controls.cursor++
      if (!(index in controls.hooks)) {
        controls.hooks[index] = true
        controls.effects.push(effect)
      }
    },
  }
})

vi.mock('@/lib/api', () => ({ api: controls.api }))
vi.mock('@/lib/session', () => ({ apiBase: () => 'https://panel.example' }))
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
    return (
      <button disabled={props.disabled} aria-label={props['aria-label']}>
        {props.children}
      </button>
    )
  },
}))

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = Socket.OPEN
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  send = vi.fn()
  close = vi.fn()

  constructor(readonly url: URL) {
    Socket.instances.push(this)
  }

  status(status: string, message?: string) {
    this.onmessage?.({
      data: JSON.stringify({
        type: 'status',
        status,
        message,
        purpose: 'platform',
      }),
    })
  }
}

function render() {
  controls.cursor = 0
  controls.buttons = []
  return renderToStaticMarkup(
    <OpenaiPlatformBrowserDialog
      vmId='slot-a'
      open
      onOpenChange={() => {}}
      onComplete={controls.complete}
    />
  )
}

async function mount() {
  render()
  for (const effect of controls.effects.splice(0)) {
    const cleanup = effect()
    if (cleanup) controls.cleanup.push(cleanup)
  }
  for (let index = 0; index < 6; index++) await Promise.resolve()
  expect(Socket.instances).toHaveLength(1)
  const socket = Socket.instances[0]
  socket.onopen?.()
  render()
  return socket
}

function button(label: string) {
  return controls.buttons.find((props) => props['aria-label'] === label)
}

beforeEach(() => {
  controls.cursor = 0
  controls.hooks = []
  controls.effects = []
  controls.cleanup = []
  controls.buttons = []
  controls.api
    .mockReset()
    .mockImplementation(async (path: string) =>
      path.endsWith('/browser-ticket')
        ? { ticket: 'one-time', url: '/api/panel/vms/slot-a/browser' }
        : { active: true }
    )
  controls.complete.mockReset()
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
})

afterEach(() => {
  for (const cleanup of controls.cleanup) cleanup()
  vi.unstubAllGlobals()
})

describe('Platform key setup handoff', () => {
  it.each([
    ['awaiting_key_input', '检查创建结果'],
    ['key_save_failed', '重试保存'],
  ])(
    'keeps %s in the current browser and sends continue',
    async (status, label) => {
      const socket = await mount()
      socket.status('error', '此前的期限选择错误')
      expect(render()).toContain('此前的期限选择错误')
      socket.status(status)
      const html = render()
      expect(html).not.toContain('此前的期限选择错误')
      expect(html).not.toContain('role="alert"')
      const action = button(label)
      expect(action?.disabled).toBe(false)
      const requestsBefore = controls.api.mock.calls.length
      socket.send.mockClear()
      action!.onClick!({} as never)
      action!.onClick!({} as never)
      expect(
        socket.send.mock.calls.map(([payload]) => JSON.parse(payload))
      ).toEqual([
        { type: 'continue', seq: 1 },
        { type: 'continue', seq: 2 },
      ])
      expect(controls.api).toHaveBeenCalledTimes(requestsBefore)
      expect(controls.complete).not.toHaveBeenCalled()
    }
  )

  it('shows a save failure as recoverable guidance and resumes normal progress', async () => {
    const socket = await mount()
    socket.status('key_save_failed', '本地保存失败，请保留窗口并重试保存')
    const failed = render()
    expect(failed).toContain('本地保存失败，请保留窗口并重试保存')
    expect(button('重试保存')?.disabled).toBe(false)
    socket.status('configuring')
    render()
    expect(button('正在配置…')?.disabled).toBe(true)
    socket.status('api_ready')
    const completed = render()
    expect(completed).not.toContain('本地保存失败')
    expect(button('API 配置已完成')?.disabled).toBe(true)
    expect(controls.complete).toHaveBeenCalledTimes(1)
    socket.status('api_ready')
    expect(controls.complete).toHaveBeenCalledTimes(1)
  })

  it('still restarts configuration for a terminal error', async () => {
    const socket = await mount()
    socket.status('error', '账号验证失败')
    render()
    const requestsBefore = controls.api.mock.calls.length
    button('重试配置')!.onClick!({} as never)
    await Promise.resolve()
    expect(controls.api).toHaveBeenCalledTimes(requestsBefore + 1)
    expect(controls.api).toHaveBeenLastCalledWith(
      '/api/panel/vms/slot-a/browser/open',
      {
        method: 'POST',
        body: JSON.stringify({ purpose: 'platform' }),
      }
    )
  })
})
