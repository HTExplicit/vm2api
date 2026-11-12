import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  accountBrowserQueryOptions,
  type AccountBrowserStatus,
} from './account-browser-queries'
import { AccountBrowserSection } from './account-browser-section'

const controls = vi.hoisted(() => ({
  cursor: 0,
  hooks: [] as unknown[],
  buttons: [] as ButtonHTMLAttributes<HTMLButtonElement>[],
  inputs: [] as InputHTMLAttributes<HTMLInputElement>[],
  api: vi.fn(),
}))

vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = controls.cursor++
      if (!(index in controls.hooks))
        controls.hooks[index] =
          typeof initial === 'function' ? initial() : initial
      return [
        controls.hooks[index],
        (next: unknown) => {
          controls.hooks[index] =
            typeof next === 'function' ? next(controls.hooks[index]) : next
        },
      ]
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
vi.mock('@/components/ui/input', () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => {
    controls.inputs.push(props)
    return <input {...props} />
  },
}))

const initial: AccountBrowserStatus = {
  launcher_version: '0.7.2',
  installed_version: null,
  running_version: null,
  latest_version: null,
  checked_at: null,
  key_set: false,
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
  controls.cursor = 0
  controls.buttons = []
  controls.inputs = []
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
  controls.cursor = 0
  controls.hooks = []
  controls.api.mockReset()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  setStatus()
})
afterEach(() => client.clear())

describe('account browser management', () => {
  it('shows setup and versions without installing or checking upstream on render', () => {
    const html = render()
    expect(html).toContain('待配置')
    expect(html).toContain('尚未安装')
    expect(html).toContain('尚未检查')
    expect(html).toContain('0.7.2')
    expect(button('安装浏览器').disabled).toBe(true)
    expect(controls.api).not.toHaveBeenCalled()
  })

  it('keeps local installation, current running version, and latest version distinct', () => {
    setStatus({
      key_set: true,
      installed_version: '156.0.1',
      running_version: '155.0.2',
      latest_version: '156.0.3',
      browser_busy: true,
    })
    const html = render()
    expect(html).toContain('156.0.1')
    expect(html).toContain('155.0.2')
    expect(html).toContain('156.0.3')
    expect(html).toContain('请先关闭正在使用的账号浏览器')
    expect(button('更新浏览器').disabled).toBe(true)
    expect(button('清除 key').disabled).toBe(true)
  })

  it('submits a key without storing it in mutation variables, then clears the field', async () => {
    render()
    controls.inputs[0].onChange!({
      target: { value: 'private-license-key' },
    } as never)
    render()
    controls.api.mockResolvedValue({ ...initial, key_set: true })
    button('保存 key').onClick!({} as never)
    await vi.waitFor(() => {
      expect(
        client.getQueryData<AccountBrowserStatus>(['account-browser'])?.key_set
      ).toBe(true)
    })
    expect(controls.api).toHaveBeenCalledWith(
      '/api/panel/account-browser/key',
      {
        method: 'PUT',
        body: JSON.stringify({ key: 'private-license-key' }),
      }
    )
    expect(
      client
        .getMutationCache()
        .getAll()
        .every((item) => item.state.variables === undefined)
    ).toBe(true)
    expect(
      JSON.stringify(client.getQueryData(['account-browser']))
    ).not.toContain('private-license-key')
    expect(render()).toContain('已配置，保存后不回显')
    expect(controls.inputs[0].value).toBe('')
  })

  it('clears the configured key only through its explicit action', async () => {
    setStatus({ key_set: true, installed_version: '156.0.1' })
    render()
    expect(button('保存 key').disabled).toBe(true)
    controls.api.mockResolvedValue({ ...initial, installed_version: '156.0.1' })
    button('清除 key').onClick!({} as never)
    await vi.waitFor(() =>
      expect(controls.api).toHaveBeenCalledWith(
        '/api/panel/account-browser/key',
        {
          method: 'PUT',
          body: JSON.stringify({ key: null }),
        }
      )
    )
  })

  it('requests an update without a version selector and shows progress with task polling', async () => {
    setStatus({ key_set: true })
    render()
    controls.api.mockResolvedValue({
      ...initial,
      key_set: true,
      installing: true,
      phase: 'downloading',
      progress: 40,
    })
    button('安装浏览器').onClick!({} as never)
    await vi.waitFor(() =>
      expect(
        client.getQueryData<AccountBrowserStatus>(['account-browser'])
          ?.installing
      ).toBe(true)
    )
    expect(controls.api).toHaveBeenCalledWith(
      '/api/panel/account-browser/install',
      { method: 'POST' }
    )
    const html = render()
    expect(html).toContain('正在下载内核')
    expect(html).toContain('40%')
    expect(html).toContain('关闭此页面不会取消安装')
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
  })

  it('shows failed checks and never labels a cached version as up to date', async () => {
    setStatus({
      key_set: true,
      installed_version: '156.0.1',
      latest_version: '156.0.1',
    })
    render()
    controls.api.mockRejectedValue(new Error('无法查询官方版本，请重试'))
    button('检查更新').onClick!({} as never)
    await vi.waitFor(() =>
      expect(
        client
          .getMutationCache()
          .getAll()
          .some((item) => item.state.status === 'error')
      ).toBe(true)
    )
    const html = render()
    expect(html).toContain('无法查询官方版本，请重试')
    expect(html).not.toContain('已是最新')
  })
})
