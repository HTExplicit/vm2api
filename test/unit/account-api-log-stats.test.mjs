import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-account-api-log-'))
  const db = createDatabase({ dbPath: path.join(dir, 'logs.db') })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.exec(`
    INSERT INTO vms (id, name, vm_json) VALUES ('slot-a', 'Slot A', '{}'), ('slot-b', 'Slot B', '{}');
    INSERT INTO api_endpoints (id, name, base_url, kind, created_at, updated_at)
    VALUES ('ep-a', 'OpenAI API A', 'https://api.openai.com', 'openai', '2026-01-01', '2026-01-01'),
           ('ep-b', 'OpenAI API B', 'https://api.openai.com', 'openai', '2026-01-01', '2026-01-01');
    INSERT INTO api_endpoint_keys (id, endpoint_id, api_key, source_vm_id, source_account_id, created_at)
    VALUES ('ek-a', 'ep-a', 'sk-fixture-a', 'slot-a', 'account-a', '2026-01-01'),
           ('ek-b', 'ep-b', 'sk-fixture-b', 'slot-b', 'account-b', '2026-01-01');
  `)
  return { db, logs: new UsageLogsRepo(db), attempts: new RequestAttemptsRepo(db), view: new UsageLogsView(db) }
}

function summary(logs, requestId, at, extra = {}) {
  logs.insertSummary({
    id: `log-${requestId}`,
    request_id: requestId,
    created_at: at,
    log_mode: 'normal',
    method: 'POST',
    path: '/v1/responses',
    protocol: 'openai.responses',
    model: 'gpt-fixture',
    status: 200,
    duration_ms: 1000,
    account_id: 'ek-a',
    final_account_id: 'ek-a',
    vm_id: null,
    via: 'api-kernel',
    source_account_id: 'account-a',
    source_vm_id: 'slot-a',
    source_email: 'a@example.test',
    ...extra,
  })
}

function attempt(db, attempts, { requestId, attemptNo = 1, source = 'a', at, ...result }) {
  attempts.begin({
    requestId,
    attemptNo,
    accountId: `ek-${source}`,
    vmId: null,
    model: 'gpt-fixture',
    selectionReason: attemptNo === 1 ? 'roundrobin' : 'failover',
    sourceAccountId: `account-${source}`,
    sourceVmId: `slot-${source}`,
    sourceEmail: `${source}@example.test`,
  })
  attempts.complete(requestId, attemptNo, { upstreamStatus: 200, terminalState: 'success', ...result })
  db.prepare('UPDATE request_attempts SET started_at = ?, completed_at = ? WHERE request_id = ? AND attempt_no = ?')
    .run(at, at, requestId, attemptNo)
}

test('account API source and official rejection survive local key deletion in logs and attempt chains', (t) => {
  const { db, logs, attempts, view } = fixture(t)
  attempt(db, attempts, {
    requestId: 'rejected',
    at: '2026-11-03T03:00:00.000Z',
    upstreamStatus: 429,
    errorCode: 'credit_balance_exhausted',
    errorMessage: 'Credit balance exhausted',
    terminalState: 'rejected',
    action: 'next_unit',
  })
  summary(logs, 'rejected', '2026-11-03T03:00:00.100Z', { status: 429, total_cost: 0 })
  db.exec("DELETE FROM api_endpoint_keys WHERE id = 'ek-a'; DELETE FROM api_endpoints WHERE id = 'ep-a'")

  const stored = logs.getByRequestId('rejected')
  assert.equal(stored.account_id, 'ek-a')
  assert.equal(stored.vm_id, null)
  assert.equal(stored.source_account_id, 'account-a')
  assert.equal(stored.source_vm_id, 'slot-a')
  const storedAttempt = attempts.list('rejected')[0]
  assert.equal(storedAttempt.account_id, 'ek-a')
  assert.equal(storedAttempt.vm_id, null)
  assert.equal(storedAttempt.source_account_id, 'account-a')
  assert.equal(storedAttempt.source_email, 'a@example.test')
  assert.equal(storedAttempt.error_code, 'credit_balance_exhausted')
  assert.equal(storedAttempt.error_message, 'Credit balance exhausted')

  const row = view.listBatch({ source_account_id: 'account-a', include_muted: true }).logs[0]
  assert.equal(row.providerName, 'a@example.test')
  assert.equal(row.accountId, 'ek-a')
  assert.equal(row.vmId, null)
  assert.equal(row.sourceAccountId, 'account-a')
  assert.equal(row.providerChain[0].providerName, 'a@example.test')
  assert.equal(row.providerChain[0].errorCode, 'credit_balance_exhausted')
  assert.equal(row.providerChain[0].sourceVmId, 'slot-a')
})

test('failover counts a rejected A and successful B once each, with cost only on the final source', (t) => {
  const { db, logs, attempts, view } = fixture(t)
  attempt(db, attempts, {
    requestId: 'switch',
    at: '2026-11-03T04:00:00.000Z',
    upstreamStatus: 401,
    errorCode: 'invalid_api_key',
    terminalState: 'rejected',
    action: 'next_unit',
  })
  attempt(db, attempts, { requestId: 'switch', attemptNo: 2, source: 'b', at: '2026-11-03T04:00:00.200Z' })
  summary(logs, 'switch', '2026-11-03T04:00:00.800Z', {
    account_id: 'ek-b', final_account_id: 'ek-b', source_account_id: 'account-b',
    source_vm_id: 'slot-b', source_email: 'b@example.test', attempt_count: 2,
    input_tokens: 10, output_tokens: 5, total_cost: 0.012, actual_cost: 0.12,
  })
  const stats = logs.accountApiUsage(['account-a', 'account-b'], Date.parse('2026-11-03T12:00:00Z'), 'UTC')
  assert.equal(stats.get('account-a').today_requests, 1)
  assert.equal(stats.get('account-b').today_requests, 1)
  assert.equal(stats.get('account-b').today_cost, 0.012)
  assert.equal(stats.get('account-b').last_used_at, '2026-11-03T04:00:00.200Z')
  assert.equal(stats.get('account-a').last_used_at, '2026-11-03T04:00:00.000Z')

  const filtered = view.listBatch({ source_account_id: 'account-a', include_muted: true }).logs
  assert.equal(filtered.length, 1, 'a failed source remains discoverable through its attempt')
  assert.equal(filtered[0].sourceAccountId, 'account-b', 'the final billing source remains B')
  assert.equal(filtered[0].providerChain.length, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get().n, 1)
})

test('account totals bridge old single-hop logs and new attempts without mixing a replacement account', (t) => {
  const { db, logs, attempts } = fixture(t)
  summary(logs, 'old-key', '2026-11-03T02:00:00.000Z', { input_tokens: 2, total_cost: 0.01 })
  attempt(db, attempts, { requestId: 'new-key', at: '2026-11-03T05:00:00.000Z' })
  summary(logs, 'new-key', '2026-11-03T05:00:00.500Z', { input_tokens: 3, total_cost: 0.02 })
  summary(logs, 'different-account-same-slot', '2026-11-03T06:00:00.000Z', {
    account_id: 'ek-replacement', final_account_id: 'ek-replacement',
    source_account_id: 'account-other', source_vm_id: 'slot-a', source_email: 'other@example.test',
    input_tokens: 7, total_cost: 4,
  })
  summary(logs, 'oauth-slot', '2026-11-03T07:00:00.000Z', {
    account_id: 'account-a', final_account_id: 'account-a', vm_id: 'slot-a', via: 'codex',
    source_account_id: null, source_vm_id: null, source_email: null, total_cost: 10,
  })
  db.exec("DELETE FROM api_endpoint_keys WHERE id = 'ek-a'")
  const stat = logs.accountApiUsage(['account-a'], Date.parse('2026-11-03T12:00:00Z'), 'UTC').get('account-a')
  assert.equal(stat.today_requests, 2)
  assert.equal(stat.today_cost, 0.03)
  assert.equal(stat.last_used_at, '2026-11-03T05:00:00.000Z')
})

test('unpriced usage stays unknown while a priced zero and a rejected attempt are not marked unpriced', (t) => {
  const { db, logs, attempts } = fixture(t)
  summary(logs, 'unpriced', '2026-11-03T02:00:00.000Z', { input_tokens: 10, total_cost: null, price_source: 'unpriced' })
  attempt(db, attempts, {
    requestId: 'refused', source: 'b', at: '2026-11-03T03:00:00.000Z',
    upstreamStatus: 429, terminalState: 'rejected',
  })
  summary(logs, 'refused', '2026-11-03T03:00:00.500Z', {
    account_id: 'ek-b', final_account_id: 'ek-b', source_account_id: 'account-b',
    source_vm_id: 'slot-b', source_email: 'b@example.test', status: 429, total_cost: null,
  })
  summary(logs, 'priced-zero', '2026-11-03T04:00:00.000Z', {
    account_id: 'ek-b', final_account_id: 'ek-b', source_account_id: 'account-b',
    source_vm_id: 'slot-b', source_email: 'b@example.test', input_tokens: 10, total_cost: 0,
  })
  const stats = logs.accountApiUsage(['account-a', 'account-b'], Date.parse('2026-11-03T12:00:00Z'), 'UTC')
  assert.equal(stats.get('account-a').today_cost, null)
  assert.equal(stats.get('account-a').unpriced_requests, 1)
  assert.equal(stats.get('account-b').today_cost, 0)
  assert.equal(stats.get('account-b').unpriced_requests, 0)
  assert.equal(stats.get('account-b').today_requests, 2)
})

test('today uses the requested reporting timezone and last use includes older attempts', (t) => {
  const { db, logs, attempts } = fixture(t)
  attempt(db, attempts, { requestId: 'before-midnight', at: '2026-11-02T15:59:59.000Z' })
  summary(logs, 'before-midnight', '2026-11-02T15:59:59.500Z', { total_cost: 0.01 })
  attempt(db, attempts, { requestId: 'after-midnight', at: '2026-11-02T16:00:01.000Z' })
  summary(logs, 'after-midnight', '2026-11-02T16:00:01.500Z', { total_cost: 0.02 })
  const now = Date.parse('2026-11-02T17:00:00.000Z')
  const local = logs.accountApiUsage(['account-a'], now, 'Asia/Singapore').get('account-a')
  const utc = logs.accountApiUsage(['account-a'], now, 'UTC').get('account-a')
  assert.equal(local.today_requests, 1)
  assert.equal(local.today_cost, 0.02)
  assert.equal(utc.today_requests, 2)
  assert.equal(utc.today_cost, 0.03)
  assert.equal(local.last_used_at, '2026-11-02T16:00:01.000Z')
})

test('migration backfills only a surviving upstream key association, never a current slot guess', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-account-api-migration-'))
  const migrationsDir = path.join(dir, 'before-sources')
  fs.mkdirSync(migrationsDir)
  const actualMigrations = fileURLToPath(new URL('../../src/lib/db/migrations/', import.meta.url))
  for (const file of fs.readdirSync(actualMigrations)) {
    if (/^\d+.*\.sql$/.test(file) && Number(file.slice(0, 3)) <= 50)
      fs.copyFileSync(path.join(actualMigrations, file), path.join(migrationsDir, file))
  }
  const dbPath = path.join(dir, 'logs.db')
  let db = createDatabase({ dbPath, migrationsDir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.exec(`
    INSERT INTO vms (id, name, vm_json) VALUES ('slot-a', 'Current occupant', '{}');
    INSERT INTO accounts (id, vm_id, email, name)
    VALUES ('slot-a', 'slot-a', 'other-now@example.test', 'Current account');
    INSERT INTO api_endpoints (id, name, base_url, kind, created_at, updated_at)
    VALUES ('ep-a', 'OpenAI API · a@example.test', 'https://api.openai.com', 'openai', '2026-01-01', '2026-01-01');
    INSERT INTO api_endpoint_keys (id, endpoint_id, api_key, source_vm_id, source_account_id, created_at)
    VALUES ('ek-kept', 'ep-a', 'sk-fixture-kept', 'slot-a', 'chatgpt-account-a', '2026-01-01');
    INSERT INTO usage_logs (id, request_id, created_at, account_id, final_account_id, via)
    VALUES ('log-kept', 'kept', '2026-11-03T01:00:00Z', 'ek-kept', 'ek-kept', 'api-kernel'),
           ('log-gone', 'gone', '2026-11-03T02:00:00Z', 'ek-deleted', 'ek-deleted', 'api-kernel');
    INSERT INTO request_attempts (request_id, attempt_no, account_id, started_at)
    VALUES ('kept', 1, 'ek-kept', '2026-11-03T01:00:00Z'), ('gone', 1, 'ek-deleted', '2026-11-03T02:00:00Z');
  `)
  db.close()
  db = createDatabase({ dbPath })
  const logs = new UsageLogsRepo(db)
  const attempts = new RequestAttemptsRepo(db)
  assert.equal(logs.getByRequestId('kept').source_account_id, 'chatgpt-account-a')
  assert.equal(logs.getByRequestId('kept').source_vm_id, 'slot-a')
  assert.equal(logs.getByRequestId('kept').source_email, 'a@example.test')
  assert.equal(attempts.list('kept')[0].source_account_id, 'chatgpt-account-a')
  assert.equal(attempts.list('kept')[0].source_email, 'a@example.test')
  assert.equal(logs.getByRequestId('gone').source_account_id, null)
  assert.equal(attempts.list('gone')[0].source_account_id, null)
  db.exec("DELETE FROM api_endpoint_keys WHERE id = 'ek-kept'; DELETE FROM api_endpoints WHERE id = 'ep-a'")
  const row = new UsageLogsView(db).listBatch({ source_account_id: 'chatgpt-account-a', include_muted: true }).logs[0]
  assert.equal(row.sourceEmail, 'a@example.test')
  assert.equal(row.providerName, 'a@example.test')
  assert.equal(row.providerChain[0].sourceEmail, 'a@example.test')
})
