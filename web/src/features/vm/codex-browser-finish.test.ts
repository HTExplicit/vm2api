import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import {
  CodexBrowserFinishError,
  finishCodexBrowserLogin,
} from './codex-browser-finish'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

const request = vi.mocked(api)
const id = 'slot-a'
const base = `/api/panel/vms/${id}`

function health(fields: Record<string, unknown> = {}) {
  return {
    id,
    kernel: {
      codex_health: {
        reachable: true,
        process_up: true,
        status: 200,
        vm_id: id,
        ...fields,
      },
    },
  }
}

function detail(stopped: boolean) {
  return {
    vm: {
      id,
      status: stopped ? 'stopped' : 'running',
      runtime: { stopped },
    },
  }
}

function paths() {
  return request.mock.calls.map(([path]) => path)
}

beforeEach(() => {
  request.mockReset().mockImplementation(async (path) => {
    if (path === `${base}/start`) return { boot: { rust_ok: true } }
    if (path === `${base}/health`) return health()
    if (path === `${base}/schedulable`) return { id, schedulable: true }
    if (path === base) return detail(false)
    throw new Error(`unexpected request ${path}`)
  })
})

describe('Codex browser login completion', () => {
  it('waits for boot and then verifies the target kernel before enabling scheduling', async () => {
    let booted!: (value: unknown) => void
    request.mockImplementationOnce(
      () => new Promise((resolve) => (booted = resolve))
    )
    const progress = vi.fn()
    const completed = vi.fn()
    const pending = finishCodexBrowserLogin(id, {
      onProgress: progress,
    }).then(completed)

    expect(request).toHaveBeenCalledExactlyOnceWith(`${base}/start`, {
      method: 'POST',
      body: JSON.stringify({ ensure_kernel: true }),
    })
    expect(completed).not.toHaveBeenCalled()
    booted({ boot: { rust_ok: true } })
    await pending

    expect(paths()).toEqual([
      `${base}/start`,
      `${base}/health`,
      `${base}/schedulable`,
    ])
    expect(request).toHaveBeenLastCalledWith(`${base}/schedulable`, {
      method: 'POST',
      body: JSON.stringify({ schedulable: true }),
    })
    expect(progress.mock.calls.map(([stage]) => stage)).toEqual([
      'starting',
      'checking',
      'scheduling',
    ])
    expect(completed).toHaveBeenCalledOnce()
  })

  it('uses live health even when the start response omits kernel details', async () => {
    request.mockResolvedValueOnce({})
    await finishCodexBrowserLogin(id, {})
    expect(paths()).toEqual([
      `${base}/start`,
      `${base}/health`,
      `${base}/schedulable`,
    ])
  })

  it.each([
    ['wrong response slot', { ...health(), id: 'slot-other' }],
    ['wrong kernel slot', health({ vm_id: 'slot-other' })],
    ['missing kernel slot', health({ vm_id: undefined })],
    ['unreachable kernel', health({ reachable: false })],
    ['process without reachable health', health({ reachable: undefined })],
    ['missing running process', health({ process_up: undefined })],
    ['stopped process', health({ process_up: false })],
    ['non-200 response', health({ status: 503 })],
    ['string status', health({ status: '200' })],
    ['explicitly unhealthy kernel', health({ healthy: false })],
    ['missing kernel health', { id, kernel: {} }],
  ])('does not schedule after %s', async (_label, result) => {
    request.mockImplementation(async (path) => {
      if (path === `${base}/start`) return { boot: { rust_ok: true } }
      if (path === `${base}/health`) return result
      if (path === base) return detail(false)
      throw new Error('scheduling must remain disabled')
    })

    await expect(finishCodexBrowserLogin(id, {})).rejects.toMatchObject({
      retry: 'verify',
    })
    expect(paths()).not.toContain(`${base}/schedulable`)
  })

  it.each([
    ['false', { id, schedulable: false }],
    ['missing', { id }],
    ['another slot', { id: 'slot-other', schedulable: true }],
  ])(
    'requires confirmed scheduling instead of a %s result',
    async (_label, result) => {
      request.mockResolvedValueOnce({}).mockResolvedValueOnce(health())
      request.mockResolvedValueOnce(result)

      await expect(finishCodexBrowserLogin(id, {})).rejects.toMatchObject({
        retry: 'schedule',
      })
    }
  )

  it('retains the scheduling retry after a rejected enable request', async () => {
    request.mockResolvedValueOnce({}).mockResolvedValueOnce(health())
    request.mockRejectedValueOnce(new Error('credential unavailable'))

    await expect(finishCodexBrowserLogin(id, {})).rejects.toBeInstanceOf(
      CodexBrowserFinishError
    )
    expect(paths().filter((path) => path.endsWith('/start'))).toHaveLength(1)
  })
})

describe('uncertain startup and targeted retries', () => {
  it('recovers a lost startup response by reading health and state without starting twice', async () => {
    request.mockRejectedValueOnce(new Error('response disconnected'))
    await finishCodexBrowserLogin(id, {})

    expect(paths()).toHaveLength(4)
    expect(paths()[0]).toBe(`${base}/start`)
    expect(paths().slice(1, 3).sort()).toEqual([base, `${base}/health`].sort())
    expect(paths()[3]).toBe(`${base}/schedulable`)
    expect(paths().filter((path) => path.endsWith('/start'))).toHaveLength(1)
  })

  it('allows a fresh start only after the uncertain request is confirmed stopped', async () => {
    request.mockImplementation(async (path) => {
      if (path === `${base}/start`) throw new Error('response disconnected')
      if (path === `${base}/health`) return health({ reachable: false })
      if (path === base) return detail(true)
      throw new Error('scheduling must remain disabled')
    })

    await expect(finishCodexBrowserLogin(id, {})).rejects.toMatchObject({
      retry: 'start',
    })
    expect(paths().filter((path) => path.endsWith('/start'))).toHaveLength(1)
  })

  it('does not accept healthy telemetry for a slot whose real-time state is stopped', async () => {
    request.mockImplementation(async (path) => {
      if (path === `${base}/start`) throw new Error('response disconnected')
      if (path === `${base}/health`) return health()
      if (path === base) return detail(true)
      throw new Error('scheduling must remain disabled')
    })

    await expect(finishCodexBrowserLogin(id, {})).rejects.toMatchObject({
      retry: 'start',
    })
    expect(paths()).not.toContain(`${base}/schedulable`)
  })

  it.each([
    ['running but unhealthy', detail(false), health({ reachable: false })],
    ['unknown state', { vm: { id } }, health()],
    [
      'another slot state',
      { vm: { id: 'slot-other', status: 'running' } },
      health(),
    ],
  ])(
    'only verifies after a lost response with %s',
    async (_label, state, sample) => {
      request.mockImplementation(async (path) => {
        if (path === `${base}/start`) throw new Error('response disconnected')
        if (path === `${base}/health`) return sample
        if (path === base) return state
        throw new Error('scheduling must remain disabled')
      })

      await expect(finishCodexBrowserLogin(id, {})).rejects.toMatchObject({
        retry: 'verify',
      })
      expect(paths().filter((path) => path.endsWith('/start'))).toHaveLength(1)
      expect(paths()).not.toContain(`${base}/schedulable`)
    }
  )

  it('rechecks a reported failed boot instead of treating its HTTP response as ready', async () => {
    request.mockImplementation(async (path) => {
      if (path === `${base}/start`)
        return { boot: { rust_ok: false, rust: { error: 'health timeout' } } }
      if (path === `${base}/health`) return health({ reachable: false })
      if (path === base) return detail(false)
      throw new Error('scheduling must remain disabled')
    })

    await expect(finishCodexBrowserLogin(id, {})).rejects.toMatchObject({
      retry: 'start',
    })
    expect(paths()).toContain(base)
    expect(paths()).not.toContain(`${base}/schedulable`)
  })

  it('allows a targeted start retry after a definite server failure even if the container is running', async () => {
    request.mockImplementation(async (path) => {
      if (path === `${base}/start`)
        throw Object.assign(new Error('kernel failed to start'), {
          status: 500,
          code: 'codex_kernel_start_failed',
        })
      if (path === `${base}/health`) return health({ reachable: false })
      if (path === base) return detail(false)
      throw new Error('scheduling must remain disabled')
    })

    await expect(finishCodexBrowserLogin(id, {})).rejects.toMatchObject({
      retry: 'start',
    })
    expect(paths().filter((path) => path.endsWith('/start'))).toHaveLength(1)
    expect(paths()).toContain(base)
    expect(paths()).not.toContain(`${base}/schedulable`)
  })

  it.each([
    [409, 'proxy_required'],
    [500, 'codex_kernel_start_failed'],
  ])(
    'preserves a definite start rejection %s/%s even when an older kernel is healthy',
    async (status, code) => {
      request.mockRejectedValueOnce(
        Object.assign(new Error('start rejected'), { status, code })
      )

      await expect(finishCodexBrowserLogin(id, {})).rejects.toMatchObject({
        retry: 'start',
      })
      expect(paths()).toContain(`${base}/health`)
      expect(paths()).toContain(base)
      expect(paths()).not.toContain(`${base}/schedulable`)
    }
  )

  it('does not use an older healthy kernel to hide an explicitly failed boot', async () => {
    request.mockResolvedValueOnce({ boot: { rust_ok: false } })

    await expect(finishCodexBrowserLogin(id, {})).rejects.toMatchObject({
      retry: 'start',
    })
    expect(paths()).toContain(`${base}/health`)
    expect(paths()).toContain(base)
    expect(paths()).not.toContain(`${base}/schedulable`)
  })

  it('retries scheduling through fresh health without restarting a healthy slot', async () => {
    await finishCodexBrowserLogin(id, { retry: 'schedule' })
    expect(paths()).toEqual([`${base}/health`, `${base}/schedulable`])
  })

  it('refuses scheduling retry when the kernel no longer passes health', async () => {
    request.mockResolvedValueOnce(health({ process_up: false }))
    await expect(
      finishCodexBrowserLogin(id, { retry: 'schedule' })
    ).rejects.toMatchObject({ retry: 'schedule' })
    expect(paths()).toEqual([`${base}/health`])
  })

  it('does not restart a running unhealthy slot during a verification retry', async () => {
    request.mockImplementation(async (path) => {
      if (path === `${base}/health`) return health({ reachable: false })
      if (path === base) return detail(false)
      throw new Error('must not issue a write')
    })
    await expect(
      finishCodexBrowserLogin(id, { retry: 'verify' })
    ).rejects.toMatchObject({ retry: 'verify' })
    expect(paths().sort()).toEqual([base, `${base}/health`].sort())
  })

  it('starts a verified stopped slot when the user explicitly retries', async () => {
    let samples = 0
    request.mockImplementation(async (path) => {
      if (path === `${base}/health`)
        return ++samples === 1 ? health({ reachable: false }) : health()
      if (path === base) return detail(true)
      if (path === `${base}/start`) return { boot: { rust_ok: true } }
      if (path === `${base}/schedulable`) return { id, schedulable: true }
      throw new Error(`unexpected request ${path}`)
    })
    await finishCodexBrowserLogin(id, { retry: 'verify' })
    expect(paths().slice(0, 2).sort()).toEqual([base, `${base}/health`].sort())
    expect(paths().slice(2)).toEqual([
      `${base}/start`,
      `${base}/health`,
      `${base}/schedulable`,
    ])
  })
})

describe('completion lifecycle boundaries', () => {
  it('does not start after the dialog has left its target slot', async () => {
    await expect(
      finishCodexBrowserLogin(id, { isCurrent: () => false })
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it('ignores a late startup response after closing or switching slots', async () => {
    let current = true
    let booted!: (value: unknown) => void
    request.mockImplementationOnce(
      () => new Promise((resolve) => (booted = resolve))
    )
    const pending = finishCodexBrowserLogin(id, {
      isCurrent: () => current,
    })
    current = false
    booted({ boot: { rust_ok: true } })
    await expect(pending).rejects.toThrow()
    expect(paths()).toEqual([`${base}/start`])
  })

  it('does not enable scheduling when the dialog closes during health verification', async () => {
    let current = true
    request.mockImplementation(async (path) => {
      if (path === `${base}/health`) {
        current = false
        return health()
      }
      if (path === `${base}/start`) return {}
      throw new Error('must not enable scheduling')
    })
    await expect(
      finishCodexBrowserLogin(id, { isCurrent: () => current })
    ).rejects.toThrow()
    expect(paths()).not.toContain(`${base}/schedulable`)
  })
})
