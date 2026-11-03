import { hasBoundExit } from '../vm/egress.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'

export const QUOTA_BLOCK = '9999-12-31T23:59:59.999Z'

/** The usage switch is intent; these are the effective constraints on a send. */
export function accountApiKeyState({ vm, accountId, record, key, endpoint, now = Date.now() }) {
  if (
    !key ||
    !endpoint ||
    record?.key_id !== key.id ||
    key.source_vm_id !== vm?.id ||
    key.source_account_id !== accountId
  )
    return { status: 'binding_error', reason: 'API key 与当前账号的关联不完整' }
  if (!record.enabled) return { status: 'disabled', reason: 'API 使用已关闭' }
  if (endpoint.disabled) return { status: 'upstream_disabled', reason: 'API 上游已停用' }
  if (key.disabled) return { status: 'invalid_key', reason: 'API key 已被禁用，请替换密钥' }
  if (key.cooldown_until === QUOTA_BLOCK)
    return { status: 'quota_blocked', reason: '官方返回额度或配额不足，等待人工解除' }
  if (!endpoint.disable_cooling && Date.parse(key.cooldown_until || '') > now)
    return { status: 'rate_limited', reason: 'API key 正在限流冷却' }
  if (!hasBoundExit(vm.proxy) || !hostProxyUrlForVm(vm))
    return { status: 'proxy_missing', reason: '账号未绑定可用代理' }
  return { status: 'ready', reason: null }
}
