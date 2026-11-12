import { getDb } from '../database.mjs'
import { maybeDecrypt, maybeEncrypt } from '../secure.mjs'

const FIELDS = {
  account_id: 'account_id',
  storage_state: 'storage_state_enc',
  billing_session: 'billing_session_enc',
}

function profile(row) {
  if (!row) return null
  return {
    vm_id: row.vm_id,
    account_id: row.account_id,
    storage_state: row.storage_state_enc == null ? null : JSON.parse(maybeDecrypt(row.storage_state_enc)),
    billing_session: row.billing_session_enc == null ? null : JSON.parse(maybeDecrypt(row.billing_session_enc)),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** Shared web credentials for the browser and the Billing HTTP client.
 * The persistent browser directory owns the device identity. */
export class SlotBrowserRepo {
  constructor(db = getDb()) {
    this.rebind(db)
  }

  rebind(db) {
    this.db = db
    this._get = db.prepare('SELECT * FROM slot_browser_profiles WHERE vm_id = ?')
    this._list = db.prepare('SELECT * FROM slot_browser_profiles ORDER BY vm_id')
    this._remove = db.prepare('DELETE FROM slot_browser_profiles WHERE vm_id = ?')
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
    if (Object.hasOwn(patch, 'account_id') && patch.account_id !== undefined) {
      const previous = this._get.get(vmId)
      if (previous?.account_id && previous.account_id !== patch.account_id)
        patch = { ...patch, storage_state: null, billing_session: null }
    }
    const entries = Object.keys(FIELDS)
      .filter((key) => Object.hasOwn(patch, key) && patch[key] !== undefined)
      .map((key) => {
        let value = patch[key]
        if (key === 'storage_state' || key === 'billing_session')
          value = value == null ? null : maybeEncrypt(JSON.stringify(value))
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
}
