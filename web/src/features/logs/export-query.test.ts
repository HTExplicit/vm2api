import { describe, expect, it } from 'vitest'
import type { ExportOptions } from './export-dialog'
import { exportQuery } from './export-query'

const base: ExportOptions = {
  format: 'csv',
  scope: 'current',
  errorClass: '',
  window: '',
  includeMuted: false,
  limit: 500,
}

describe('log export query', () => {
  it('carries every list filter when following the page', () => {
    const qs = exportQuery(
      base,
      {
        sessionId: 's1',
        statusCode: 502,
        endpoint: '/v1/messages',
        mismatch: true,
        minRetry: 1,
        debugOnly: true,
        keyId: 'k1',
        startTime: Date.UTC(2026, 0, 1),
      },
      ['auth']
    )
    expect(Object.fromEntries(qs)).toEqual({
      session_id: 's1',
      status_code: '502',
      endpoint: '/v1/messages',
      response_model_mismatch: '1',
      min_attempt_count: '2',
      log_mode: 'debug',
      key_id: 'k1',
      start_time: '2026-01-01T00:00:00.000Z',
      exclude_error_class: 'auth',
      format: 'csv',
      limit: '500',
    })
  })

  it('uses the same non-2xx filter as the list', () => {
    const qs = exportQuery(base, { excludeStatus200: true }, [])
    expect(qs.get('exclude_status_200')).toBe('1')
    expect(qs.has('status')).toBe(false)
  })

  it('keeps HTTP 200 streaming errors in the current errors-only export', () => {
    const qs = exportQuery(base, { errorsOnly: true, vmId: 'vm-1' }, ['auth'])
    expect(qs.get('errors_only')).toBe('1')
    expect(qs.get('vm_id')).toBe('vm-1')
    expect(qs.has('exclude_status_200')).toBe(false)
  })

  it('drops muting when asked to include muted classes', () => {
    const qs = exportQuery({ ...base, includeMuted: true }, {}, ['auth'])
    expect(qs.get('include_muted')).toBe('1')
    expect(qs.has('exclude_error_class')).toBe(false)
  })

  it('ignores page filters for the all and errors scopes', () => {
    const all = exportQuery({ ...base, scope: 'all' }, { sessionId: 's1' }, [])
    expect(all.has('session_id')).toBe(false)
    expect(all.get('include_muted')).toBe('1')
    const errors = exportQuery(
      { ...base, scope: 'errors', errorClass: 'timeout' },
      { sessionId: 's1' },
      []
    )
    expect(errors.get('error_class')).toBe('timeout')
    expect(errors.has('session_id')).toBe(false)
  })
})
