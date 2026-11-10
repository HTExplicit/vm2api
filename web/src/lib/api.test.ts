import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, normalizePanelError, panelFetch } from './api'
import {
  hasSession,
  onPanelSessionExpired,
  sessionToken,
  setApiBase,
  setSession,
} from './session'

function installBrowser() {
  const values = new Map<string, string>()
  vi.stubGlobal('location', { hostname: 'console.example', protocol: 'https:' })
  vi.stubGlobal('document', { cookie: '' })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  })
  return values
}

describe('panel error envelope', () => {
  it('preserves structured error metadata', () => {
    const normalized = normalizePanelError(
      {
        error: {
          type: 'permission_error',
          code: 'forbidden',
          message: '没有权限',
          details: { capability: 'users' },
        },
        data: { refresh_class: 'fatal' },
      },
      403,
      'Forbidden'
    )

    expect(normalized).toEqual({
      message: '没有权限',
      status: 403,
      type: 'permission_error',
      code: 'forbidden',
      details: { capability: 'users' },
      data: { refresh_class: 'fatal' },
    })
  })

  it('keeps string error codes compatible with existing callers', () => {
    const error = new ApiError('冲突', 409, 'conflict')
    expect(error).toMatchObject({ status: 409, code: 'conflict' })
  })
})

describe('panelFetch 401', () => {
  beforeEach(() => {
    installBrowser()
    setSession('kin-panel-test-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears session and notifies on panel API 401', async () => {
    const expired = vi.fn()
    onPanelSessionExpired(expired)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 }))
    )
    const res = await panelFetch('/api/panel/me')
    expect(res.status).toBe(401)
    expect(hasSession()).toBe(false)
    expect(sessionToken()).toBe('')
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('does not expire session when panel login returns 401', async () => {
    const expired = vi.fn()
    onPanelSessionExpired(expired)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 }))
    )
    const res = await panelFetch('/api/panel/login', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(hasSession()).toBe(true)
    expect(expired).not.toHaveBeenCalled()
  })

  it.each([
    ['new login', () => setSession('new-token', 'tenant')],
    [
      'same-token reauthentication',
      () => setSession('kin-panel-test-token', 'admin'),
    ],
    ['different backend', () => setApiBase('https://other.example')],
  ])('ignores an old request 401 after %s', async (_name, changeSession) => {
    let resolve!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done
          })
      )
    )
    const expired = vi.fn()
    const unsubscribe = onPanelSessionExpired(expired)
    try {
      const pending = panelFetch('/api/panel/me')
      changeSession()
      resolve(new Response('{}', { status: 401 }))
      await expect(pending).rejects.toMatchObject({ code: 'session_changed' })
      expect(hasSession()).toBe(true)
      expect(expired).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('discards a successful old mutation response after switching accounts', async () => {
    let resolve!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done
          })
      )
    )
    const pending = api('/api/panel/api-keys', { method: 'POST', body: '{}' })
    setSession('tenant-token', 'tenant')
    resolve(new Response(JSON.stringify({ data: { key: 'old-account-key' } })))
    await expect(pending).rejects.toMatchObject({ code: 'session_changed' })
    expect(sessionToken()).toBe('tenant-token')
  })

  it('discards old JSON when the account changes while the response body is loading', async () => {
    let resolveBody!: (value: unknown) => void
    const json = vi.fn(
      () =>
        new Promise((done) => {
          resolveBody = done
        })
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json }))
    )
    const pending = api('/api/panel/api-keys')
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce())
    setSession('tenant-token', 'tenant')
    resolveBody({ data: { items: ['old-account-key'] } })
    await expect(pending).rejects.toMatchObject({ code: 'session_changed' })
  })
})
