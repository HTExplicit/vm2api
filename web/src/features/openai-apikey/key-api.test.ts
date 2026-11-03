import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  batchApiKeys,
  revealApiKey,
  runApiKeyAction,
  saveApiKey,
  setApiKeyEnabled,
} from './key-api'

const api = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api }))
const target = { vm_id: 'slot / one', account_id: 'account/a' }
beforeEach(() => api.mockReset())

describe('account key operations', () => {
  it('reveals only on demand without browser cache and carries the displayed identity', async () => {
    expect(api).not.toHaveBeenCalled()
    api.mockResolvedValue({ api_key: 'secret' })
    expect(await revealApiKey(target)).toEqual({ api_key: 'secret' })
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/vms/slot%20%2F%20one/openai-api/key?account_id=account%2Fa',
      { cache: 'no-store' }
    )
  })
  it('binds directly with identity and secret without querying models', async () => {
    await saveApiKey(target, '  sk-saved  ')
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/vms/slot%20%2F%20one/openai-api/key',
      {
        method: 'PUT',
        body: JSON.stringify({ account_id: 'account/a', api_key: 'sk-saved' }),
      }
    )
  })
  it('uses existing enabled, balance and quota interfaces with the same account identity', async () => {
    await setApiKeyEnabled(target, false)
    await runApiKeyAction(target, 'resume')
    await runApiKeyAction(target, 'refresh')
    expect(api).toHaveBeenNthCalledWith(
      1,
      '/api/panel/vms/slot%20%2F%20one/openai-api/enabled',
      {
        method: 'PATCH',
        body: JSON.stringify({ account_id: 'account/a', enabled: false }),
      }
    )
    expect(api).toHaveBeenNthCalledWith(
      2,
      '/api/panel/vms/slot%20%2F%20one/openai-api/resume',
      { method: 'POST', body: JSON.stringify({ account_id: 'account/a' }) }
    )
    expect(api).toHaveBeenNthCalledWith(
      3,
      '/api/panel/vms/slot%20%2F%20one/openai-api/refresh',
      { method: 'POST', body: JSON.stringify({ account_id: 'account/a' }) }
    )
  })
  it('sends only identities for batch operations and leaves partial outcomes intact', async () => {
    const results = [
      {
        ...target,
        status: 'error',
        error: { code: 'changed', message: 'changed' },
      },
    ]
    api.mockResolvedValue({ results })
    expect(await batchApiKeys('delete', [target])).toEqual({ results })
    expect(api).toHaveBeenCalledExactlyOnceWith(
      '/api/panel/openai-apikey/batch',
      {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', items: [target] }),
      }
    )
  })
})
