import { describe, expect, it, vi } from 'vitest'
import { patchVm } from '@/lib/api'
import {
  DEFAULT_RESOLVED_ENGINE,
  INFERENCE_ENGINE_OPTIONS,
  inferenceEnginePatchValue,
  isFallbackToGo,
  normalizeGlobalClaudeEngine,
  normalizeInferenceEngine,
} from './engine-contract'

vi.mock('@/lib/session', () => ({
  apiBase: () => '',
  clearSession: vi.fn(),
  hasSession: () => true,
  sessionToken: () => '',
  sessionRevision: () => 0,
}))

describe('VM inference engine contract', () => {
  it('exposes only auto and rust choices', () => {
    expect(INFERENCE_ENGINE_OPTIONS.map((option) => option.value)).toEqual([
      'auto',
      'rust',
    ])
  })

  it.each([
    ['auto', ''],
    ['rust', 'rust'],
    ['go', 'rust'],
  ] as const)('maps %s to the Gateway PATCH value %s', (engine, expected) => {
    expect(inferenceEnginePatchValue(engine)).toBe(expected)
  })

  it('falls back safely for unknown response values', () => {
    expect(normalizeInferenceEngine('unexpected', 'auto')).toBe('auto')
    expect(normalizeInferenceEngine(null, 'rust')).toBe('rust')
    expect(normalizeInferenceEngine('go', 'auto')).toBe('rust')
  })

  it('treats omitted or empty global engine as rust', () => {
    expect(normalizeGlobalClaudeEngine(undefined)).toBe('rust')
    expect(normalizeGlobalClaudeEngine('')).toBe('rust')
    expect(normalizeGlobalClaudeEngine('rust')).toBe('rust')
    expect(normalizeGlobalClaudeEngine('go')).toBe('rust')
  })

  it('never enables fallback_to_go', () => {
    expect(isFallbackToGo(undefined)).toBe(false)
    expect(isFallbackToGo(false)).toBe(false)
    expect(isFallbackToGo(true)).toBe(false)
  })

  it('uses rust when resolved engine is omitted', () => {
    expect(DEFAULT_RESOLVED_ENGINE).toBe('rust')
    expect(normalizeInferenceEngine(null, DEFAULT_RESOLVED_ENGINE)).toBe('rust')
    expect(normalizeInferenceEngine(undefined, DEFAULT_RESOLVED_ENGINE)).toBe(
      'rust'
    )
  })

  it('encodes the VM id and sends only the per-VM PATCH body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await patchVm('vm/with spaces', { inference_engine: '' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/panel/vms/vm%2Fwith%20spaces',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ inference_engine: '' }),
      })
    )
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('/routing')
    fetchMock.mockRestore()
  })

  it('preserves Gateway error messages for failed engine switches', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: 'ENGINE_UNHEALTHY',
            message: 'Rust health check failed',
          },
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )

    await expect(
      patchVm('vm-1', { inference_engine: 'rust' })
    ).rejects.toMatchObject({
      message: 'Rust health check failed',
      status: 503,
      code: 'ENGINE_UNHEALTHY',
    })
    fetchMock.mockRestore()
  })
})
