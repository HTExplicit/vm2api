import type {
  OpenaiApiBatchAction,
  OpenaiApiBatchPayload,
  OpenaiApiKeyTarget,
} from '@/types/panel-openai-apikey'
import { api } from '@/lib/api'
import { apiKeyUrl } from './key-display'

export function revealApiKey(target: OpenaiApiKeyTarget) {
  return api<{ api_key: string }>(
    `${apiKeyUrl(target)}?account_id=${encodeURIComponent(target.account_id)}`,
    { cache: 'no-store' }
  )
}

export function saveApiKey(target: OpenaiApiKeyTarget, secret: string) {
  return api(apiKeyUrl(target), {
    method: 'PUT',
    body: JSON.stringify({
      account_id: target.account_id,
      api_key: secret.trim(),
    }),
  })
}

export function setApiKeyEnabled(target: OpenaiApiKeyTarget, enabled: boolean) {
  return api(apiKeyUrl(target).replace(/\/key$/, '/enabled'), {
    method: 'PATCH',
    body: JSON.stringify({ account_id: target.account_id, enabled }),
  })
}

export function runApiKeyAction(
  target: OpenaiApiKeyTarget,
  action: 'refresh' | 'resume'
) {
  return api(apiKeyUrl(target).replace(/\/key$/, `/${action}`), {
    method: 'POST',
    body: JSON.stringify({ account_id: target.account_id }),
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
