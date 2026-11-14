import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reset-routes-'))
const previousData = process.env.KIN_DATA_DIR
process.env.KIN_DATA_DIR = data
test.after(() => {
  if (previousData == null) delete process.env.KIN_DATA_DIR
  else process.env.KIN_DATA_DIR = previousData
  fs.rmSync(data, { recursive: true, force: true })
})
const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')

async function redeem({ body = {}, readError = false, role = 'admin', headers = {} } = {}) {
  let response
  let reads = 0
  const handler = createPanelHandler({
    cfg: { paths: { project: data } },
    routingConfig: {},
    requireAuth(req) {
      Object.assign(req, { panelUser: 'offline-user', panelRole: role, panelUserId: 'offline-owner' })
      return true
    },
    json(_res, status, payload) {
      response = { status, body: payload }
      return true
    },
    readBody: async () => {
      reads++
      if (readError) throw new SyntaxError('invalid JSON body')
      return body
    },
  })
  await handler(
    { method: 'POST', headers },
    {},
    new URL('http://localhost/api/panel/vms/offline-slot/claude-reset/redeem'),
  )
  return { ...response, reads }
}

test('empty reset bodies remain compatible and still require the idempotency key', async () => {
  for (const body of [null, {}]) {
    const result = await redeem({ body })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED')
    assert.equal(result.reads, 1)
  }
})

test('a malformed reset body is rejected before any default-card operation', async () => {
  const result = await redeem({ readError: true, headers: { 'idempotency-key': 'offline-confirmation' } })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'invalid_request')
  assert.equal(result.reads, 1)
})

test('the reset route passes the selected card to card validation', async () => {
  const result = await redeem({
    body: { card: 'invalid-card' },
    headers: { 'idempotency-key': 'offline-confirmation' },
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'CLAUDE_RESET_CARD_INVALID')
})

test('reset ownership and role checks precede reading the confirmation body', async () => {
  const foreign = await redeem({ role: 'user', readError: true })
  assert.equal(foreign.status, 404)
  assert.equal(foreign.reads, 0)
  const supervisor = await redeem({ role: 'super', readError: true })
  assert.equal(supervisor.status, 403)
  assert.equal(supervisor.reads, 0)
  fs.mkdirSync(path.join(data, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(data, 'vms/offline-slot.json'),
    JSON.stringify({ id: 'offline-slot', family: 'claude', owner_user_id: 'offline-owner' }),
  )
  const own = await redeem({ role: 'user', readError: true })
  assert.equal(own.status, 400)
  assert.equal(own.body.error.code, 'invalid_request')
  assert.equal(own.reads, 1)
})
