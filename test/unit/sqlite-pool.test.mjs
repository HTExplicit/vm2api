import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDatabase, createDatabase, getDb, openDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { readAll, usageRead } from '../../src/lib/db/sqlite-pool.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'

test('usage reads run on read-only workers and leave the event loop free', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sqlite-pool-'))
  openDatabase({ dataDir: dir, pooled: true })
  try {
    await readAll('SELECT 1 AS n')
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 5)
    const started = Date.now()
    const rows = await readAll(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000) SELECT max(x) AS n FROM c',
    )
    const elapsed = Date.now() - started
    clearInterval(timer)
    assert.equal(Number(rows[0].n), 4000000)
    assert.ok(elapsed >= 20, `scan finished too fast to observe the loop: ${elapsed}ms`)
    assert.ok(ticks > 0, `main thread did not tick during a ${elapsed}ms scan`)

    await assert.rejects(readAll('CREATE TABLE forbidden_write (id INTEGER)'), /readonly/)

    const local = new UsageLogsRepo(getDb()).totals()
    const remote = await usageRead({ kind: 'repo', method: 'totals' })
    assert.equal(Number(remote.requests), Number(local.requests))
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('billing workers preserve results, read scopes, and main-writer cost maintenance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-billing-worker-'))
  const db = openDatabase({ dataDir: dir, pooled: true })
  try {
    const store = new RequestLogStore({ db, dataDir: dir })
    const now = Date.now()
    const createdAt = new Date(now).toISOString()
    db.prepare(`INSERT INTO usage_logs
      (id, request_id, created_at, model, status, input_tokens, output_tokens, vm_id, account_id, user_id,
       total_cost, actual_cost, pricing_model)
      VALUES (?, ?, ?, ?, 200, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'priced',
      'request-priced',
      createdAt,
      'gpt-5.5',
      100,
      20,
      'vm-a',
      'account-a',
      'user-a',
      1,
      2,
      'gpt-5.5',
    )
    db.prepare(`INSERT INTO usage_logs
      (id, request_id, created_at, model, status, input_tokens, output_tokens, vm_id, account_id, user_id)
      VALUES ('legacy', 'request-legacy', ?, 'claude-opus-5', 200, 1000000, 0, 'vm-b', 'account-b', 'user-b')`).run(
      createdAt,
    )
    const opts = {
      now,
      accountWindows: [{ account_id: 'account-a', vm_id: 'vm-a', reset_5h: new Date(now + 10000).toISOString() }],
    }
    const direct = store.repo.billingStatsReadOnly(opts)
    assert.deepEqual(await usageRead({ kind: 'repo', method: 'billingStatsReadOnly', args: [opts] }), direct)
    assert.equal(db.prepare("SELECT pricing_model FROM usage_logs WHERE id='legacy'").get().pricing_model, null)

    const backfill = store.repo.backfillMissingCosts.bind(store.repo)
    let maintenanceRuns = 0
    store.repo.backfillMissingCosts = () => {
      maintenanceRuns++
      return backfill()
    }
    await Promise.all([store.billingStatsAsync(opts), store.billingStatsAsync(opts)])
    assert.equal(maintenanceRuns, 1)
    assert.equal(
      db.prepare("SELECT pricing_model FROM usage_logs WHERE id='legacy'").get().pricing_model,
      'claude-opus-5',
    )
    assert.deepEqual(await store.billingStatsAsync(opts), store.repo.billingStatsReadOnly(opts))

    const owner = { ownerUserId: 'user-a', groupBy: 'vm' }
    assert.deepEqual(await store.ownerBillingAsync(owner), store.ownerBilling(owner))
    assert.deepEqual(
      (await store.ownerBillingAsync(owner)).items.map((item) => item.vm_id),
      ['vm-a'],
    )
    const span = { vmId: 'vm-a', accountId: 'account-a', since: createdAt, until: now }
    assert.deepEqual(await store.costBetweenAsync(span), store.costBetween(span))
    assert.deepEqual(await store.costByModelAsync(span), store.costByModel(span))
    assert.deepEqual(
      await store.vmUsageStatsAsync({ vmId: 'vm-a', days: 30 }),
      store.vmUsageStats({ vmId: 'vm-a', days: 30 }),
    )
    await assert.rejects(usageRead({ kind: 'repo', method: 'backfillMissingCosts' }), /not readable/)
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('async statistics keep independent databases separate and reject a replaced pool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-stats-db-scope-'))
  const aDir = path.join(root, 'a')
  const bDir = path.join(root, 'b')
  const cDir = path.join(root, 'c')
  const db = openDatabase({ dataDir: aDir, pooled: true })
  const independent = createDatabase({ dataDir: bDir })
  const insert = (database, id, cost) =>
    database
      .prepare(`INSERT INTO usage_logs
    (id, request_id, created_at, status, vm_id, total_cost, pricing_model)
    VALUES (?, ?, ?, 200, ?, ?, 'synthetic')`)
      .run(id, id, new Date().toISOString(), id, cost)
  try {
    insert(db, 'vm-a', 1)
    insert(independent, 'vm-b', 9)
    const shared = new RequestLogStore({ db, dataDir: aDir })
    const separate = new RequestLogStore({ db: independent, dataDir: bDir })
    assert.equal((await shared.billingStatsAsync({ now: Date.now() })).total.total_cost, 1)
    assert.equal((await separate.billingStatsAsync({ now: Date.now() })).total.total_cost, 9)

    const oldRead = shared.billingStatsAsync({ now: Date.now() })
    const rejected = assert.rejects(oldRead, /pool (changed|stopped)/)
    closeDatabase()
    const replacement = openDatabase({ dataDir: cDir, pooled: true })
    insert(replacement, 'vm-c', 3)
    shared.rebind(replacement)
    await rejected
    assert.equal((await shared.billingStatsAsync({ now: Date.now() })).total.total_cost, 3)

    replacement.exec('DROP TABLE usage_logs')
    let synchronousReads = 0
    shared.billingStats = () => {
      synchronousReads++
      return { total: { total_cost: 42 } }
    }
    await assert.rejects(shared.billingStatsAsync({ now: Date.now() }), /usage_logs/)
    assert.equal(synchronousReads, 0, 'worker failure must not fall back to the main-thread aggregate')
  } finally {
    independent.close()
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
