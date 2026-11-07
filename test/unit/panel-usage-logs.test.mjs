import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

test('usage-log routes and export accept error-only independently of HTTP status', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-usage-logs-'))
  const db = openDatabase({ dbPath: path.join(root, 'logs.db') })
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const repo = new UsageLogsRepo(db)
  for (const [id, error_code] of [
    ['clean', null],
    ['stream-reset', 'ECONNRESET'],
    ['cancelled', 'client_cancelled'],
  ]) {
    repo.insertSummary({
      id,
      request_id: id,
      created_at: '2026-11-07T10:53:38.826Z',
      path: '/v1/responses',
      model: 'gpt-6-astra',
      status: 200,
      error_code,
      error_message: '',
    })
  }

  async function request(url) {
    const response = {}
    const handlePanel = createPanelHandler({
      cfg: { paths: { project: root }, vm: { id: null } },
      requireAuth(req) {
        req.panelRole = 'admin'
        req.panelUser = 'admin'
        return true
      },
      json(_res, status, body) {
        Object.assign(response, { status, body })
        return true
      },
      readBody: async () => ({}),
      proxyPool: { unbindVm() {} },
    })
    const res = {
      writeHead(status, headers) {
        Object.assign(response, { status, headers })
      },
      end(body) {
        response.body = body
      },
    }
    await handlePanel({ method: 'GET', url, headers: {} }, res, new URL(url, 'http://localhost'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response
  }

  for (const suffix of ['errors_only=1', 'errors_only=1&status_code=200', 'error_class=timeout']) {
    const listed = await request(`/api/panel/usage-logs?${suffix}`)
    assert.deepEqual(listed.body.data.logs.map((row) => row.id), ['stream-reset'])
    assert.equal(listed.body.data.logs[0].errorClass, 'timeout')
    const summary = await request(`/api/panel/usage-logs/summary?${suffix}`)
    assert.equal(summary.body.data.totalRequests, 1)
    assert.equal(summary.body.data.errorRequests, 1)
  }
  const non2xx = await request('/api/panel/usage-logs?exclude_status_200=1')
  assert.deepEqual(non2xx.body.data.logs, [])
  const unfiltered = await request('/api/panel/usage-logs?errors_only=0')
  assert.equal(unfiltered.body.data.logs.length, 3)
  const exported = await request('/api/panel/request-logs/export?format=jsonl&errors_only=1')
  const records = exported.body.trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(records.map((row) => row.request_id), ['stream-reset'])
  assert.equal(exported.headers['x-kin-export-total'], '1')
})
