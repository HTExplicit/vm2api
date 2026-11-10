import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareSlotOAuth, runGuestOAuthAuthService } from '../../src/lib/oauth/guest-oauth-helper.mjs'

test('guest OAuth helper delegates egress selection to the slot network', async () => {
  const inputs = []
  const proxies = [
    { id: 'px-loopback', host: '127.0.0.1', port: 20881 },
    { id: 'px-remote', host: '192.0.2.10', port: 1080 },
  ]

  for (const proxy of proxies) {
    const exec = {
      projectRoot: '/srv/vm2api',
      vmId: 'vm-01',
      vm: { id: 'vm-01', runtime: { type: 'docker' }, proxy },
    }
    const credential = await runGuestOAuthAuthService(
      {
        operation: 'exchange_code',
        code: 'fixture-code',
        code_verifier: 'fixture-verifier',
        proxy_url: 'socks5h://127.0.0.1:1',
      },
      {
        exec,
        preservePowerIntent: true,
        prepare: async (options) => {
          assert.equal(options.preservePowerIntent, true)
          return {
            exec,
            host: {
              bins: { oauthAuth: '/usr/local/bin/kin-oauth-auth' },
              dockerEnv: () => ({}),
              execUser: () => 'kincli',
            },
            configDir: '/home/kincli/.claude',
            home: '/home/kincli',
          }
        },
        postTelemetry: async () => ({ ok: true }),
        runDocker: async (_argv, { stdin }) => {
          inputs.push(JSON.parse(stdin))
          return {
            code: 0,
            stdout: JSON.stringify({ ok: true, credential: { access_token: 'fixture-access' } }),
          }
        },
      },
    )
    assert.equal(credential.access_token, 'fixture-access')
  }

  assert.equal(inputs.length, proxies.length)
  for (const input of inputs) {
    assert.equal(input.proxy_url, '')
    assert.equal(input.code, 'fixture-code')
  }
})

test('guest OAuth preparation records actual runtime while preserving stopped intent and scheduling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-prepare-power-'))
  const vmId = 'vm-01'
  const file = path.join(root, 'vms', `${vmId}.json`)
  const run = path.join(root, 'vms', vmId, 'run')
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      id: vmId,
      status: 'stopped',
      schedule_off: true,
      schedule_hold: { reason: 'maintenance', detail: { tag: 'oauth-browser:fixture' } },
      runtime: { type: 'docker', stopped: true },
      proxy: { id: 'px-local' },
    }),
  )
  fs.writeFileSync(
    path.join(run, 'kernel.json'),
    JSON.stringify({ credential_path: '/home/kincli/.claude/credentials.json' }),
  )
  try {
    await prepareSlotOAuth({
      exec: { vmId, projectRoot: root },
      preservePowerIntent: true,
      startReady: async () => ({
        ok: true,
        runtime: { type: 'docker', stopped: false },
        rust: { ok: true, health: { vm_telemetry: true, telemetry_ready: true } },
      }),
    })
    const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(vm.status, 'stopped')
    assert.equal(vm.runtime.stopped, false)
    assert.equal(vm.schedule_off, true)
    assert.equal(vm.schedule_hold.detail.tag, 'oauth-browser:fixture')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
