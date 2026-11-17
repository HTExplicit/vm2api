import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from '../../src/lib/db/database.mjs'

test('136 appends migrations to the published 121 ledger and preserves business data across reopen', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-130-migrations-'))
  t.after(() => fs.rmSync(root, { recursive: true }))
  const migrations = path.resolve('src/lib/db/migrations')
  const previous = path.join(root, '121-migrations')
  fs.mkdirSync(previous)
  for (const name of fs.readdirSync(migrations)) {
    if (name.endsWith('.sql') && name < '063_') fs.copyFileSync(path.join(migrations, name), path.join(previous, name))
  }
  const file = path.join(root, 'upgrade.db')
  let db = new DatabaseSync(file)
  applyMigrations(db, { migrationsDir: previous })
  db.exec(`
    INSERT INTO settings(key, value) VALUES ('refusal_guard_enabled', 'false');
    INSERT INTO usage_logs(id, request_id, created_at, model, total_cost, output_tokens)
      VALUES ('fixture-log', 'fixture-request', '2026-11-17T00:00:00Z', 'fixture-model', 0.125, 42);
  `)
  const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()
  const usage = { ...db.prepare("SELECT * FROM usage_logs WHERE id = 'fixture-log'").get() }
  const settings = db.prepare('SELECT * FROM settings ORDER BY key').all()
  db.close()
  fs.copyFileSync(file, path.join(root, 'pre-upgrade.db'))
  db = new DatabaseSync(file)
  assert.deepEqual(applyMigrations(db), [
    '063_api_key_endpoint.sql',
    '064_risk_audit_bans.sql',
    '065_crag_shop_order_dispatch.sql',
  ])
  db.close()
  db = new DatabaseSync(file)
  try {
    assert.deepEqual(applyMigrations(db), [])
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version < '063' ORDER BY version").all(), ledger)
    assert.deepEqual(db.prepare('SELECT * FROM settings ORDER BY key').all(), settings)
    const { upstream_status, upstream_400_message, ...after } = db
      .prepare("SELECT * FROM usage_logs WHERE id = 'fixture-log'")
      .get()
    assert.equal(upstream_status, null)
    assert.equal(upstream_400_message, null)
    assert.deepEqual(after, usage)
    assert.ok(
      db
        .prepare('PRAGMA table_info(api_keys)')
        .all()
        .some((column) => column.name === 'api_endpoint_id'),
    )
    assert.ok(
      db
        .prepare('PRAGMA table_info(refusal_device_blocks)')
        .all()
        .some((column) => column.name === 'subject_kind'),
    )
    // The previous migration runner can reopen an upgraded database without rewriting its ledger.
    assert.deepEqual(applyMigrations(db, { migrationsDir: previous }), [])
    assert.equal(db.prepare("SELECT total_cost FROM usage_logs WHERE id = 'fixture-log'").get().total_cost, 0.125)
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  } finally {
    db.close()
  }
})
