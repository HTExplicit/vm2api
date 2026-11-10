import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSession,
  expirePanelSession,
  setApiBase,
  setSession,
} from './session'
import { bindSessionQueryCache } from './session-cache'

let client: QueryClient
let unbind: () => void

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('location', { hostname: 'console.example' })
  vi.stubGlobal('document', { cookie: '' })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  setSession('admin-token', 'admin')
  client = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  })
  unbind = bindSessionQueryCache(client)
})

afterEach(() => {
  unbind()
  client.clear()
  vi.unstubAllGlobals()
})

describe('session query cache isolation', () => {
  it.each([
    ['login', () => setSession('tenant-token', 'tenant')],
    ['logout', () => clearSession()],
    ['expiry', () => expirePanelSession()],
    ['backend change', () => setApiBase('https://other.example')],
  ])('drops all cached account data on %s', (_name, changeSession) => {
    client.setQueryData(['panel', 'me'], { role: 'admin' })
    client.setQueryData(['panel', 'api-keys'], { items: ['admin-key'] })
    client.setQueryData(['panel', 'usage-logs', 'batch'], {
      pages: ['admin-log'],
    })

    changeSession()

    expect(client.getQueryCache().getAll()).toEqual([])
  })

  it('does not serve a fresh old account list to the new account', async () => {
    const queryKey = ['panel', 'api-keys']
    client.setQueryData(queryKey, { items: ['admin-key'] })
    setSession('tenant-token', 'tenant')
    const queryFn = vi.fn(async () => ({ items: ['tenant-key'] }))

    const data = await client.fetchQuery({ queryKey, queryFn })

    expect(queryFn).toHaveBeenCalledOnce()
    expect(data.items).toEqual(['tenant-key'])
  })

  it('cancels old requests and prevents late results replacing new account data', async () => {
    const queryKey = ['panel', 'api-keys']
    let resolveOld!: (value: string[]) => void
    let oldSignal!: AbortSignal
    const old = client
      .fetchQuery({
        queryKey,
        queryFn: ({ signal }) => {
          oldSignal = signal
          return new Promise<string[]>((resolve) => {
            resolveOld = resolve
          })
        },
      })
      .catch((error: unknown) => error)

    setSession('tenant-token', 'tenant')
    expect(oldSignal.aborted).toBe(true)
    await client.fetchQuery({ queryKey, queryFn: async () => ['tenant-key'] })
    resolveOld(['admin-key'])
    await old
    await Promise.resolve()

    expect(client.getQueryData(queryKey)).toEqual(['tenant-key'])
  })
})
