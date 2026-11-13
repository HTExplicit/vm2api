import type { ButtonHTMLAttributes } from 'react'
import {
  QueryClient,
  QueryClientProvider,
  type MutationObserver,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  accountBrowserQueryOptions,
  type AccountBrowserStatus,
} from './account-browser-queries'
import { AccountBrowserSection } from './account-browser-section'

const controls = vi.hoisted(() => ({
  mutationCursor: 0,
  mutations: [] as MutationObserver<unknown, Error, void, unknown>[],
  buttons: [] as (ButtonHTMLAttributes<HTMLButtonElement> & {
    loading?: boolean
  })[],
  api: vi.fn(),
}))

// Server renders have no mounted subscriptions. Real mutation observers retain
// pending/error states between explicit renders without replacing query behavior.
vi.mock('@tanstack/react-query', async (original) => {
  const query = await original<typeof import('@tanstack/react-query')>()
  return {
    ...query,
    useMutation: (
      options: UseMutationOptions<unknown, Error, void, unknown>
    ) => {
      const index = controls.mutationCursor++
      const observer = (controls.mutations[index] ||=
        new query.MutationObserver(client, options))
      observer.setOptions(options)
      return {
        ...observer.getCurrentResult(),
        mutate: () => void observer.mutate().catch(() => {}),
      }
    },
  }
})
vi.mock('@/lib/api', () => ({ api: controls.api }))
vi.mock('@/components/ui/button', () => ({
  Button: (
    props: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }
  ) => {
    controls.buttons.push(props)
    return (
      <button disabled={props.disabled || props.loading}>
        {props.children}
      </button>
    )
  },
}))

const initial: AccountBrowserStatus = {
  launcher_version: '2.1.6',
  installed_version: null,
  installed_build: null,
  running_version: null,
  latest_version: null,
  latest_build: null,
  checked_at: null,
  update_status: 'not_installed',
  installing: false,
  phase: 'idle',
  progress: null,
  last_error: null,
  browser_busy: false,
}
let client: QueryClient

function setStatus(patch: Partial<AccountBrowserStatus> = {}) {
  const data = { ...initial, ...patch }
  client.setQueryData(accountBrowserQueryOptions().queryKey, data)
  return data
}

function render() {
  controls.mutationCursor = 0
  controls.buttons = []
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AccountBrowserSection />
    </QueryClientProvider>
  )
}

function button(label: string) {
  const found = controls.buttons.find((props) =>
    renderToStaticMarkup(<>{props.children}</>).includes(label)
  )
  expect(found).toBeDefined()
  return found!
}

beforeEach(() => {
  controls.mutations = []
  controls.api.mockReset()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  setStatus()
})
afterEach(() => client.clear())

describe('account browser management', () => {
  it('shows local installation status without a license form or upstream request', () => {
    const html = render()
    expect(html).toContain('ShardBrowser')
    expect(html).toContain('待安装')
    expect(html).toContain('尚未检查')
    expect(html).toContain('2.1.6')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('CloakBrowser')
    expect(button('安装浏览器').disabled).toBe(false)
    expect(controls.api).not.toHaveBeenCalled()
  })

  it.each([
    ['unchecked', '请先检查更新', true],
    ['current', '已是最新', true],
    ['update_available', '更新浏览器', false],
    ['components_available', '更新组件', false],
    ['newer_installed', '无需更新', true],
    ['application_update_required', '请先升级应用', true],
    ['check_failed', '请重新检查', true],
    ['retry_required', '重试安装', false],
  ] as const)(
    'uses server decision %s for the action instead of comparing versions',
    (update_status, label, disabled) => {
      setStatus({
        installed_version: '157.0.8103.50',
        installed_build: '1',
        latest_version: '157.0.8103.50',
        latest_build: '2',
        update_status,
      })
      render()
      expect(button(label).disabled).toBe(disabled)
    }
  )

  it('shows installed and latest builds while keeping the running version distinct', () => {
    setStatus({
      installed_version: '157.0.8103.50',
      installed_build: '1',
      running_version: '156.0.8078.47',
      latest_version: '157.0.8103.50',
      latest_build: '2',
      update_status: 'update_available',
      browser_busy: true,
    })
    const html = render()
    expect(html).toContain('157.0.8103.50 · 构建 1')
    expect(html).toContain('157.0.8103.50 · 构建 2')
    expect(html).toContain('156.0.8078.47')
    expect(html).toContain('请先关闭正在使用的账号浏览器')
    expect(button('更新浏览器').disabled).toBe(true)
    expect(button('检查更新').disabled).toBe(false)
  })

  it('explains application and component updates without enabling an incompatible install', () => {
    setStatus({ update_status: 'application_update_required' })
    expect(render()).toContain('官方新版需要更新的启动组件，请先升级应用')
    expect(button('请先升级应用').disabled).toBe(true)
    setStatus({ update_status: 'components_available' })
    expect(render()).toContain('内核版本未变，官方浏览器组件有更新')
    expect(button('更新组件').disabled).toBe(false)
  })

  it('posts installation without a version and polls only while the task runs', async () => {
    render()
    let accept!: (value: AccountBrowserStatus) => void
    controls.api.mockImplementationOnce(
      () => new Promise<AccountBrowserStatus>((resolve) => (accept = resolve))
    )
    button('安装浏览器').onClick!({} as never)
    await vi.waitFor(() => {
      render()
      expect(button('安装浏览器').disabled).toBe(true)
      expect(button('检查更新').disabled).toBe(true)
    })
    accept({ ...initial, installing: true, phase: 'downloading', progress: 40 })
    await vi.waitFor(() => expect(render()).toContain('40%'))
    expect(controls.api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/account-browser/install',
      { method: 'POST' }
    )
    const html = render()
    expect(html).toContain('正在下载组件')
    expect(html).toContain('关闭此页面不会取消安装')
    expect(html).toContain('<progress')
    expect(html).toContain('value="40"')
    const interval = accountBrowserQueryOptions().refetchInterval
    expect(typeof interval).toBe('function')
    if (typeof interval === 'function') {
      expect(interval({ state: { data: { installing: true } } } as never)).toBe(
        2000
      )
      expect(
        interval({ state: { data: { installing: false } } } as never)
      ).toBe(false)
    }
    setStatus({
      installed_version: '157.0.8103.50',
      installed_build: '1',
      update_status: 'current',
      phase: 'ready',
    })
    expect(render()).toContain('安装完成。')
    expect(render()).not.toContain('验证完成')
    expect(button('已是最新').disabled).toBe(true)
  })

  it('reports file and version verification without claiming browser runtime testing', () => {
    setStatus({ installing: true, phase: 'verifying' })
    const html = render()
    expect(html).toContain('正在核对文件与版本')
    expect(html).not.toContain('正在验证浏览器')
    expect(html.match(/<progress[^>]+>/)?.[0]).not.toContain('value=')
  })

  it('does not expose a cached current state after a failed check, and recovers on success', async () => {
    setStatus({
      installed_version: '157.0.8103.50',
      latest_version: '157.0.8103.50',
      update_status: 'current',
    })
    render()
    controls.api.mockRejectedValueOnce(new Error('无法查询官方版本，请重试'))
    button('检查更新').onClick!({} as never)
    await vi.waitFor(() =>
      expect(render()).toContain('无法查询官方版本，请重试')
    )
    expect(render()).not.toContain('已是最新')
    expect(button('请重新检查').disabled).toBe(true)
    controls.api.mockResolvedValueOnce({
      ...initial,
      installed_version: '157.0.8103.50',
      latest_version: '157.0.8103.50',
      update_status: 'components_available',
    })
    button('检查更新').onClick!({} as never)
    await vi.waitFor(() => {
      expect(render()).not.toContain('无法查询官方版本')
      expect(button('更新组件').disabled).toBe(false)
    })
    expect(button('更新组件').disabled).toBe(false)
  })

  it('keeps persisted install failures retryable through the same install action', async () => {
    setStatus({
      installed_version: '157.0.8103.50',
      latest_version: '157.0.8103.50',
      update_status: 'retry_required',
      phase: 'failed',
      last_error: {
        code: 'browser_version_mismatch',
        message: '安装版本不一致',
      },
    })
    expect(render()).toContain('安装版本不一致')
    expect(button('重试安装').disabled).toBe(false)
    controls.api.mockResolvedValueOnce({
      ...initial,
      installing: true,
      phase: 'checking',
    })
    button('重试安装').onClick!({} as never)
    await vi.waitFor(() => expect(render()).toContain('正在检查版本'))
    expect(controls.api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/account-browser/install',
      { method: 'POST' }
    )
  })

  it('clears an earlier install request error when a subsequent check succeeds', async () => {
    render()
    controls.api.mockRejectedValueOnce(new Error('浏览器正在使用'))
    button('安装浏览器').onClick!({} as never)
    await vi.waitFor(() => expect(render()).toContain('浏览器正在使用'))
    controls.api.mockResolvedValueOnce({
      ...initial,
      update_status: 'application_update_required',
    })
    button('检查更新').onClick!({} as never)
    await vi.waitFor(() => expect(render()).not.toContain('浏览器正在使用'))
    expect(button('请先升级应用').disabled).toBe(true)
  })
})
