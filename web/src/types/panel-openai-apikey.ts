import type { OpenaiApiView } from './panel-vm'

export type OpenaiApiCallStatus =
  | 'ready'
  | 'disabled'
  | 'upstream_disabled'
  | 'rate_limited'
  | 'quota_blocked'
  | 'invalid_key'
  | 'proxy_missing'
  | 'binding_error'

export type OpenaiApiKeyTarget = { vm_id: string; account_id: string }

export type OpenaiApiKeyEntry = OpenaiApiView &
  OpenaiApiKeyTarget & {
    email: string
    slot_name: string
    key_id: string | null
    endpoint_id: string | null
    call_status: OpenaiApiCallStatus | null
    call_error?: { code: string; message: string; at: string } | null
    cooldown_until?: string | null
    proxy: {
      id: string | null
      name: string
      label?: string | null
      host?: string | null
      port?: number | string | null
      scheme?: string | null
      kind?: string | null
      node_name?: string | null
      available: boolean
    }
    today_requests: number
    today_cost: number | null
    last_used_at: string | null
    unpriced_requests?: number
  }

export type OpenaiApiKeyPayload = {
  items: OpenaiApiKeyEntry[]
}

export type OpenaiApiBatchAction =
  'enable' | 'disable' | 'refresh_balance' | 'delete' | 'resume'

export type OpenaiApiBatchResult = OpenaiApiKeyTarget & {
  status: 'done' | 'queued' | 'error'
  error?: { code: string; message: string }
}

export type OpenaiApiBatchPayload = { results: OpenaiApiBatchResult[] }
