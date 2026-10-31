import { getDb, withTransaction } from '../database.mjs'
import { maybeDecrypt, maybeEncrypt } from '../secure.mjs'

const FIELDS = {
  account_id: 'account_id',
  fingerprint: 'fingerprint_json',
  storage_state: 'storage_state_enc',
}

function profile(row) {
  if (!row) return null
  return {
    vm_id: row.vm_id,
    account_id: row.account_id,
    fingerprint: row.fingerprint_json == null ? null : JSON.parse(row.fingerprint_json),
    storage_state: row.storage_state_enc == null ? null : JSON.parse(maybeDecrypt(row.storage_state_enc)),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** One persistent web identity per slot. No browser cache or secret duplicates. */
export class SlotBrowserRepo {
  constructor(db = getDb()) {
    this.rebind(db)
  }

  rebind(db) {
    this.db = db
    this._get = db.prepare('SELECT * FROM slot_browser_profiles WHERE vm_id = ?')
    this._list = db.prepare('SELECT * FROM slot_browser_profiles ORDER BY vm_id')
    this._remove = db.prepare('DELETE FROM slot_browser_profiles WHERE vm_id = ?')
    this.migrateLegacyProfiles()
    return this
  }

  get(vmId) {
    return profile(this._get.get(vmId))
  }

  list() {
    return this._list.all().map(profile)
  }

  upsert(vmId, patch = {}) {
    if (!vmId) throw new Error('vm_id is required')
    const entries = Object.keys(FIELDS)
      .filter((key) => Object.hasOwn(patch, key) && patch[key] !== undefined)
      .map((key) => {
        let value = patch[key]
        if (key === 'fingerprint') value = value == null ? null : JSON.stringify(value)
        if (key === 'storage_state') value = value == null ? null : maybeEncrypt(JSON.stringify(value))
        return [FIELDS[key], value]
      })
    const stamp = new Date().toISOString()
    const columns = ['vm_id', ...entries.map(([column]) => column), 'created_at', 'updated_at']
    const updates = [...entries.map(([column]) => `${column} = excluded.${column}`), 'updated_at = excluded.updated_at']
    this.db
      .prepare(`INSERT INTO slot_browser_profiles (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
        ON CONFLICT(vm_id) DO UPDATE SET ${updates.join(', ')}`)
      .run(vmId, ...entries.map(([, value]) => value), stamp, stamp)
    return this.get(vmId)
  }

  remove(vmId) {
    return this._remove.run(vmId).changes > 0
  }

  /** SQL migrations cannot inspect an encrypted vms.vm_json. Only move legacy
   * state after verifying the currently registered slot still owns the account. */
  migrateLegacyProfiles() {
    return withTransaction(this.db, () => {
      const rows = this.db
        .prepare(`SELECT a.*, v.vm_json FROM openai_api_accounts a
          JOIN vms v ON v.id = a.vm_id
          WHERE a.fingerprint_json IS NOT NULL OR a.storage_state_enc IS NOT NULL`)
        .all()
      let migrated = 0
      const clear = this.db.prepare(
        'UPDATE openai_api_accounts SET fingerprint_json = NULL, storage_state_enc = NULL WHERE account_id = ?',
      )
      for (const row of rows) {
        let vm
        try {
          vm = JSON.parse(maybeDecrypt(row.vm_json))
        } catch {
          continue
        }
        if (vm?.id !== row.vm_id || vm.codex?.chatgpt_account_id !== row.account_id) continue
        const existing = this._get.get(row.vm_id)
        if (existing && existing.account_id !== row.account_id) continue
        if (!existing) {
          this.db
            .prepare(`INSERT INTO slot_browser_profiles
              (vm_id, account_id, fingerprint_json, storage_state_enc, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
            .run(row.vm_id, row.account_id, row.fingerprint_json, row.storage_state_enc, row.created_at, row.updated_at)
        }
        clear.run(row.account_id)
        migrated++
      }
      return migrated
    })
  }
}
