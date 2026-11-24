import type {
  OpenaiApiBatchAction,
  OpenaiApiBatchPayload,
  OpenaiApiKeyTarget,
} from '@/types/panel-openai-apikey'
import { api } from '@/lib/api'

function accountApiUrl(target: OpenaiApiKeyTarget, action: string) {
  return `/api/panel/vms/${encodeURIComponent(target.vm_id)}/openai-api/${action}`
}

export function revealApiKey(target: OpenaiApiKeyTarget) {
  return api<{ api_key: string }>(
    `${accountApiUrl(target, 'key')}?account_id=${encodeURIComponent(target.account_id)}`,
    { cache: 'no-store' }
  )
}

export function saveApiKey(target: OpenaiApiKeyTarget, secret: string) {
  return api(accountApiUrl(target, 'key'), {
    method: 'PUT',
    body: JSON.stringify({
      account_id: target.account_id,
      api_key: secret.trim(),
    }),
  })
}

export function setApiKeyEnabled(target: OpenaiApiKeyTarget, enabled: boolean) {
  return api(accountApiUrl(target, 'enabled'), {
    method: 'PATCH',
    body: JSON.stringify({ account_id: target.account_id, enabled }),
  })
}

export function runApiKeyAction(
  target: OpenaiApiKeyTarget,
  action: 'preview' | 'claim' | 'refresh' | 'resume',
  destinationAccountId?: string
) {
  return api(accountApiUrl(target, action), {
    method: 'POST',
    body: JSON.stringify({
      account_id: target.account_id,
      destination_account_id: destinationAccountId,
    }),
  })
}

export function batchApiKeys(
  action: OpenaiApiBatchAction,
  items: OpenaiApiKeyTarget[]
) {
  return api<OpenaiApiBatchPayload>('/api/panel/openai-apikey/batch', {
    method: 'POST',
    body: JSON.stringify({
      action,
      items: items.map(({ vm_id, account_id }) => ({ vm_id, account_id })),
    }),
  })
}
