import path from 'node:path'
import { decodeJwtPayload } from '../oauth/openai-jwt.mjs'
import { atomicWriteJson, readJsonCached } from './vm-file.mjs'

export const SIWC_CREDENTIAL_FILE = 'codex-siwc.json'
const REFRESH_LEAD_MS = 5 * 60_000

export function codexSiwcPath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, SIWC_CREDENTIAL_FILE)
}

export function readCodexSiwc(projectRoot, vmId) {
  if (!projectRoot || !vmId) return null
  return readJsonCached(codexSiwcPath(projectRoot, vmId))
}

export function writeCodexSiwc(projectRoot, vmId, record) {
  atomicWriteJson(codexSiwcPath(projectRoot, vmId), record, { mode: 0o600, durable: true })
  return record
}

export function codexSiwcOwner(account = {}) {
  const id = decodeJwtPayload(account.id_token)
  const access = decodeJwtPayload(account.access_token)
  const workspace =
    access?.['https://api.openai.com/auth']?.chatgpt_account_id ||
    id?.['https://api.openai.com/auth']?.chatgpt_account_id ||
    account.chatgpt_account_id
  return {
    subject: id?.sub || access?.sub || '',
    workspace: typeof workspace === 'string' && !workspace.startsWith('user-') ? workspace : '',
  }
}

export function sameSiwcOwner(left, right) {
  return !!left?.subject && left.subject === right?.subject && left.workspace === right.workspace
}

export function siwcModelAvailable(models, model) {
  return !models || !model || models.some((entry) => entry.id === String(model).split('/').at(-1))
}

export function siwcRefreshDue(record) {
  const accessDue =
    record.access_rejected || !record.access_token ? 0 : Math.max(0, (record.expires_at || 0) - REFRESH_LEAD_MS)
  return Math.max(accessDue, record.earliest_refresh_at || 0, record.retry_at || 0)
}

export function siwcCanRenew(record) {
  return !!(record?.client_id && record.refresh_token && ['ready', 'refresh_pending'].includes(record.state))
}

export function siwcHasAccess(record, now) {
  return (
    !!record?.access_token && !record.access_rejected && record.expires_at > now && record.state !== 'reauth_required'
  )
}

export function summarizeCodexSiwc(record, owner, now = Date.now()) {
  if (!record) return null
  const bound = sameSiwcOwner(record.owner, owner) && !!record.client_id && record.state !== 'unbound'
  const access = bound && siwcHasAccess(record, now)
  const renewable = bound && siwcCanRenew(record)
  let status = bound ? record.state : 'unbound'
  if (status === 'ready' && renewable && record.retry_at > now) status = 'refresh_backoff'
  if (record.enabled && (!bound || (!access && !renewable))) status = 'reauth_required'
  return {
    enabled: record.enabled === true,
    bound,
    status,
    expires_at:
      bound && Number.isFinite(record.expires_at) && record.expires_at > 0 && record.expires_at <= 8.64e15
        ? record.expires_at
        : null,
    next_refresh_at: renewable ? siwcRefreshDue(record) : null,
    has_token: access || renewable,
    has_refresh: renewable,
    models: bound ? record.models || null : null,
  }
}
