import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  balanceRefreshIntervalMinutes,
  normalizeOpenaiApiConfig,
  validateOpenaiApiPatch,
} from '../../src/lib/openai-api/config.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'

test('account API refresh defaults to ten minutes and accepts manual-only and whole-day intervals', () => {
  assert.equal(balanceRefreshIntervalMinutes(), 10)
  assert.deepEqual(normalizeOpenaiApiConfig(), { balance_refresh_interval_minutes: 10 })
  for (const minutes of [0, 1, 30, 1440]) {
    const openai_api = { balance_refresh_interval_minutes: minutes }
    validateOpenaiApiPatch(openai_api)
    assert.equal(balanceRefreshIntervalMinutes({ openai_api }), minutes)
  }
})

test('interval writes reject invalid types, fractions and values outside the supported range', () => {
  for (const value of [-1, 1441, 0.5, '10', null, true]) {
    assert.throws(() => validateOpenaiApiPatch({ balance_refresh_interval_minutes: value }), {
      code: 'invalid_openai_api_config',
      status: 400,
    })
  }
  for (const value of [null, [], '10']) {
    assert.throws(() => validateOpenaiApiPatch(value), { code: 'invalid_openai_api_config' })
  }
  validateOpenaiApiPatch(undefined)
  validateOpenaiApiPatch({})
})

test('loading existing routing adds a default API interval without coupling to disabled OAuth routing', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-interval-load-'))
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const file = path.join(directory, 'routing.json')
  fs.writeFileSync(file, JSON.stringify({ codex: { enabled: false, quota: {} } }))
  const routing = createRoutingRuntime({ routingConfigPath: file }).loadRoutingConfig()
  assert.equal(routing.codex.enabled, false)
  assert.equal(balanceRefreshIntervalMinutes(routing), 10)
  assert.deepEqual(routing.openai_api, { balance_refresh_interval_minutes: 10 })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).openai_api, undefined)
})

test('saving a changed API interval is hot, persists manual-only zero and preserves unrelated configuration', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-interval-save-'))
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const file = path.join(directory, 'routing.json')
  const routing = {
    codex: { enabled: false, quota: {} },
    concurrency: {},
    tiers: {},
    openai_api: { balance_refresh_interval_minutes: 10 },
  }
  fs.writeFileSync(file, JSON.stringify(routing))
  const runtime = createRoutingRuntime({
    cfg: { paths: { project: directory } },
    routingConfigPath: file,
    routingConfig: routing,
    stickyRouter: { reloadConfig() {} },
    accountQuota: { reloadConfig() {}, applyTierConcurrency() {}, applyTierRpm() {}, repo: { get: () => null } },
    requestLog: { setConfig() {} },
  })
  await runtime.persistRoutingPatch({ openai_api: { balance_refresh_interval_minutes: 30 } })
  assert.equal(balanceRefreshIntervalMinutes(routing), 30)
  const result = await runtime.persistRoutingPatch({ openai_api: { balance_refresh_interval_minutes: 0 } })
  assert.equal(balanceRefreshIntervalMinutes(routing), 0)
  assert.equal(result.kernel_persona, null)
  assert.equal(result.kernel_reload, 0)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.openai_api, { balance_refresh_interval_minutes: 0 })
  assert.equal(saved.codex.enabled, false)
  assert.equal(runtime.loadRoutingConfig().openai_api.balance_refresh_interval_minutes, 0)
  await assert.rejects(runtime.persistRoutingPatch({ openai_api: { balance_refresh_interval_minutes: -1 } }), {
    code: 'invalid_openai_api_config',
  })
  assert.equal(balanceRefreshIntervalMinutes(routing), 0)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).openai_api.balance_refresh_interval_minutes, 0)
})
