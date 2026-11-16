/** Persisted OpenAI authentication verdict, separate from operator scheduling intent. */
import path from 'node:path'
import { codexSubscriptionAccountId, readCodexAccounts } from '../vm/codex-slot.mjs'
import { atomicWriteJson, readJsonCached } from '../vm/vm-file.mjs'
import { clearOpenAIAccountHold, openAIAccountHold } from '../pool/openai-account-runtime.mjs'

const REVOKED =
  /^(invalid_grant|oauth_invalid_grant|oauth_revoked|token_revoked|refresh_token_reused|refresh_token_invalid)$/
const STRUCTURAL_REFRESH = /^(refresh_rejected|refresh_empty|missing_refresh_token)$/

function record(projectRoot, vmId) {
  return readJsonCached(path.join(projectRoot, 'vms', `${vmId}.json`))
}

function accountId(projectRoot, vmId, account) {
  return codexSubscriptionAccountId(account || readCodexAccounts(projectRoot, vmId)[0] || {})
}

export function captureOpenaiAuth(projectRoot, vmId, account = null) {
  const vm = record(projectRoot, vmId)
  if (!vm) return null
  return {
    projectRoot,
    vmId,
    accountId: accountId(projectRoot, vmId, account),
    revision: vm.codex?.auth_revision || 0,
    credentialRevision: vm.codex?.credential_revision || 0,
  }
}

/** A concurrent 401 must not discard a successfully rotated refresh token. */
export function isOpenaiCredentialCurrent(context) {
  if (!context) return false
  const vm = record(context.projectRoot, context.vmId)
  return (
    !!vm &&
    (vm.codex?.credential_revision || 0) === context.credentialRevision &&
    accountId(context.projectRoot, context.vmId) === context.accountId
  )
}

export function isOpenaiAuthCurrent(context) {
  if (!context) return false
  const vm = record(context.projectRoot, context.vmId)
  return (
    !!vm &&
    (vm.codex?.auth_revision || 0) === context.revision &&
    accountId(context.projectRoot, context.vmId) === context.accountId
  )
}

function publicBlock(block) {
  if (!block) return null
  const { reason, source, status, at, message } = block
  return { reason, source, status, at, message }
}

export function openaiAuthBlock(vm = {}, account = null) {
  if (Object.hasOwn(vm, 'auth_block')) return vm.auth_block
  const block = vm.codex?.auth_block
  if (!block) return null
  const currentId = account ? codexSubscriptionAccountId(account) : vm.codex?.chatgpt_account_id
  if (currentId != null && block.account_id !== currentId) return null
  return publicBlock(block)
}

export function readOpenaiAuthBlock(projectRoot, vmId) {
  const vm = record(projectRoot, vmId)
  return vm ? openaiAuthBlock(vm, readCodexAccounts(projectRoot, vmId)[0] || {}) : null
}

function clearAuthHold(vmId) {
  if (openAIAccountHold(vmId)?.reason === 'oauth_401') clearOpenAIAccountHold(vmId)
}

/** The caller retains its context through its existing refresh/retry sequence. */
export function recordOpenaiAuthResult(context, { status, source, error, message, authenticated = false } = {}) {
  if (!isOpenaiAuthCurrent(context)) return false
  const vm = record(context.projectRoot, context.vmId)
  const code = String(error || '')
  const refreshError = source === 'oauth_refresh' && (REVOKED.test(code) || STRUCTURAL_REFRESH.test(code)) ? code : null
  const blocked = Number(status) === 401 || REVOKED.test(code) || !!refreshError
  if (!blocked && !authenticated) return true
  if (!blocked && !vm.codex?.auth_block && !vm.refresh_error && !vm.codex?.refresh_error) return true
  vm.codex = { ...(vm.codex || {}), auth_revision: context.revision + 1 }
  if (blocked) {
    vm.codex.auth_block = {
      account_id: context.accountId,
      reason: refreshError || (REVOKED.test(code) ? code : 'upstream_401'),
      source,
      status: Number(status) || null,
      at: new Date().toISOString(),
      message: message || 'OpenAI 认证失败，已停止分配，请刷新凭据',
    }
    if (refreshError) {
      vm.refresh_error = refreshError
      if (vm.codex.refresh_error !== refreshError) vm.codex.refresh_error_at = vm.codex.auth_block.at
      vm.codex.refresh_error = refreshError
    }
  } else {
    delete vm.codex.auth_block
    delete vm.refresh_error
    delete vm.codex.refresh_error
    delete vm.codex.refresh_error_at
    clearAuthHold(context.vmId)
  }
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(path.join(context.projectRoot, 'vms', `${context.vmId}.json`), vm, { mode: 0o600 })
  context.revision = vm.codex.auth_revision
  return true
}

/** Successful credential replacement invalidates results still in flight. */
export function resetOpenaiAuth(projectRoot, vmId) {
  const context = captureOpenaiAuth(projectRoot, vmId)
  if (!context) return false
  const vm = record(projectRoot, vmId)
  vm.codex = {
    ...(vm.codex || {}),
    auth_revision: context.revision + 1,
    credential_revision: context.credentialRevision + 1,
  }
  delete vm.codex.auth_block
  delete vm.refresh_error
  delete vm.codex.refresh_error
  delete vm.codex.refresh_error_at
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(path.join(projectRoot, 'vms', `${vmId}.json`), vm, { mode: 0o600 })
  clearAuthHold(vmId)
  return true
}
