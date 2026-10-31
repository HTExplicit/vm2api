import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { OpenaiApiRepo } from '../../src/lib/db/repos/openai-api-repo.mjs'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { OpenaiApiManager } from '../../src/lib/openai-api/manager.mjs'

async function until(predicate, message = 'manager did not settle') {
  const deadline = Date.now() + 1500
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await sleep(5)
  }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-api-manager-'))
  const db = createDatabase({ dataDir: directory })
  const repo = new OpenaiApiRepo(db)
  const store = new ApiEndpointStore({ db })
  const identities = new Map()
  const calls = { sessions: [], configured: [], models: [], closed: [], refreshed: [], reloaded: 0 }
  const behavior = { authenticated: true, balance: '37.000', balanceError: null, configure: null, inspect: null }
  let time = Date.now()
  const credits = {
    accountForVm(vmId) {
      const entry = identities.get(vmId)
      if (!entry) throw Object.assign(new Error('slot removed'), { code: 'vm_not_found' })
      return { ...entry, record: repo.getAccount(entry.accountId) }
    },
    view(vm) {
      const { accountId, record } = this.accountForVm(vm.id)
      const key = record?.key_id ? repo.getKey(record.key_id) : null
      return { ...record, has_key: !!key && key.source_account_id === accountId, browser_active: false }
    },
    async refreshClaim(vmId) {
      calls.refreshed.push(vmId)
    },
  }
  class Adapter {
    constructor(options) {
      this.options = options
    }
    async inspect() {
      if (behavior.inspect) return behavior.inspect(this.options)
      return {
        authenticated: behavior.authenticated,
        email: this.options.email,
        organizationId: this.options.organizationId,
        organizations: [{ id: 'org-test', name: 'Personal' }],
      }
    }
    async configure(options) {
      calls.configured.push({ ...options, email: this.options.email })
      if (behavior.configure) return behavior.configure(options, this.options)
      const result = {
        organizationId: options.organizationId,
        organizationName: 'Personal',
        projectId: options.projectId || 'proj-test',
        apiKey: 'sk-project-' + this.options.email,
      }
      await options.onKey(result)
      return result
    }
    async readBalance() {
      if (behavior.balanceError) throw behavior.balanceError
      return { balance: behavior.balance }
    }
    dispose() {}
  }
  const manager = new OpenaiApiManager({
    cfg: {},
    repo,
    credits,
    apiEndpointStore: store,
    apiScheduler: {
      reload() {
        calls.reloaded++
      },
    },
    now: () => time,
    Adapter,
    async createSession(options) {
      calls.sessions.push(options)
      const fingerprint = options.fingerprint || { independentDevice: options.proxyUrl }
      await options.onFingerprint(fingerprint)
      let closed = false
      return {
        page: { async goto() {} },
        context: {},
        fingerprint,
        async storageState() {
          return { cookies: [], origins: [{ origin: options.proxyUrl }] }
        },
        async close() {
          if (!closed) calls.closed.push(options.proxyUrl)
          closed = true
        },
      }
    },
    async fetchModels(options) {
      calls.models.push(options)
      return { models: [{ name: 'gpt-test', alias: 'gpt-test' }] }
    },
  })
  const add = (vmId = 'vm-a', accountId = 'account-a', options = {}) => {
    const entry = {
      vm: {
        id: vmId,
        status: 'stopped',
        schedulable: false,
        family: 'codex',
        timezone: 'Asia/Singapore',
        proxy: { url: `socks5h://127.0.0.1:${vmId === 'vm-a' ? 1080 : 1081}` },
      },
      account: { email: `${accountId}@example.test`, chatgpt_plan_type: 'free' },
      accountId,
    }
    identities.set(vmId, entry)
    repo.upsertAccount(accountId, { vm_id: vmId, claim_status: 'claimed', organization_id: 'org-test', ...options })
    return entry
  }
  const installKey = (entry, patch = {}) => {
    let org = repo.getOrg('org-test')
    if (!org?.endpoint_id) {
      const endpoint = store.create({
        kind: 'openai',
        name: 'Account API',
        models: [{ name: 'gpt-test', alias: 'gpt-test' }],
      })
      org = repo.upsertOrg('org-test', { project_id: 'proj-test', endpoint_id: endpoint.id })
    }
    const key = store.addKey(org.endpoint_id, {
      api_key: `sk-existing-${entry.accountId}`,
      source_vm_id: entry.vm.id,
      source_account_id: entry.accountId,
      ...patch,
    })
    repo.upsertAccount(entry.accountId, { key_id: key.id, enabled: true, setup_status: 'ready' })
    return key
  }
  t.after(async () => {
    await manager.stop()
    await until(() => !manager.running)
    db.close()
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    manager,
    repo,
    store,
    identities,
    credits,
    calls,
    behavior,
    add,
    installKey,
    settle: () => until(() => !manager.running && manager.jobs.size === 0),
    setTime: (value) => {
      time = value
    },
  }
}

test('API resolver follows current identity and proxy, independently of OAuth lifecycle and Platform session', (t) => {
  const f = fixture(t)
  const entry = f.add()
  const key = f.installKey(entry)
  f.repo.upsertAccount(entry.accountId, { setup_status: 'needs_login', storage_state: null })
  assert.deepEqual(f.manager.resolveAccountKey(key), {
    accountId: entry.accountId,
    enabled: true,
    proxyUrl: 'socks5h://127.0.0.1:1080',
    email: entry.account.email,
  })
  entry.vm.proxy = { url: 'socks5h://127.0.0.1:2080' }
  assert.equal(f.manager.resolveAccountKey(key).proxyUrl, 'socks5h://127.0.0.1:2080')
  entry.vm.proxy = null
  assert.equal(f.manager.resolveAccountKey(key), null)
  entry.vm.proxy = { url: 'socks5h://127.0.0.1:1080' }
  entry.accountId = 'replacement-account'
  assert.equal(f.manager.resolveAccountKey(key), null)
})

test('two accounts get separate saved fingerprints, sessions and keys while sharing one organization project', async (t) => {
  const f = fixture(t)
  const a = f.add()
  const b = f.add('vm-b', 'account-b')
  f.manager.setup(a.vm.id)
  f.manager.setup(b.vm.id)
  await f.settle()
  const first = f.repo.getAccount(a.accountId)
  const second = f.repo.getAccount(b.accountId)
  assert.notDeepEqual(first.fingerprint, second.fingerprint)
  assert.notDeepEqual(first.storage_state, second.storage_state)
  assert.notEqual(first.key_id, second.key_id)
  assert.equal(f.repo.getKey(first.key_id).source_account_id, a.accountId)
  assert.equal(f.repo.getKey(second.key_id).source_account_id, b.accountId)
  assert.equal(first.enabled, true)
  assert.equal(second.setup_status, 'ready')
  assert.equal(f.calls.configured[1].projectId, 'proj-test')
  assert.equal(f.store.listRaw().length, 1)
  f.manager.setup(a.vm.id)
  await f.settle()
  assert.equal(f.calls.configured.length, 2, 'reopening configuration must reuse the saved key')
  assert.deepEqual(f.calls.sessions[2].fingerprint, first.fingerprint)
  assert.deepEqual(f.calls.sessions[2].storageState, first.storage_state)
  assert.equal(f.calls.closed.length, 3)
})

test('saving a new key precedes balance work and a balance failure neither loses the key nor blocks model setup', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.behavior.balanceError = Object.assign(new Error('Billing temporarily unavailable'), { code: 'balance_unavailable' })
  f.manager.setup(entry.vm.id)
  await f.settle()
  const saved = f.repo.getAccount(entry.accountId)
  assert.ok(saved.key_id)
  assert.equal(saved.enabled, true)
  assert.equal(saved.setup_status, 'ready')
  assert.equal(f.calls.models.length, 1)
  assert.match(f.repo.getOrg('org-test').balance_error, /Billing temporarily unavailable/)
  assert.equal(f.repo.getOrg('org-test').balance, null)
  f.behavior.balanceError = null
  f.manager.setup(entry.vm.id)
  await f.settle()
  assert.equal(f.calls.configured.length, 1)
  assert.equal(f.repo.getAccount(entry.accountId).key_id, saved.key_id)
  assert.equal(f.repo.getOrg('org-test').balance, '37.000')
  assert.equal(f.repo.getOrg('org-test').balance_error, null)
})

test('expired background Platform sessions finish promptly and preserve enabled API keys and the last balance', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const key = f.installKey(entry)
  f.repo.upsertOrg('org-test', { balance: '12.5', balance_checked_at: '2020-01-01T00:00:00Z' })
  f.behavior.authenticated = false
  await f.manager.tick()
  await f.settle()
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'needs_login')
  assert.equal(f.repo.getAccount(entry.accountId).enabled, true)
  assert.equal(f.repo.getKey(key.id).disabled, false)
  assert.equal(f.repo.getOrg('org-test').balance, '12.5')
  assert.ok(f.manager.resolveAccountKey(key))
  assert.equal(f.manager.sessions.size, 0)
})

test('a different logged-in email cannot create a project key or contaminate account session state', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.behavior.inspect = () => ({ authenticated: true, email: 'someone-else@example.test', organizations: [] })
  f.manager.setup(entry.vm.id)
  await f.settle()
  const saved = f.repo.getAccount(entry.accountId)
  assert.equal(saved.setup_status, 'error')
  assert.equal(saved.key_id, '')
  assert.equal(f.calls.configured.length, 0)
  assert.equal(saved.storage_state, null)
})

test('changing an account proxy during key creation rejects the stale task before saving a secret', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.behavior.configure = async (options) => {
    entry.vm.proxy = { url: 'socks5h://127.0.0.1:2080' }
    await options.onKey({ organizationId: 'org-test', projectId: 'proj-test', apiKey: 'sk-wrong-exit' })
  }
  f.manager.setup(entry.vm.id)
  await f.settle()
  assert.equal(f.repo.getAccount(entry.accountId).key_id, '')
  assert.equal(f.store.listRaw().length, 0)
  assert.equal(f.manager.sessions.size, 0)
})

test('background refresh observes ten-minute freshness, skips disabled accounts and deduplicates shared organizations', async (t) => {
  const f = fixture(t)
  const a = f.add()
  const b = f.add('vm-b', 'account-b')
  const c = f.add('vm-c', 'account-c')
  f.installKey(a)
  f.installKey(b)
  f.installKey(c)
  f.repo.upsertAccount(c.accountId, { enabled: false })
  const now = Date.now()
  f.setTime(now)
  f.repo.upsertOrg('org-test', { balance_checked_at: new Date(now - 9 * 60_000).toISOString() })
  await f.manager.tick()
  assert.equal(f.calls.sessions.length, 0)
  f.repo.upsertOrg('org-test', { balance_checked_at: new Date(now - 10 * 60_000 - 1).toISOString() })
  await f.manager.tick()
  await f.settle()
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.repo.getOrg('org-test').balance_checked_at, new Date(now).toISOString())
  assert.equal(f.repo.getAccount(c.accountId).enabled, false)
})

test('a shared organization can refresh through another account when the first account needs login', async (t) => {
  const f = fixture(t)
  const a = f.add()
  const b = f.add('vm-b', 'account-b')
  f.installKey(a)
  f.installKey(b)
  f.repo.upsertAccount(a.accountId, { setup_status: 'needs_login' })
  f.repo.upsertOrg('org-test', { balance_checked_at: '2020-01-01T00:00:00Z' })
  await f.manager.tick()
  await f.settle()
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.calls.sessions[0].proxyUrl, 'socks5h://127.0.0.1:1081')
  assert.equal(f.repo.getOrg('org-test').balance, '37.000')
})

test('opening another login while one is active reports busy without queuing a hidden setup', async (t) => {
  const f = fixture(t)
  const a = f.add()
  const b = f.add('vm-b', 'account-b')
  f.behavior.authenticated = false
  f.manager.setup(a.vm.id)
  await until(() => f.manager.sessions.get(a.vm.id)?.waiting)
  const ticket = await f.manager.browserTicket(a.vm.id)
  assert.match(ticket.url, new RegExp(`ticket=${ticket.ticket}$`))
  await assert.rejects(f.manager.browserTicket(b.vm.id), { code: 'platform_browser_busy' })
  assert.equal(f.manager.jobs.has(b.vm.id), false)
  assert.equal(f.repo.getAccount(b.accountId).setup_status, 'idle')
  await f.manager.stop()
  await f.settle()
  assert.equal(f.manager.jobs.size, 0)
  assert.equal(f.manager.sessions.size, 0)
  assert.equal(f.manager.tickets.size, 0)
})

test('deleted slots cannot interrupt queue cleanup or leak a newly opened browser', async (t) => {
  const f = fixture(t)
  const a = f.add()
  const b = f.add('vm-b', 'account-b')
  f.behavior.configure = async (options, adapterOptions) => {
    if (adapterOptions.email === a.account.email) {
      f.identities.delete(a.vm.id)
      throw Object.assign(new Error('slot removed'), { code: 'vm_not_found' })
    }
    const result = { organizationId: 'org-test', projectId: 'proj-test', apiKey: 'sk-b-remains-available' }
    await options.onKey(result)
    return result
  }
  f.manager.setup(a.vm.id)
  f.manager.setup(b.vm.id)
  await f.settle()
  assert.equal(f.manager.sessions.size, 0)
  assert.equal(f.calls.closed.length, 2)
  assert.equal(f.repo.getAccount(b.accountId).setup_status, 'ready')
  assert.equal(f.repo.getAccount(a.accountId).key_id, '')
})

test('stopping while a browser is launching closes it before any Platform operation can run', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const originalCreate = f.manager.createSession
  let release
  let launching = false
  const gate = new Promise((resolve) => {
    release = resolve
  })
  f.manager.createSession = async (options) => {
    launching = true
    await gate
    return originalCreate(options)
  }
  f.manager.setup(entry.vm.id)
  await until(() => launching)
  const stopping = f.manager.stop()
  release()
  await stopping
  await f.settle()
  assert.equal(f.calls.configured.length, 0)
  assert.equal(f.calls.models.length, 0)
  assert.equal(f.calls.closed.length, 1)
  assert.equal(f.manager.sessions.size, 0)
})

test('browser tickets cannot attach to a slot after its account identity changes', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.behavior.authenticated = false
  f.manager.setup(entry.vm.id)
  await until(() => f.manager.sessions.get(entry.vm.id)?.waiting)
  const ticket = await f.manager.browserTicket(entry.vm.id)
  entry.accountId = 'replacement-account'
  let upgraded = false
  let destroyed = false
  let response = ''
  f.manager.wss.handleUpgrade = () => {
    upgraded = true
  }
  const socket = {
    write(value) {
      response += value
    },
    destroy() {
      destroyed = true
    },
  }
  assert.equal(f.manager.handleUpgrade({ url: ticket.url }, socket, Buffer.alloc(0)), true)
  assert.equal(upgraded, false)
  assert.equal(destroyed, true)
  assert.match(response, /401 Unauthorized/)
  assert.equal(f.manager.tickets.has(ticket.ticket), false)
})
