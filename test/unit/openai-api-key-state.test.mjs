import test from 'node:test'
import assert from 'node:assert/strict'
import { accountApiKeyState, QUOTA_BLOCK } from '../../src/lib/openai-api/key-state.mjs'

const NOW = Date.parse('2026-11-03T12:00:00Z')

function fixture() {
  return {
    vm: {
      id: 'vm-a',
      status: 'stopped',
      schedulable: false,
      proxy: { url: 'socks5h://127.0.0.1:1080' },
    },
    accountId: 'account-a',
    record: { key_id: 'ek-a', enabled: true, setup_status: 'needs_login' },
    key: {
      id: 'ek-a',
      endpoint_id: 'ep-a',
      source_vm_id: 'vm-a',
      source_account_id: 'account-a',
      disabled: false,
      cooldown_until: null,
    },
    endpoint: { id: 'ep-a', disabled: false, disable_cooling: false },
    now: NOW,
  }
}

function expectStatus(input, expected) {
  const result = accountApiKeyState(input)
  assert.equal(result.status, expected)
  if (expected === 'ready') assert.equal(result.reason, null)
  else assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
  return result
}

test('account API effective state ignores balance, OAuth lifecycle, and Platform login state', () => {
  for (const balance of [null, '0', '-1.239', '37.000']) {
    const f = fixture()
    f.record.balance = balance
    f.record.last_error = 'Billing login required'
    expectStatus(f, 'ready')
  }
})

test('missing or mismatched account key associations never appear callable', () => {
  const cases = [
    (f) => {
      f.key = null
    },
    (f) => {
      f.endpoint = null
    },
    (f) => {
      f.record.key_id = 'ek-other'
    },
    (f) => {
      f.key.source_vm_id = 'vm-b'
    },
    (f) => {
      f.key.source_account_id = 'account-b'
    },
  ]
  for (const change of cases) {
    const f = fixture()
    change(f)
    expectStatus(f, 'binding_error')
    f.record.enabled = false
    expectStatus(f, 'binding_error')
  }
})

test('administrator account switch and endpoint stop intent take precedence over key blocks', () => {
  const f = fixture()
  f.record.enabled = false
  f.endpoint.disabled = true
  f.key.disabled = true
  f.key.cooldown_until = QUOTA_BLOCK
  expectStatus(f, 'disabled')
  f.record.enabled = true
  expectStatus(f, 'upstream_disabled')
  f.endpoint.disabled = false
  expectStatus(f, 'invalid_key')
  f.key.disabled = false
  expectStatus(f, 'quota_blocked')
})

test('temporary cooling expires by time and can be skipped without skipping quota block', () => {
  const f = fixture()
  f.key.cooldown_until = new Date(NOW + 60_000).toISOString()
  expectStatus(f, 'rate_limited')
  f.now = NOW + 60_000
  expectStatus(f, 'ready')
  f.now = NOW
  f.endpoint.disable_cooling = true
  expectStatus(f, 'ready')
  f.key.cooldown_until = QUOTA_BLOCK
  expectStatus(f, 'quota_blocked')
})

test('bound proxy is required even when all key and switch state is ready', () => {
  const f = fixture()
  f.vm.proxy = null
  expectStatus(f, 'proxy_missing')
  f.vm.proxy = {}
  expectStatus(f, 'proxy_missing')
  f.vm.proxy = { host: '127.0.0.1', port: 1080, scheme: 'socks5h' }
  expectStatus(f, 'ready')
})
