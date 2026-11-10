import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OpenaiPlatformBrowserDialog,
  SlotBrowserDialog,
} from './openai-platform-browser-dialog'

const controls = vi.hoisted(() => ({
  cursor: 0,
  hooks: [] as unknown[],
  effects: [] as (() => void | (() => void))[],
  cleanup: [] as (() => void)[],
  effectCleanup: [] as (() => void | undefined)[],
  buttons: [] as ButtonHTMLAttributes<HTMLButtonElement>[],
  api: vi.fn(),
  complete: vi.fn(),
  saved: vi.fn(),
  changeOpen: vi.fn(),
  purpose: 'platform' as 'oauth' | 'platform',
  provider: 'openai' as 'openai' | 'anthropic',
  flavor: 'cai' as 'cai' | 'claude_code',
  completionMode: 'start_and_schedule' as
    'start_and_schedule' | 'preserve_state',
  vmId: 'slot-a',
  open: true,
  dialogChange: null as null | ((open: boolean) => void),
  content: null as null | Record<string, (...args: never[]) => void>,
  toastError: vi.fn(),
  toastWarning: vi.fn(),
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
    useEffect: (
      effect: () => void | (() => void),
      deps: readonly unknown[]
    ) => {
      const index = controls.cursor++
      const previous = controls.hooks[index] as unknown[] | undefined
      if (
        !previous ||
        deps.some((dependency, at) => !Object.is(dependency, previous[at]))
      ) {
        controls.hooks[index] = deps
        controls.effects.push(() => {
          controls.effectCleanup[index]?.()
          const cleanup = effect()
          controls.effectCleanup[index] = cleanup || (() => {})
        })
      }
    },
  }
})

vi.mock('@/lib/api', () => ({ api: controls.api }))
vi.mock('@/lib/session', () => ({ apiBase: () => 'https://panel.example' }))
vi.mock('sonner', () => ({
  toast: { error: controls.toastError, warning: controls.toastWarning },
}))
vi.mock('@/components/ui/dialog', () => {
  const Content = ({ children }: PropsWithChildren) => <div>{children}</div>
  return {
    Dialog: ({
      children,
      onOpenChange,
    }: PropsWithChildren<{ onOpenChange: (open: boolean) => void }>) => {
      controls.dialogChange = onOpenChange
      return <div>{children}</div>
    },
    DialogContent: (props: PropsWithChildren<Record<string, unknown>>) => {
      controls.content = props as typeof controls.content
      return <div>{props.children}</div>
    },
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

  status(
    status: string,
    message?: string,
    result?: Record<string, unknown>,
    purpose = controls.purpose
  ) {
    this.onmessage?.({
      data: JSON.stringify({
        type: 'status',
        status,
        message,
        purpose,
        result,
      }),
    })
  }
}

function render() {
  controls.cursor = 0
  controls.buttons = []
  return renderToStaticMarkup(
    controls.purpose === 'platform' ? (
      <OpenaiPlatformBrowserDialog
        vmId={controls.vmId}
        open={controls.open}
        onOpenChange={controls.changeOpen}
        onComplete={controls.complete}
      />
    ) : (
      <SlotBrowserDialog
        vmId={controls.vmId}
        purpose='oauth'
        provider={controls.provider}
        flavor={controls.flavor}
        completionMode={controls.completionMode}
        open={controls.open}
        onOpenChange={controls.changeOpen}
        onCredentialsSaved={controls.saved}
        onComplete={controls.complete}
      />
    )
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
  controls.effectCleanup = []
  controls.buttons = []
  controls.api
    .mockReset()
    .mockImplementation(async (path: string) =>
      path.endsWith('/browser-ticket')
        ? { ticket: 'one-time', url: '/api/panel/vms/slot-a/browser' }
        : { active: true }
    )
  controls.complete.mockReset()
  controls.saved.mockReset()
  controls.changeOpen.mockReset()
  controls.toastError.mockReset()
  controls.toastWarning.mockReset()
  controls.purpose = 'platform'
  controls.provider = 'openai'
  controls.flavor = 'cai'
  controls.completionMode = 'start_and_schedule'
  controls.vmId = 'slot-a'
  controls.open = true
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
})

afterEach(() => {
  for (const cleanup of controls.cleanup) cleanup()
  for (const cleanup of controls.effectCleanup) cleanup?.()
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

function health() {
  return {
    id: 'slot-a',
    kernel: {
      codex_health: {
        vm_id: 'slot-a',
        reachable: true,
        process_up: true,
        status: 200,
      },
    },
  }
}

function loginRequests(path: string) {
  if (path.endsWith('/health')) return health()
  if (path.endsWith('/schedulable')) return { id: 'slot-a', schedulable: true }
  if (path.endsWith('/browser-ticket'))
    return { ticket: 'one-time', url: '/api/panel/vms/slot-a/browser' }
  return { active: true, boot: { rust_ok: true } }
}

async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

describe('OAuth browser login completion', () => {
  beforeEach(() => {
    controls.purpose = 'oauth'
    controls.api.mockImplementation(async (path: string) => loginRequests(path))
  })

  it('saves credentials first and completes only after a successful boot and an explicit final click', async () => {
    const socket = await mount()
    socket.status('oauth_complete')
    let html = render()
    expect(controls.saved).toHaveBeenCalledTimes(1)
    expect(controls.complete).not.toHaveBeenCalled()
    expect(html).toContain('登录凭据已保存')
    expect(html).not.toContain('继续进入 Platform')
    expect(
      controls.api.mock.calls.some(([path]) => path.endsWith('/start'))
    ).toBe(false)

    const savedResult = { oauth_email: 'saved@example.test' }
    socket.status('oauth_complete', undefined, savedResult)
    render()
    expect(controls.saved).toHaveBeenCalledTimes(1)
    button('开机并完成')!.onClick!({} as never)
    await settle()
    html = render()
    expect(html).toContain('内核已就绪，调度已开启')
    expect(html).toContain('继续进入 Platform')
    expect(button('完成')?.disabled).not.toBe(true)
    expect(controls.complete).not.toHaveBeenCalled()
    button('完成')!.onClick!({} as never)
    button('完成')!.onClick!({} as never)
    await settle()
    expect(controls.complete).toHaveBeenCalledExactlyOnceWith(savedResult)
    expect(controls.changeOpen).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('holds the boot state through repeated statuses and a disconnected browser without duplicate starts', async () => {
    let resolveStart!: (value: unknown) => void
    controls.api.mockImplementation((path: string) =>
      path.endsWith('/start')
        ? new Promise((resolve) => {
            resolveStart = resolve
          })
        : Promise.resolve(loginRequests(path))
    )
    const socket = await mount()
    socket.status('oauth_complete')
    render()
    const start = button('开机并完成')!
    start.onClick!({} as never)
    start.onClick!({} as never)
    socket.onclose?.()
    socket.status('oauth_complete', '此前的授权完成文案')
    const html = render()
    expect(html).toContain('正在开机并启动内核')
    expect(button('正在开机…')?.disabled).toBe(true)
    expect(controls.saved).toHaveBeenCalledTimes(1)
    expect(
      controls.api.mock.calls.filter(([path]) => path.endsWith('/start'))
    ).toHaveLength(1)
    resolveStart({ boot: { rust_ok: true } })
    await settle()
    render()
    expect(button('完成')).toBeDefined()
  })

  it('keeps saved credentials after a scheduling error and retries scheduling without starting again', async () => {
    let scheduleSucceeds = false
    controls.api.mockImplementation(async (path: string) =>
      path.endsWith('/schedulable')
        ? { id: 'slot-a', schedulable: scheduleSucceeds }
        : loginRequests(path)
    )
    const socket = await mount()
    socket.status('oauth_complete')
    render()
    button('开机并完成')!.onClick!({} as never)
    await settle()
    expect(render()).toContain('调度尚未确认开启')
    expect(controls.complete).not.toHaveBeenCalled()
    const requestsBefore = controls.api.mock.calls.length
    scheduleSucceeds = true
    button('重试开启调度')!.onClick!({} as never)
    await settle()
    render()
    expect(
      controls.api.mock.calls.slice(requestsBefore).map(([path]) => path)
    ).toEqual([
      '/api/panel/vms/slot-a/health',
      '/api/panel/vms/slot-a/schedulable',
    ])
    expect(button('完成')).toBeDefined()
  })

  it('allows closing after saving without reporting final completion', async () => {
    const socket = await mount()
    socket.status('oauth_complete')
    render()
    controls.dialogChange!(false)
    await settle()
    expect(controls.saved).toHaveBeenCalledTimes(1)
    expect(controls.complete).not.toHaveBeenCalled()
    expect(controls.changeOpen).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('does not continue boot side effects after the window is closed', async () => {
    let resolveStart!: (value: unknown) => void
    controls.api.mockImplementation((path: string) =>
      path.endsWith('/start')
        ? new Promise((resolve) => {
            resolveStart = resolve
          })
        : Promise.resolve(loginRequests(path))
    )
    const socket = await mount()
    socket.status('oauth_complete')
    render()
    button('开机并完成')!.onClick!({} as never)
    controls.dialogChange!(false)
    resolveStart({ boot: { rust_ok: true } })
    await settle()
    expect(
      controls.api.mock.calls.some(([path]) => path.endsWith('/health'))
    ).toBe(false)
    expect(
      controls.api.mock.calls.some(([path]) => path.endsWith('/schedulable'))
    ).toBe(false)
    expect(controls.complete).not.toHaveBeenCalled()
  })

  it('ignores an old boot result after switching to another slot', async () => {
    let resolveStart!: (value: unknown) => void
    controls.api.mockImplementation((path: string) =>
      path.endsWith('/start')
        ? new Promise((resolve) => {
            resolveStart = resolve
          })
        : Promise.resolve(loginRequests(path))
    )
    const socket = await mount()
    socket.status('oauth_complete')
    render()
    button('开机并完成')!.onClick!({} as never)
    controls.vmId = 'slot-b'
    render()
    for (const effect of controls.effects.splice(0)) effect()
    await settle()
    resolveStart({ boot: { rust_ok: true } })
    await settle()
    const html = render()
    expect(html).not.toContain('内核已就绪，调度已开启')
    expect(button('开机并完成')).toBeUndefined()
    expect(
      controls.api.mock.calls.some(([path]) => path.endsWith('/health'))
    ).toBe(false)
    expect(controls.complete).not.toHaveBeenCalled()
  })

  it('does not continue a pending boot after the component unmounts directly', async () => {
    let resolveStart!: (value: unknown) => void
    controls.api.mockImplementation((path: string) =>
      path.endsWith('/start')
        ? new Promise((resolve) => {
            resolveStart = resolve
          })
        : Promise.resolve(loginRequests(path))
    )
    const socket = await mount()
    socket.status('oauth_complete')
    render()
    button('开机并完成')!.onClick!({} as never)
    for (const cleanup of controls.effectCleanup) cleanup?.()
    resolveStart({ boot: { rust_ok: true } })
    await settle()
    expect(
      controls.api.mock.calls.some(([path]) => path.endsWith('/health'))
    ).toBe(false)
    expect(
      controls.api.mock.calls.some(([path]) => path.endsWith('/schedulable'))
    ).toBe(false)
    expect(controls.complete).not.toHaveBeenCalled()
  })

  it('retains the recoverable browser session warning while allowing the boot step', async () => {
    const socket = await mount()
    socket.status(
      'oauth_complete',
      'OpenAI 凭据已保存；网页会话保存失败，需要时可重新登录 Platform。'
    )
    const html = render()
    expect(html).toContain('网页会话保存失败')
    expect(button('开机并完成')?.disabled).toBe(false)
    expect(controls.complete).not.toHaveBeenCalled()
  })
})

describe('Claude OAuth browser login', () => {
  beforeEach(() => {
    controls.purpose = 'oauth'
    controls.provider = 'anthropic'
    controls.api.mockImplementation(async (path: string) => {
      if (path.endsWith('/health'))
        return {
          id: 'slot-a',
          kernel: {
            rust_health: { reachable: true, process_up: true, status: 200 },
          },
        }
      if (path === '/api/panel/vms/slot-a')
        return {
          vm: { id: 'slot-a', status: 'running', runtime: { stopped: false } },
        }
      return loginRequests(path)
    })
  })

  it.each(['cai', 'claude_code'] as const)(
    'opens the selected %s flow with Claude labels',
    async (flavor) => {
      controls.flavor = flavor
      await mount()
      const html = render()
      expect(controls.api).toHaveBeenCalledWith(
        '/api/panel/vms/slot-a/browser/open',
        {
          method: 'POST',
          body: JSON.stringify({ purpose: 'oauth', flavor }),
        }
      )
      expect(html).toContain('Claude 浏览器登录')
      expect(html).not.toContain('OpenAI')
      expect(html).not.toContain('Platform')
    }
  )

  it('preserves power and scheduling on reauthorization and completes only after browser close', async () => {
    controls.completionMode = 'preserve_state'
    const socket = await mount()
    const result = { oauth_email: 'claude@example.test' }
    socket.status('oauth_complete', undefined, result)
    const html = render()
    expect(html).toContain('保留当前启停和调度设置')
    expect(button('开机并完成')).toBeUndefined()
    expect(button('完成')?.disabled).not.toBe(true)
    expect(controls.saved).toHaveBeenCalledExactlyOnceWith(result)
    expect(controls.complete).not.toHaveBeenCalled()
    button('完成')!.onClick!({} as never)
    await settle()
    expect(controls.complete).toHaveBeenCalledExactlyOnceWith(result)
    expect(
      controls.api.mock.calls.some(([path]) =>
        /\/(start|health|schedulable)$/.test(path)
      )
    ).toBe(false)
  })

  it('starts and verifies Claude before scheduling a new slot without offering Platform', async () => {
    const socket = await mount()
    socket.status('oauth_complete')
    render()
    expect(button('开机并完成')?.disabled).toBe(false)
    button('开机并完成')!.onClick!({} as never)
    await settle()
    const html = render()
    expect(html).toContain('内核已就绪，调度已开启')
    expect(html).not.toContain('Platform')
    expect(controls.api).toHaveBeenCalledWith(
      '/api/panel/vms/slot-a/schedulable',
      {
        method: 'POST',
        body: JSON.stringify({ schedulable: true }),
      }
    )
    expect(controls.complete).not.toHaveBeenCalled()
    button('完成')!.onClick!({} as never)
    await settle()
    expect(controls.complete).toHaveBeenCalledOnce()
  })
})

describe('browser close lifecycle', () => {
  it.each(['button', 'icon', 'escape', 'outside'])(
    'keeps the dialog after a failed %s close and releases it after retry',
    async (gesture) => {
      const socket = await mount()
      let attempts = 0
      controls.api.mockImplementation(async (path: string) => {
        if (path.endsWith('/close')) {
          attempts++
          if (attempts === 1) throw new Error('临时文件清理失败 (EACCES)')
          return { active: false, status: 'closed' }
        }
        return { active: true }
      })
      if (gesture === 'button') button('关闭浏览器')!.onClick!({} as never)
      else if (gesture === 'icon')
        button('关闭浏览器窗口')!.onClick!({} as never)
      else {
        const name =
          gesture === 'escape' ? 'onEscapeKeyDown' : 'onPointerDownOutside'
        const preventDefault = vi.fn()
        controls.content![name]({ preventDefault } as never)
        expect(preventDefault).toHaveBeenCalledOnce()
      }
      await settle()
      expect(attempts).toBe(1)
      expect(controls.changeOpen).not.toHaveBeenCalled()
      expect(socket.close).toHaveBeenCalled()
      const html = render()
      expect(html).toContain('临时文件清理失败')
      expect(button('重试关闭')?.disabled).toBe(false)
      expect(button('重新连接')?.disabled).toBe(true)
      button('重试关闭')!.onClick!({} as never)
      await settle()
      expect(attempts).toBe(2)
      expect(controls.changeOpen).toHaveBeenCalledExactlyOnceWith(false)
    }
  )

  it('deduplicates closing gestures while the server is still releasing resources', async () => {
    await mount()
    let done!: (value: unknown) => void
    controls.api.mockImplementation((path: string) =>
      path.endsWith('/close')
        ? new Promise((resolve) => {
            done = resolve
          })
        : Promise.resolve({ active: true })
    )
    button('关闭浏览器')!.onClick!({} as never)
    controls.dialogChange!(false)
    button('关闭浏览器窗口')!.onClick!({} as never)
    await settle()
    expect(
      controls.api.mock.calls.filter(([path]) => path.endsWith('/close'))
    ).toHaveLength(1)
    render()
    expect(button('正在关闭…')?.disabled).toBe(true)
    expect(controls.changeOpen).not.toHaveBeenCalled()
    done({ active: false, status: 'closed' })
    await settle()
    expect(controls.changeOpen).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('does not dismiss when Escape is used to cancel Chinese input composition', async () => {
    await mount()
    const before = controls.api.mock.calls.length
    const preventDefault = vi.fn()
    controls.content!.onEscapeKeyDown({
      preventDefault,
      isComposing: true,
    } as never)
    await settle()
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(controls.api).toHaveBeenCalledTimes(before)
    expect(controls.changeOpen).not.toHaveBeenCalled()
  })

  it('shows a session-save warning without keeping a released browser open', async () => {
    await mount()
    controls.api.mockResolvedValue({
      active: false,
      status: 'closed',
      warning: '浏览器已关闭，但会话保存失败',
    })
    button('关闭浏览器')!.onClick!({} as never)
    await settle()
    expect(controls.toastWarning).toHaveBeenCalledExactlyOnceWith(
      '浏览器已关闭，但会话保存失败'
    )
    expect(controls.changeOpen).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('does not send another close when a successfully dismissed dialog unmounts', async () => {
    await mount()
    controls.api.mockResolvedValue({ active: false, status: 'closed' })
    button('关闭浏览器')!.onClick!({} as never)
    await settle()
    controls.open = false
    render()
    for (const effect of controls.effects.splice(0)) effect()
    await settle()
    expect(
      controls.api.mock.calls.filter(([path]) => path.endsWith('/close'))
    ).toHaveLength(1)
  })

  it('joins an in-progress close when leaving the page instead of posting twice', async () => {
    await mount()
    let done!: (value: unknown) => void
    controls.api.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve
        })
    )
    button('关闭浏览器')!.onClick!({} as never)
    await settle()
    for (const cleanup of controls.effectCleanup) cleanup?.()
    done({ active: false, status: 'closed' })
    await settle()
    expect(
      controls.api.mock.calls.filter(([path]) => path.endsWith('/close'))
    ).toHaveLength(1)
    expect(controls.changeOpen).not.toHaveBeenCalled()
  })

  it('retains the OAuth completion intent while retrying a failed final close', async () => {
    controls.purpose = 'oauth'
    controls.api.mockImplementation(async (path: string) => loginRequests(path))
    const socket = await mount()
    socket.status('oauth_complete')
    render()
    button('开机并完成')!.onClick!({} as never)
    await settle()
    render()
    let attempts = 0
    controls.api.mockImplementation(async () => {
      if (++attempts === 1) throw Error('进程尚未退出')
      return { active: false, status: 'closed' }
    })
    button('完成')!.onClick!({} as never)
    await settle()
    expect(controls.complete).not.toHaveBeenCalled()
    render()
    button('重试关闭')!.onClick!({} as never)
    await settle()
    expect(controls.complete).toHaveBeenCalledOnce()
    expect(controls.changeOpen).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('reads a retained close failure before opening a new browser or issuing a ticket', async () => {
    controls.api.mockResolvedValue({
      active: true,
      status: 'close_failed',
      message: '浏览器进程尚未退出',
    })
    render()
    for (const effect of controls.effects.splice(0)) effect()
    await settle()
    expect(Socket.instances).toHaveLength(0)
    expect(controls.api.mock.calls.map(([path]) => path)).toEqual([
      '/api/panel/vms/slot-a/browser',
    ])
    expect(render()).toContain('浏览器进程尚未退出')
    expect(button('重试关闭')?.disabled).toBe(false)
  })

  it('reports a failed close after leaving the page through a global toast', async () => {
    await mount()
    controls.api.mockRejectedValue(new Error('浏览器进程尚未退出'))
    for (const cleanup of controls.effectCleanup) cleanup?.()
    await settle()
    expect(controls.toastError).toHaveBeenCalledWith(
      '账号浏览器未能关闭：浏览器进程尚未退出'
    )
    expect(controls.changeOpen).not.toHaveBeenCalled()
  })

  it('surfaces a cleanup warning received over the browser status stream', async () => {
    const socket = await mount()
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'status',
        status: 'ready',
        warning: '有 1 项临时目录待清理',
      }),
    })
    expect(render()).toContain('有 1 项临时目录待清理')
  })
})
