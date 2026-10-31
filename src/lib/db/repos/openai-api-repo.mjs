import { getDb } from '../database.mjs'
import { maybeDecrypt, maybeEncrypt } from '../secure.mjs'

const ACCOUNT_FIELDS = {
  vm_id: 'vm_id',
  organization_id: 'organization_id',
  key_id: 'key_id',
  enabled: 'enabled',
  claim_status: 'claim_status',
  ineligibility_reason: 'ineligibility_reason',
  operation_id: 'operation_id',
  destination_account_id: 'destination_account_id',
  offer: 'offer_json',
  benefit: 'benefit_json',
  destinations: 'destinations_json',
  delivery: 'delivery_json',
  setup_status: 'setup_status',
  fingerprint: 'fingerprint_json',
  storage_state: 'storage_state_enc',
  last_error: 'last_error',
}
const ORG_FIELDS = {
  display_name: 'display_name',
  project_id: 'project_id',
  endpoint_id: 'endpoint_id',
  balance: 'balance',
  balance_checked_at: 'balance_checked_at',
  balance_error: 'balance_error',
}
const JSON_FIELDS = new Set(['offer', 'benefit', 'destinations', 'delivery', 'fingerprint'])

function encode(key, value) {
  if (key === 'enabled') return value ? 1 : 0
  if (JSON_FIELDS.has(key)) return value == null ? null : JSON.stringify(value)
  if (key === 'storage_state') return value == null ? null : maybeEncrypt(JSON.stringify(value))
  if (key === 'balance') return value == null ? null : String(value)
  return value
}

function accountRow(row) {
  if (!row) return null
  const value = { account_id: row.account_id, created_at: row.created_at, updated_at: row.updated_at }
  for (const [key, column] of Object.entries(ACCOUNT_FIELDS)) {
    if (key === 'enabled') value[key] = !!row[column]
    else if (JSON_FIELDS.has(key)) value[key] = row[column] == null ? null : JSON.parse(row[column])
    else if (key === 'storage_state') value[key] = row[column] == null ? null : JSON.parse(maybeDecrypt(row[column]))
    else value[key] = row[column]
  }
  return value
}

/** Account credentials are stored once; organization balance/project state is shared. */
export class OpenaiApiRepo {
  constructor(db = getDb()) {
    this.rebind(db)
  }

  rebind(db) {
    this.db = db
    this._getAccount = db.prepare('SELECT * FROM openai_api_accounts WHERE account_id = ?')
    this._getOrg = db.prepare('SELECT * FROM openai_api_orgs WHERE organization_id = ?')
    this._listAccounts = db.prepare('SELECT * FROM openai_api_accounts ORDER BY created_at, account_id')
    this._listOrgs = db.prepare('SELECT * FROM openai_api_orgs ORDER BY created_at, organization_id')
    this._getKey = db.prepare('SELECT * FROM api_endpoint_keys WHERE id = ?')
    return this
  }

  getAccount(accountId) {
    return accountRow(this._getAccount.get(accountId))
  }

  upsertAccount(accountId, patch = {}) {
    this.upsert('openai_api_accounts', 'account_id', accountId, ACCOUNT_FIELDS, patch)
    return this.getAccount(accountId)
  }

  getOrg(organizationId) {
    const row = this._getOrg.get(organizationId)
    return row ? { ...row } : null
  }

  upsertOrg(organizationId, patch = {}) {
    this.upsert('openai_api_orgs', 'organization_id', organizationId, ORG_FIELDS, patch)
    return this.getOrg(organizationId)
  }

  listAccounts() {
    return this._listAccounts.all().map(accountRow)
  }

  listOrgs() {
    return this._listOrgs.all().map((row) => ({ ...row }))
  }

  getKey(keyId) {
    if (!keyId) return null
    const row = this._getKey.get(keyId)
    return row ? { ...row, api_key: maybeDecrypt(row.api_key), disabled: !!row.disabled } : null
  }

  upsert(table, idColumn, id, fields, patch) {
    if (!id) throw new Error(`${idColumn} is required`)
    const entries = Object.keys(fields)
      .filter((key) => Object.hasOwn(patch, key) && patch[key] !== undefined)
      .map((key) => [fields[key], encode(key, patch[key])])
    const stamp = new Date().toISOString()
    const columns = [idColumn, ...entries.map(([column]) => column), 'created_at', 'updated_at']
    const updates = [...entries.map(([column]) => `${column} = excluded.${column}`), 'updated_at = excluded.updated_at']
    this.db
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
        ON CONFLICT(${idColumn}) DO UPDATE SET ${updates.join(', ')}`)
      .run(id, ...entries.map(([, value]) => value), stamp, stamp)
  }
}
