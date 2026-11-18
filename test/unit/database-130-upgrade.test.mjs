import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from '../../src/lib/db/database.mjs'

function copyMigrationSet(root, release, nextVersion) {
  const migrations = path.resolve('src/lib/db/migrations')
  const directory = path.join(root, `${release}-migrations`)
  fs.mkdirSync(directory)
  for (const name of fs.readdirSync(migrations)) {
    if (name.endsWith('.sql') && name < `${nextVersion}_`) {
      fs.copyFileSync(path.join(migrations, name), path.join(directory, name))
    }
  }
  return directory
}

test('136 appends migrations to the published 121 ledger and preserves business data across reopen', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-130-migrations-'))
  t.after(() => fs.rmSync(root, { recursive: true }))
  const previous = copyMigrationSet(root, '121', '063')
  const target = copyMigrationSet(root, '136', '066')
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
  assert.deepEqual(applyMigrations(db, { migrationsDir: target }), [
    '063_api_key_endpoint.sql',
    '064_risk_audit_bans.sql',
    '065_crag_shop_order_dispatch.sql',
  ])
  db.close()
  db = new DatabaseSync(file)
  try {
    assert.deepEqual(applyMigrations(db, { migrationsDir: target }), [])
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

test('139 adds refusal session storage to the published 13601 ledger and allows rollback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-139-migrations-'))
  t.after(() => fs.rmSync(root, { recursive: true }))
  const previous = copyMigrationSet(root, '13601', '066')
  const file = path.join(root, 'upgrade.db')
  const ledgerQuery = 'SELECT * FROM schema_migrations ORDER BY version'
  const settingsQuery = 'SELECT * FROM settings ORDER BY key'
  const usageQuery = "SELECT * FROM usage_logs WHERE id = 'fixture-log'"
  const db = new DatabaseSync(file)
  let ledger
  let settings
  let usage
  try {
    applyMigrations(db, { migrationsDir: previous })
    db.exec(`
      INSERT INTO settings(key, value) VALUES ('refusal_guard_enabled', 'false');
      INSERT INTO usage_logs(id, request_id, created_at, model, total_cost, output_tokens)
        VALUES ('fixture-log', 'fixture-request', '2026-11-17T00:00:00Z', 'fixture-model', 0.125, 42);
    `)
    ledger = db.prepare(ledgerQuery).all()
    settings = db.prepare(settingsQuery).all()
    usage = db.prepare(usageQuery).get()
    assert.equal(ledger.at(-1).name, '065_crag_shop_order_dispatch.sql')
    assert.deepEqual(applyMigrations(db), ['066_refusal_session_blocks.sql'])
    db.exec(`
      INSERT INTO refusal_session_blocks(session_id, first_seen_at, last_seen_at)
        VALUES ('fixture-session', '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z');
    `)
  } finally {
    db.close()
  }

  const reopened = new DatabaseSync(file)
  try {
    assert.deepEqual(applyMigrations(reopened), [])
    assert.deepEqual(applyMigrations(reopened, { migrationsDir: previous }), [])
    const upgradedLedger = reopened.prepare(ledgerQuery).all()
    assert.deepEqual(upgradedLedger.slice(0, -1), ledger)
    assert.equal(upgradedLedger.at(-1).name, '066_refusal_session_blocks.sql')
    assert.deepEqual(reopened.prepare(settingsQuery).all(), settings)
    assert.deepEqual(reopened.prepare(usageQuery).get(), usage)
    assert.equal(reopened.prepare('SELECT session_id FROM refusal_session_blocks').get().session_id, 'fixture-session')
    assert.equal(reopened.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  } finally {
    reopened.close()
  }
})
