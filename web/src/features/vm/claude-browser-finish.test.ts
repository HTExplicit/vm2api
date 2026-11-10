import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { finishCodexBrowserLogin } from './codex-browser-finish'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

const request = vi.mocked(api)
const base = '/api/panel/vms/claude-a'
const healthy = {
  id: 'claude-a',
  kernel: {
    rust_health: { reachable: true, process_up: true, status: 200 },
  },
}
const running = {
  vm: { id: 'claude-a', status: 'running', runtime: { stopped: false } },
}

beforeEach(() => {
  request.mockReset().mockImplementation(async (path) => {
    if (path.endsWith('/start')) return { boot: { rust_ok: true } }
    if (path.endsWith('/health')) return healthy
    if (path.endsWith('/schedulable'))
      return { id: 'claude-a', schedulable: true }
    if (path === base) return running
    throw new Error(`unexpected request ${path}`)
  })
})

describe('Claude browser login completion', () => {
  it('verifies running state and Rust health before scheduling without requiring Codex fields', async () => {
    await finishCodexBrowserLogin('claude-a', { provider: 'anthropic' })
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      `${base}/start`,
      `${base}/health`,
      base,
      `${base}/schedulable`,
    ])
  })

  it.each([
    ['wrong slot health', { ...healthy, id: 'other' }, running],
    [
      'unreachable kernel',
      {
        id: 'claude-a',
        kernel: {
          rust_health: { reachable: false, process_up: true, status: 200 },
        },
      },
      running,
    ],
    [
      'stopped kernel',
      {
        id: 'claude-a',
        kernel: {
          rust_health: { reachable: true, process_up: false, status: 200 },
        },
      },
      running,
    ],
    [
      'failed health',
      {
        id: 'claude-a',
        kernel: {
          rust_health: { reachable: true, process_up: true, status: 503 },
        },
      },
      running,
    ],
    [
      'stopped runtime',
      healthy,
      { vm: { ...running.vm, runtime: { stopped: true } } },
    ],
    ['stopped status', healthy, { vm: { ...running.vm, status: 'stopped' } }],
    ['wrong slot detail', healthy, { vm: { ...running.vm, id: 'other' } }],
  ])('does not schedule %s', async (_label, health, detail) => {
    request.mockImplementation(async (path) => {
      if (path.endsWith('/start')) return { boot: { rust_ok: true } }
      if (path.endsWith('/health')) return health
      if (path === base) return detail
      throw new Error('must not enable scheduling')
    })
    await expect(
      finishCodexBrowserLogin('claude-a', { provider: 'anthropic' })
    ).rejects.toMatchObject({ retry: 'verify' })
    expect(request.mock.calls.map(([path]) => path)).not.toContain(
      `${base}/schedulable`
    )
  })
})
