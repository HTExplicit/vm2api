/**
 * SQL predicates over `usage_logs` shared by every reader (legacy request-log
 * repo, scrolling log view, statistics). Columns are unqualified: callers query
 * `usage_logs` without joins and resolve display names separately.
 */

import { FAILED_REQUEST_STATES, ignoredErrorSqlList, slaOkErrorSqlList } from '../../admin/error-class.mjs'

const IGNORED_CODES_SQL = ignoredErrorSqlList()
const SLA_OK_CODES_SQL = slaOkErrorSqlList()

const CANCEL_PRED = `((status IS NULL OR status < 400 OR status = 499) AND (final_state = 'cancelled' OR error_code IN (${IGNORED_CODES_SQL})))`
const FAILED_STATE_PRED = `final_state IN (${FAILED_REQUEST_STATES.map((state) => `'${state}'`).join(', ')})`
export const ERROR_PRED = `(NOT IFNULL(${CANCEL_PRED}, 0) AND (status >= 400 OR (error_code IS NOT NULL AND error_code != '') OR ${FAILED_STATE_PRED}))`
export const SUCCESS_PRED = `(status < 400 AND NOT IFNULL(${ERROR_PRED}, 0))`
const SLA_OK_PRED = `(status = 429 OR (error_code IS NOT NULL AND error_code != '' AND error_code IN (${SLA_OK_CODES_SQL})))`
export const SLA_SUCCESS_PRED = `(${SUCCESS_PRED} OR ${SLA_OK_PRED})`
export const SLA_ERROR_PRED = `(${ERROR_PRED} AND NOT (${SLA_OK_PRED}))`

// After migration 037 every row stores disjoint input. Prompt (cache hit
// denominator) is the input-side total; total tokens also include output.
export const PROMPT_TOKENS_SQL =
  'IFNULL(input_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0)'
export const TOTAL_TOKENS_SQL =
  'IFNULL(input_tokens, 0) + IFNULL(output_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0)'

export function totalTokens(row = {}) {
  return (
    (Number(row.input_tokens) || 0) +
    (Number(row.output_tokens) || 0) +
    (Number(row.cache_read_tokens) || 0) +
    (Number(row.cache_creation_tokens) || 0)
  )
}

/** Rows a panel `user` owns: own user_id, one of their live keys, or served by a slot they owned at the time. */
export function ownerPred(ownerUserId) {
  const id = String(ownerUserId || '').trim()
  if (!id) return { sql: '', params: [] }
  return {
    sql: `(user_id = ? OR IFNULL(api_key_id, '') IN (SELECT id FROM api_keys WHERE user_id = ? AND deleted_at IS NULL) OR vm_owner_user_id = ?)`,
    params: [id, id, id],
  }
}
