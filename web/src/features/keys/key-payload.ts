import type { Vm } from '@/types/panel-vm'
import { isOpenaiApiKeyCandidate } from '@/features/vm/openai-api-state'

export type KeyGroupType =
  'all' | 'anthropic' | 'openai' | 'openai_apikey' | 'pool'

export const KEY_ALLOWED_MODELS_MAX = 200

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
  /** 逗号、空格或换行分隔；留空不限。 */
  allowed_models: string
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label}必须是非负数`)
  return value
}

/** 拆成模型名列表：去空白，按不分大小写去重，保留第一次的写法。 */
export function parseModelList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of text.split(/[\s,，]+/)) {
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

function groupTypeOf(value: string): KeyGroupType {
  if (value === 'anthropic' || value === 'openai' || value === 'openai_apikey')
    return value
  return 'all'
}

export function keyLimitsPayload(
  draft: KeyLimitsDraft,
  mode: 'create' | 'edit',
  options: { isAdmin?: boolean; vms?: Vm[]; currentAllowedVms?: string[] } = {}
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
  const isApi = draft.category === 'api' && draft.group_type !== 'openai_apikey'
  if (isAdmin)
    body.category =
      draft.group_type === 'openai_apikey' ? 'api' : draft.category
  if (isAdmin && draft.group_type === 'pool' && !isApi) {
    const vm_pool_id = String(draft.vm_pool_id || '').trim()
    if (!vm_pool_id) throw new Error('选择一个账号池')
    body.group_type = 'all'
    body.allowed_vms = []
    body.vm_pool_id = vm_pool_id
  } else {
    const group_type = groupTypeOf(draft.group_type)
    let allowed_vms =
      isApi || group_type === 'all'
        ? []
        : [...new Set(draft.allowed_vms.map((id) => id.trim()).filter(Boolean))]
    if (mode === 'edit' && options.vms) {
      const liveIds = new Set(options.vms.map((vm) => vm.id))
      allowed_vms = allowed_vms.filter((id) => liveIds.has(id))
    }
    if (!isApi && group_type !== 'all' && allowed_vms.length === 0) {
      throw new Error(
        group_type === 'openai_apikey'
          ? '至少选择一个 API 账号'
          : '至少选择一台 VM'
      )
    }
    if (group_type === 'openai_apikey' && options.vms) {
      const candidates = new Set(
        options.vms.filter(isOpenaiApiKeyCandidate).map((vm) => vm.id)
      )
      const existing = new Set(
        mode === 'edit' ? options.currentAllowedVms || [] : []
      )
      if (allowed_vms.some((id) => !existing.has(id) && !candidates.has(id)))
        throw new Error('新增账号需已配置 API key')
    }
    body.group_type = group_type
    body.allowed_vms = allowed_vms
    if (
      isAdmin &&
      (isApi || draft.vm_pool_id !== undefined || group_type === 'openai_apikey')
    )
      body.vm_pool_id = null
  }
  const allowed_models = parseModelList(draft.allowed_models)
  if (allowed_models.length > KEY_ALLOWED_MODELS_MAX) {
    throw new Error(`允许的模型最多 ${KEY_ALLOWED_MODELS_MAX} 个`)
  }
  body.allowed_models = allowed_models
  if (mode === 'create') {
    body.name = draft.name.trim()
    const days = nonNegative(draft.expires_in_days, '有效期')
    if (days > 0) body.expires_in_days = days
  }
  return body
}
