import type { Vm } from '@/types/panel-vm'

export type KeyGroupType =
  'all' | 'anthropic' | 'openai' | 'openai_apikey' | 'pool'

export type KeyLimitsDraft = {
  name: string
  category: 'oauth' | 'api'
  max_concurrency: number
  quota_requests: number
  quota_usd: number
  rpm: number
  expires_in_days: number
  group_type: KeyGroupType
  allowed_vms: string[]
  vm_pool_id?: string
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label}必须是非负数`)
  return value
}

function groupTypeOf(value: string): KeyGroupType {
  if (value === 'anthropic' || value === 'openai' || value === 'openai_apikey')
    return value
  return 'all'
}

export function keyLimitsPayload(
  draft: KeyLimitsDraft,
  mode: 'create' | 'edit',
  options: { isAdmin?: boolean; vms?: Vm[] } = {}
): Record<string, unknown> {
  const isAdmin = options.isAdmin ?? true
  if (!isAdmin && draft.group_type === 'openai_apikey')
    throw new Error('OpenAI(apikey) 分组仅管理员可设置')
  const requests = nonNegative(draft.quota_requests, '请求额度')
  if (!Number.isInteger(requests)) throw new Error('请求额度必须是整数')
  const body: Record<string, unknown> = {
    max_concurrency: nonNegative(draft.max_concurrency, '并发'),
    quota_requests: requests,
    quota_usd: nonNegative(draft.quota_usd, 'USD 额度'),
    rpm: nonNegative(draft.rpm, 'RPM'),
  }
  // 账号 API key 使用 API 后端，账号勾选范围仍由分组保存。
  if (isAdmin)
    body.category =
      draft.group_type === 'openai_apikey' ? 'api' : draft.category
  if (isAdmin && draft.group_type === 'pool') {
    const vm_pool_id = String(draft.vm_pool_id || '').trim()
    if (!vm_pool_id) throw new Error('选择一个账号池')
    body.group_type = 'all'
    body.allowed_vms = []
    body.vm_pool_id = vm_pool_id
  } else {
    const group_type = groupTypeOf(draft.group_type)
    const allowed_vms =
      group_type === 'all'
        ? []
        : [...new Set(draft.allowed_vms.map((id) => id.trim()).filter(Boolean))]
    if (group_type !== 'all' && allowed_vms.length === 0) {
      throw new Error(
        group_type === 'openai_apikey'
          ? '至少选择一个 API 账号'
          : '至少选择一台 VM'
      )
    }
    if (group_type === 'openai_apikey' && options.vms) {
      const configured = new Set(
        options.vms.filter((vm) => vm.openai_api?.has_key).map((vm) => vm.id)
      )
      if (allowed_vms.some((id) => !configured.has(id)))
        throw new Error('所选账号尚未配置 API key，请先完成账号 API 配置')
    }
    body.group_type = group_type
    body.allowed_vms = allowed_vms
    if (
      isAdmin &&
      (draft.vm_pool_id !== undefined || group_type === 'openai_apikey')
    )
      body.vm_pool_id = null
  }
  if (mode === 'create') {
    body.name = draft.name.trim()
    const days = nonNegative(draft.expires_in_days, '有效期')
    if (days > 0) body.expires_in_days = days
  }
  return body
}
