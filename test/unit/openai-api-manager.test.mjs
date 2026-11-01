import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { EventEmitter } from 'node:events'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { SlotBrowserRepo } from '../../src/lib/db/repos/slot-browser-repo.mjs'
import { OpenaiApiRepo } from '../../src/lib/db/repos/openai-api-repo.mjs'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { OpenaiApiManager } from '../../src/lib/openai-api/manager.mjs'
import { PlatformAdapter } from '../../src/lib/openai-api/platform-adapter.mjs'

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
  const profiles = new SlotBrowserRepo(db)
  const store = new ApiEndpointStore({ db })
  const identities = new Map()
  const calls = {
    sessions: [],
    inspections: [],
    configured: [],
    models: [],
    closed: [],
    refreshed: [],
    http: [],
    reloaded: 0,
    liveBrowsers: 0,
    maxLiveBrowsers: 0,
  }
  const behavior = {
    authenticated: true,
    balance: '37.000',
    balanceError: null,
    readBalance: null,
    configure: null,
    inspect: null,
    http: null,
  }
  let time = Date.now()
  const routing = { openai_api: { balance_refresh_interval_minutes: 10 } }
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
    async inspect(options) {
      calls.inspections.push(options)
      if (behavior.inspect) return behavior.inspect(this.options, options)
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
      if (behavior.readBalance) return behavior.readBalance()
      if (behavior.balanceError) throw behavior.balanceError
      return { balance: behavior.balance }
    }
    billingSessionFor(organizationId) {
      return {
        organization_id: organizationId,
        headers: { authorization: 'Bearer fixture-billing', 'user-agent': 'fixture-browser' },
        recovery_attempted: false,
      }
    }
    dispose() {}
  }
  let manager = new OpenaiApiManager({
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
    getRouting: () => routing,
    Adapter,
    async fetchBalance(options) {
      calls.http.push(options)
      if (behavior.http) return behavior.http(options)
      return { summary: { balance: behavior.balance }, cookies: [{ name: 'session', value: 'updated' }] }
    },
    async createSession(options) {
      calls.sessions.push(options)
      const fingerprint = options.fingerprint || { independentDevice: options.proxyUrl }
      await options.onFingerprint(fingerprint)
      calls.liveBrowsers++
      calls.maxLiveBrowsers = Math.max(calls.maxLiveBrowsers, calls.liveBrowsers)
      let closed = false
      return {
        page: { async goto() {} },
        context: {},
        fingerprint,
        async storageState() {
          return { cookies: [], origins: [{ origin: options.proxyUrl }] }
        },
        async close() {
          if (!closed) {
            calls.closed.push(options.proxyUrl)
            calls.liveBrowsers--
          }
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
        codex: { chatgpt_account_id: accountId },
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
  const cacheBilling = (entry, patch = {}) => {
    profiles.upsert(entry.vm.id, {
      account_id: entry.accountId,
      fingerprint: { independentDevice: entry.vm.id },
      billing_session: {
        organization_id: repo.getAccount(entry.accountId).organization_id,
        headers: { authorization: 'Bearer saved-session', 'user-agent': 'saved-browser' },
        recovery_attempted: false,
      },
      storage_state: {
        cookies: [{ name: 'session', value: 'old' }],
        origins: [
          {
            origin: 'https://platform.openai.com',
            localStorage: [{ name: 'saved', value: 'web' }],
            indexedDB: [{ name: 'db' }],
          },
        ],
        sessionStorage: { 'https://platform.openai.com': { transient: 'preserve' } },
      },
      ...patch,
    })
    return profiles.get(entry.vm.id)
  }
  t.after(async () => {
    await manager.stop()
    await until(() => !manager.running)
    db.close()
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    get manager() {
      return manager
    },
    repo,
    profiles,
    store,
    identities,
    credits,
    calls,
    behavior,
    routing,
    add,
    installKey,
    cacheBilling,
    async restart() {
      await manager.stop()
      const previous = manager
      manager = new OpenaiApiManager({
        cfg: {},
        repo,
        credits,
        apiEndpointStore: store,
        apiScheduler: previous.apiScheduler,
        Adapter,
        now: () => time,
        getRouting: () => routing,
        fetchBalance: previous.fetchBalance,
        fetchModels: previous.fetchModels,
        createSession: previous.createSession,
      })
      return manager
    },
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
  f.manager.enqueue(f.credits.accountForVm(a.vm.id), 'setup', false)
  f.manager.enqueue(f.credits.accountForVm(b.vm.id), 'setup', false)
  await f.settle()
  const first = f.repo.getAccount(a.accountId)
  const second = f.repo.getAccount(b.accountId)
  const firstProfile = f.profiles.get(a.vm.id)
  const secondProfile = f.profiles.get(b.vm.id)
  assert.notDeepEqual(firstProfile.fingerprint, secondProfile.fingerprint)
  assert.notDeepEqual(firstProfile.storage_state, secondProfile.storage_state)
  assert.notEqual(first.key_id, second.key_id)
  assert.equal(f.repo.getKey(first.key_id).source_account_id, a.accountId)
  assert.equal(f.repo.getKey(second.key_id).source_account_id, b.accountId)
  assert.equal(first.enabled, true)
  assert.equal(second.setup_status, 'ready')
  assert.equal(f.calls.configured[1].projectId, undefined)
  assert.equal(f.repo.getOrg('org-test').project_id, 'proj-test')
  assert.equal(f.store.listRaw().length, 2, 'account endpoints keep model catalogs and display names separate')
  f.manager.enqueue(f.credits.accountForVm(a.vm.id), 'setup', false)
  await f.settle()
  assert.equal(f.calls.configured.length, 2, 'reopening configuration must reuse the saved key')
  assert.deepEqual(f.calls.sessions[2].fingerprint, firstProfile.fingerprint)
  assert.deepEqual(f.calls.sessions[2].storageState, firstProfile.storage_state)
  assert.equal(f.calls.closed.length, 3)
})

test('new account keys resolve the default project instead of inheriting a legacy organization project', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.repo.upsertOrg('org-test', { project_id: 'proj-legacy-vm2api' })
  f.behavior.configure = async (options, adapterOptions) => {
    assert.equal(Object.hasOwn(options, 'projectId'), false)
    assert.equal(Object.hasOwn(adapterOptions, 'projectId'), false)
    const created = { organizationId: 'org-test', projectId: 'proj-default', apiKey: 'sk-default-project-fixture' }
    await options.onKey(created)
    return created
  }
  f.manager.enqueue(f.credits.accountForVm(entry.vm.id), 'setup', false)
  await f.settle()
  assert.equal(f.repo.getOrg('org-test').project_id, 'proj-default')
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
  assert.ok(f.repo.getAccount(entry.accountId).key_id)
})

test('existing account keys are reused without reconfiguring or moving their project', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const key = f.installKey(entry)
  f.repo.upsertOrg('org-test', { project_id: 'proj-legacy-vm2api' })
  f.behavior.configure = async () => {
    throw new Error('an existing key must not be recreated')
  }
  f.manager.enqueue(f.credits.accountForVm(entry.vm.id), 'setup', false)
  await f.settle()
  assert.equal(f.calls.configured.length, 0)
  assert.equal(f.repo.getAccount(entry.accountId).key_id, key.id)
  assert.equal(f.repo.getKey(key.id).api_key, key.api_key)
  assert.equal(f.repo.getOrg('org-test').project_id, 'proj-legacy-vm2api')
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
})

test('an error can retry immediately in the retained browser after the old job is removed', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  let attempts = 0
  let retried = false
  const states = []
  const setStatus = f.manager.browserManager.setStatus.bind(f.manager.browserManager)
  f.manager.browserManager.setStatus = (live, status, ...rest) => {
    states.push(status)
    setStatus(live, status, ...rest)
    if (status === 'error' && !retried) {
      assert.equal(f.manager.jobs.has(entry.vm.id), false, 'the retry must not find the finished setup job')
      assert.equal(live.inputLocked, false)
      assert.equal(live.checkLogin, null)
      retried = true
      f.manager.setup(entry.vm.id)
    }
  }
  f.behavior.configure = async (options) => {
    if (++attempts === 1)
      throw Object.assign(new Error('等待官方创建 API key 入口超时，可在当前窗口重试配置'), {
        code: 'platform_page_changed',
      })
    const result = { organizationId: 'org-test', projectId: 'proj-test', apiKey: 'sk-retry-fixture' }
    await options.onKey(result)
    return result
  }
  f.manager.setup(entry.vm.id)
  await f.settle()
  assert.equal(retried, true)
  assert.equal(attempts, 2)
  const accountPrefix = 'vm2api-' + crypto.createHash('sha256').update(entry.accountId).digest('hex').slice(0, 12)
  for (const configured of f.calls.configured)
    assert.match(configured.keyName, new RegExp(`^${accountPrefix}-[a-f0-9]{8}$`))
  assert.notEqual(f.calls.configured[0].keyName, f.calls.configured[1].keyName, 'a new job gets its own creation name')
  assert.equal(f.calls.sessions.length, 1, 'the same browser must survive the failed attempt')
  assert.equal(f.calls.closed.length, 0)
  assert.equal(f.calls.maxLiveBrowsers, 1)
  assert.equal(states.filter((status) => status === 'configuring').length, 2)
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
  assert.equal(f.repo.getAccount(entry.accountId).last_error, null)
  assert.deepEqual(f.profiles.get(entry.vm.id).fingerprint, { independentDevice: f.calls.sessions[0].proxyUrl })
})

test('same-window retry with an already saved key never creates or replaces it', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const key = f.installKey(entry)
  let inspected = 0
  f.behavior.inspect = () => {
    if (++inspected === 1) throw new Error('temporary page failure')
    return { authenticated: true, email: entry.account.email, organizationId: 'org-test', organizations: [] }
  }
  f.manager.setup(entry.vm.id)
  await f.settle()
  const browser = f.manager.browserManager.jobs.get(entry.vm.id)
  const fingerprint = f.profiles.get(entry.vm.id).fingerprint
  assert.equal(f.manager.browserManager.state(entry.vm.id).status, 'error')
  f.manager.setup(entry.vm.id)
  await f.settle()
  assert.equal(f.manager.browserManager.jobs.get(entry.vm.id), browser)
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.calls.configured.length, 0)
  assert.equal(f.repo.getAccount(entry.accountId).key_id, key.id)
  assert.equal(f.repo.getKey(key.id).api_key, key.api_key)
  assert.deepEqual(f.profiles.get(entry.vm.id).fingerprint, fingerprint)
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
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

test('background refresh waits for identity before treating a restored session as expired', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.installKey(entry)
  f.repo.upsertOrg('org-test', { balance_checked_at: '2020-01-01T00:00:00Z' })
  await f.manager.tick()
  await f.settle()
  assert.equal(f.calls.inspections[0].timeout, 30_000)
  assert.ok(f.calls.inspections[0].signal instanceof AbortSignal)
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
})

test('an expired session is not reopened each period and manual refresh can restore it', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const key = f.installKey(entry)
  f.repo.upsertOrg('org-test', { balance: '12.5', balance_checked_at: '2020-01-01T00:00:00Z' })
  const attemptedAt = Date.now()
  f.setTime(attemptedAt)
  f.behavior.authenticated = false
  await f.manager.tick()
  await f.settle()
  const failed = f.repo.getAccount(entry.accountId)
  assert.equal(failed.setup_status, 'needs_login')
  f.setTime(attemptedAt + 9 * 60_000)
  await f.manager.tick()
  assert.equal(f.calls.sessions.length, 1)
  f.behavior.authenticated = true
  f.behavior.balance = '12.499999999999999999'
  f.setTime(attemptedAt + 10 * 60_000)
  await f.manager.tick()
  await f.settle()
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'needs_login')
  await f.manager.refresh(entry.vm.id)
  await f.settle()
  assert.equal(f.calls.sessions.length, 2)
  assert.equal(f.repo.getOrg('org-test').balance, '12.499999999999999999')
  assert.equal(f.repo.getOrg('org-test').balance_error, null)
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
  assert.equal(f.repo.getAccount(entry.accountId).key_id, key.id)
  assert.equal(f.calls.configured.length, 0)
})

test('missing identity remains a retryable observation error and Billing authentication failures request login', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const key = f.installKey(entry)
  const attemptedAt = Date.now()
  f.setTime(attemptedAt)
  f.repo.upsertOrg('org-test', { balance: '12.5', balance_checked_at: '2020-01-01T00:00:00Z' })
  f.behavior.inspect = () => {
    throw Object.assign(new Error('官方账号信息尚未返回'), { code: 'platform_identity_unavailable' })
  }
  await f.manager.tick()
  await f.settle()
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'error')
  f.setTime(attemptedAt + 10 * 60_000)
  await f.manager.tick()
  await f.settle()
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'error')
  assert.match(f.repo.getAccount(entry.accountId).last_error, /官方账号信息尚未返回/)
  assert.equal(f.calls.sessions.length, 1)
  f.behavior.inspect = null
  f.behavior.balanceError = Object.assign(new Error('Platform 会话已失效，请补充登录'), {
    code: 'platform_login_required',
  })
  await f.manager.refresh(entry.vm.id)
  await f.settle()
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'needs_login')
  assert.equal(f.repo.getAccount(entry.accountId).enabled, true)
  assert.equal(f.repo.getKey(key.id).disabled, false)
  assert.equal(f.repo.getOrg('org-test').balance, '12.5')
})

test('claim observations cannot postpone a failed balance retry and old needs-login records retry after restart', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.installKey(entry)
  f.cacheBilling(entry)
  f.repo.upsertOrg('org-test', { balance_checked_at: '2020-01-01T00:00:00Z' })
  f.repo.upsertAccount(entry.accountId, {
    setup_status: 'needs_login',
    claim_status: 'pending',
    operation_id: 'op-test',
  })
  f.credits.refreshClaim = async () => {
    f.repo.upsertAccount(entry.accountId, { link_checked_at: new Date().toISOString() })
  }
  const attemptedAt = Date.now()
  f.setTime(attemptedAt)
  f.behavior.http = () => {
    throw Object.assign(new Error('network unavailable'), { code: 'billing_network_error' })
  }
  await f.manager.tick()
  await f.settle()
  assert.equal(f.calls.http.length, 1, 'a persisted login error is rechecked by the new manager')
  f.setTime(attemptedAt + 9 * 60_000)
  await f.manager.tick()
  assert.equal(f.calls.http.length, 1)
  f.setTime(attemptedAt + 10 * 60_000)
  f.behavior.http = null
  await f.manager.tick()
  await f.settle()
  assert.equal(f.calls.http.length, 2)
  assert.equal(f.calls.sessions.length, 0)
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
})

test('manual configuration cancels the old identity wait while retaining the same browser', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const key = f.installKey(entry)
  let inspecting = false
  let first = true
  f.behavior.inspect = (_options, { signal }) => {
    if (!first)
      return { authenticated: true, email: entry.account.email, organizationId: 'org-test', organizations: [] }
    first = false
    inspecting = true
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  f.manager.enqueue(f.credits.accountForVm(entry.vm.id), 'balance', false)
  await until(() => inspecting)
  f.manager.setup(entry.vm.id)
  await until(() => f.repo.getAccount(entry.accountId).setup_status === 'ready')
  await f.settle()
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.calls.closed.length, 0)
  assert.equal(f.repo.getAccount(entry.accountId).key_id, key.id)
  assert.equal(f.calls.configured.length, 0)
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
  await f.manager.browserManager.close(entry.vm.id)
  assert.equal(f.profiles.get(entry.vm.id).storage_state, null)
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

test('another requested login is visibly queued while one is active and both are removed on shutdown', async (t) => {
  const f = fixture(t)
  const a = f.add()
  const b = f.add('vm-b', 'account-b')
  f.behavior.authenticated = false
  f.manager.setup(a.vm.id)
  await until(() => f.manager.sessions.get(a.vm.id)?.waiting)
  const ticket = await f.manager.browserTicket(a.vm.id)
  assert.match(ticket.url, new RegExp(`ticket=${ticket.ticket}$`))
  const queuedTicket = await f.manager.browserTicket(b.vm.id)
  assert.match(queuedTicket.url, /ticket=/)
  assert.equal(f.manager.jobs.has(b.vm.id), true)
  assert.equal(f.manager.browserManager.state(b.vm.id).status, 'queued')
  assert.equal(f.repo.getAccount(b.accountId).setup_status, 'configuring')
  await f.manager.stop()
  await f.settle()
  assert.equal(f.manager.jobs.size, 0)
  assert.equal(f.manager.sessions.size, 0)
  assert.equal(f.manager.browserManager.tickets.size, 0)
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
  f.manager.enqueue(f.credits.accountForVm(a.vm.id), 'setup', false)
  f.manager.enqueue(f.credits.accountForVm(b.vm.id), 'setup', false)
  await f.settle()
  assert.equal(f.manager.sessions.size, 0)
  assert.equal(f.calls.closed.length, 2)
  assert.equal(f.repo.getAccount(b.accountId).setup_status, 'ready')
  assert.equal(f.repo.getAccount(a.accountId).key_id, '')
})

test('stopping while a browser is launching closes it before any Platform operation can run', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const originalCreate = f.manager.browserManager.createSession
  let release
  let launching = false
  const gate = new Promise((resolve) => {
    release = resolve
  })
  f.manager.browserManager.createSession = async (options) => {
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
  entry.vm.codex.chatgpt_account_id = 'replacement-account'
  let upgraded = false
  let destroyed = false
  let response = ''
  f.manager.browserManager.wss.handleUpgrade = () => {
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
  assert.equal(f.manager.browserManager.tickets.has(ticket.ticket), false)
})

test('a late key creation response after cancellation cannot save an account key or endpoint', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  let release
  let awaitingKey = false
  const gate = new Promise((resolve) => {
    release = resolve
  })
  f.behavior.configure = async (options) => {
    awaitingKey = true
    await gate
    await options.onKey({ organizationId: 'org-test', projectId: 'proj-test', apiKey: 'sk-late-after-cancel' })
  }
  f.manager.setup(entry.vm.id)
  await until(() => awaitingKey)
  const cancelling = f.manager.cancel(entry.vm.id)
  assert.equal(f.manager.jobs.get(entry.vm.id).abort.signal.aborted, true)
  release()
  await cancelling
  await f.settle()
  assert.equal(f.repo.getAccount(entry.accountId).key_id, '')
  assert.equal(f.store.listRaw().length, 0)
  assert.equal(f.calls.models.length, 0)
  assert.notEqual(f.repo.getAccount(entry.accountId).setup_status, 'ready')
  assert.equal(f.manager.browserManager.state(entry.vm.id).active, false)
})

test('a deferred Billing result after cancellation cannot replace the old balance, fetch models or write ready', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.installKey(entry)
  f.repo.upsertOrg('org-test', { balance: '12.5000', balance_checked_at: '2020-01-01T00:00:00Z' })
  let release
  let reading = false
  f.behavior.readBalance = async () => {
    reading = true
    return new Promise((resolve) => {
      release = resolve
    })
  }
  f.manager.setup(entry.vm.id)
  await until(() => reading)
  const cancelling = f.manager.cancel(entry.vm.id)
  release({ balance: '999.000', paid_balance: '999.000' })
  await cancelling
  await f.settle()
  assert.equal(f.repo.getOrg('org-test').balance, '12.5000')
  assert.equal(f.repo.getOrg('org-test').balance_checked_at, '2020-01-01T00:00:00Z')
  assert.equal(f.calls.models.length, 0)
  assert.notEqual(f.repo.getAccount(entry.accountId).setup_status, 'ready')
})

test('cancelling a background balance task waiting on a retained same-slot browser does not reopen it', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.installKey(entry)
  const manual = await f.manager.browserManager.acquire(entry.vm.id, { purpose: 'oauth', interactive: true })
  f.manager.enqueue(f.credits.accountForVm(entry.vm.id), 'balance', false)
  await until(() => f.manager.running)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.calls.configured.length, 0)
  await f.manager.cancel(entry.vm.id)
  await f.settle()
  await manual.closed
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.calls.models.length, 0)
  assert.equal(f.manager.browserManager.state(entry.vm.id).active, false)
})

test('a background refresh waiting on manual A cannot block interactive B after A closes', async (t) => {
  const f = fixture(t)
  const a = f.add()
  const b = f.add('vm-b', 'account-b')
  f.installKey(a)
  f.repo.upsertOrg('org-test', { balance_checked_at: '2020-01-01T00:00:00Z' })
  await f.manager.browserManager.acquire(a.vm.id, { purpose: 'oauth', interactive: true })
  await f.manager.tick()
  await until(() => f.manager.jobs.has(a.vm.id))
  f.manager.setup(b.vm.id)
  const ticket = await f.manager.browserTicket(b.vm.id)
  assert.match(ticket.url, /ticket=/)
  assert.equal(f.manager.browserManager.state(b.vm.id).status, 'queued')
  assert.equal(f.calls.sessions.length, 1, 'background A and interactive B wait for the open manual browser')
  await f.manager.browserManager.close(a.vm.id)
  await until(
    () => f.repo.getAccount(b.accountId).setup_status === 'ready',
    'interactive B was blocked by a background task waiting on A',
  )
  assert.equal(f.manager.browserManager.state(b.vm.id).status, 'api_ready')
  assert.equal(f.manager.browserManager.state(b.vm.id).active, true)
  assert.equal(f.calls.sessions.length, 2, 'background A cannot start while B is retained')
  assert.equal(f.calls.maxLiveBrowsers, 1)
  assert.equal(f.calls.configured.length, 1)
  assert.equal(f.calls.configured[0].email, b.account.email)
  await f.manager.browserManager.close(b.vm.id)
  await f.settle()
  assert.equal(f.calls.maxLiveBrowsers, 1)
  assert.equal(f.calls.liveBrowsers, 0)
  assert.equal(f.repo.getAccount(a.accountId).setup_status, 'ready')
})

test('manual Platform setup promotes a same-slot background refresh without waiting for its own window to close', async (t) => {
  const f = fixture(t)
  const a = f.add()
  f.installKey(a)
  f.repo.upsertOrg('org-test', { balance_checked_at: '2020-01-01T00:00:00Z' })
  const manual = await f.manager.browserManager.acquire(a.vm.id, { purpose: 'oauth', interactive: true })
  await f.manager.tick()
  await until(() => f.manager.jobs.has(a.vm.id))
  f.manager.setup(a.vm.id)
  await f.manager.browserTicket(a.vm.id)
  await until(
    () => f.manager.browserManager.state(a.vm.id).status === 'api_ready',
    'manual setup waited for its own retained browser to close',
  )
  assert.equal(f.manager.browserManager.jobs.get(a.vm.id), manual)
  assert.equal(f.manager.browserManager.state(a.vm.id).status, 'api_ready')
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.calls.maxLiveBrowsers, 1)
  assert.equal(
    f.calls.models.length,
    1,
    'manual setup keeps the setup model refresh rather than the old balance-only task',
  )
})

test('promotion waits for an in-flight background task to finish before reusing its browser', async (t) => {
  const f = fixture(t)
  const a = f.add()
  f.installKey(a)
  let release
  let reads = 0
  f.behavior.readBalance = async () => {
    if (++reads === 1)
      return new Promise((resolve) => {
        release = resolve
      })
    return { balance: '37.000' }
  }
  f.manager.enqueue(f.credits.accountForVm(a.vm.id), 'balance', false)
  await until(() => reads === 1)
  f.manager.setup(a.vm.id)
  assert.equal(f.manager.jobs.get(a.vm.id).abort.signal.aborted, true)
  release({ balance: '999.000' })
  await until(() => f.repo.getAccount(a.accountId).setup_status === 'ready')
  assert.equal(reads, 2)
  assert.equal(f.repo.getOrg('org-test').balance, '37.000')
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.calls.closed.length, 0)
  assert.equal(f.calls.maxLiveBrowsers, 1)
  assert.equal(f.manager.browserManager.state(a.vm.id).status, 'api_ready')
})

test('cancelling before a pending promotion runs prevents the interactive follow-up', async (t) => {
  const f = fixture(t)
  const a = f.add()
  f.installKey(a)
  await f.manager.browserManager.acquire(a.vm.id, { purpose: 'oauth', interactive: true })
  f.manager.enqueue(f.credits.accountForVm(a.vm.id), 'balance', false)
  f.manager.setup(a.vm.id)
  await f.manager.cancel(a.vm.id)
  await f.settle()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.calls.configured.length, 0)
  assert.equal(f.calls.models.length, 0)
  assert.equal(f.manager.browserManager.state(a.vm.id).active, false)
})

test('cached Billing HTTP survives manager restart and updates only the canonical cookie jar', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const key = f.installKey(entry)
  const before = f.cacheBilling(entry)
  f.behavior.balance = '-0.000000000000000001'
  await f.manager.refresh(entry.vm.id)
  await f.settle()
  await f.restart()
  await f.manager.refresh(entry.vm.id)
  await f.settle()
  assert.equal(f.calls.http.length, 2)
  assert.equal(f.calls.sessions.length, 0)
  assert.equal(f.calls.models.length, 0)
  assert.equal(f.repo.getOrg('org-test').balance, '-0.000000000000000001')
  const after = f.profiles.get(entry.vm.id)
  assert.deepEqual(after.storage_state.cookies, [{ name: 'session', value: 'updated' }])
  assert.deepEqual(after.storage_state.origins, before.storage_state.origins)
  assert.deepEqual(after.storage_state.sessionStorage, before.storage_state.sessionStorage)
  assert.deepEqual(after.fingerprint, before.fingerprint)
  assert.deepEqual(after.billing_session, before.billing_session)
  assert.equal(f.repo.getAccount(entry.accountId).key_id, key.id)
  assert.equal(JSON.stringify(f.manager.view(entry.vm)).includes('saved-session'), false)
})

test('a rejected cached session recovers once with the browser and later refreshes use the replacement HTTP session', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const key = f.installKey(entry)
  f.cacheBilling(entry)
  f.behavior.http = () => {
    if (f.calls.http.length === 1)
      throw Object.assign(new Error('session expired'), { code: 'platform_login_required' })
    return { summary: { balance: '36.75' }, cookies: [] }
  }
  f.manager.enqueue(f.credits.accountForVm(entry.vm.id), 'balance', false)
  await f.settle()
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.calls.closed.length, 1)
  assert.equal(f.profiles.get(entry.vm.id).billing_session.headers.authorization, 'Bearer fixture-billing')
  await f.manager.refresh(entry.vm.id)
  await f.settle()
  assert.equal(f.calls.http.length, 2)
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.calls.http[1].session.headers.authorization, 'Bearer fixture-billing')
  assert.equal(f.repo.getOrg('org-test').balance, '36.75')
  assert.equal(f.repo.getAccount(entry.accountId).key_id, key.id)
  assert.equal(f.calls.configured.length, 0)
  assert.equal(f.calls.models.length, 0)
})

test('an unsuccessful automatic browser recovery remains attempted across restart until an administrator retries', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.installKey(entry)
  f.repo.upsertOrg('org-test', { balance: '12.5', balance_checked_at: '2020-01-01T00:00:00Z' })
  f.behavior.authenticated = false
  f.manager.enqueue(f.credits.accountForVm(entry.vm.id), 'balance', false)
  await f.settle()
  await f.restart()
  await f.manager.tick()
  await f.settle()
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.profiles.get(entry.vm.id).billing_session.recovery_attempted, true)
  assert.equal(f.repo.getOrg('org-test').balance, '12.5')
  f.behavior.authenticated = true
  await f.manager.refresh(entry.vm.id)
  await f.settle()
  assert.equal(f.calls.sessions.length, 2)
  assert.equal(f.profiles.get(entry.vm.id).billing_session.recovery_attempted, false)
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
})

test('network and ordinary HTTP errors retain the old balance and never start recovery or affect inference state', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const key = f.installKey(entry)
  f.cacheBilling(entry)
  const checkedAt = '2026-01-01T00:00:00Z'
  f.repo.upsertOrg('org-test', { balance: '-0.5', balance_checked_at: checkedAt })
  for (const code of ['billing_network_error', 'billing_http_error', 'billing_timeout']) {
    f.behavior.http = () => {
      throw Object.assign(new Error('safe Billing failure'), { code })
    }
    await f.manager.refresh(entry.vm.id)
    await f.settle()
    assert.equal(f.repo.getOrg('org-test').balance, '-0.5')
    assert.equal(f.repo.getOrg('org-test').balance_checked_at, checkedAt)
    assert.equal(f.repo.getKey(key.id).disabled, false)
    assert.equal(f.repo.getKey(key.id).cooldown_until, null)
    assert.equal(f.repo.getAccount(entry.accountId).enabled, true)
  }
  assert.equal(f.calls.sessions.length, 0)
  assert.equal(f.profiles.get(entry.vm.id).billing_session.recovery_attempted, false)
})

test('balances of any sign do not release quota blocks and manual resume changes neither the API switch nor invalid-key state', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const block = '9999-12-31T23:59:59.999Z'
  const key = f.installKey(entry, { cooldown_until: block, disabled: true })
  f.store.setKeyCooldown(key.id, block)
  f.cacheBilling(entry)
  f.repo.upsertAccount(entry.accountId, { enabled: false })
  for (const balance of ['0', '-0.00001', '37.5']) {
    f.behavior.balance = balance
    await f.manager.refresh(entry.vm.id)
    await f.settle()
    assert.equal(f.repo.getOrg('org-test').balance, balance)
    assert.equal(f.repo.getKey(key.id).cooldown_until, block)
    assert.equal(f.manager.view(entry.vm).quota_blocked, true)
  }
  const beforeHttp = f.calls.http.length
  const resumed = f.manager.resume(entry.vm.id)
  assert.equal(resumed.quota_blocked, false)
  assert.equal(resumed.enabled, false)
  assert.equal(f.repo.getKey(key.id).disabled, true)
  assert.equal(f.repo.getKey(key.id).cooldown_until, null)
  assert.equal(f.calls.http.length, beforeHttp)
  assert.equal(f.calls.models.length, 0)
  assert.equal(f.calls.configured.length, 0)
  const temporary = '2099-01-01T00:00:00Z'
  f.store.setKeyCooldown(key.id, temporary)
  f.manager.resume(entry.vm.id)
  assert.equal(f.repo.getKey(key.id).cooldown_until, temporary, 'resume only clears the upstream quota block')
})

test('refresh interval changes apply live and zero keeps manual HTTP refresh available', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.installKey(entry)
  f.cacheBilling(entry)
  const now = Date.now()
  f.setTime(now)
  f.repo.upsertOrg('org-test', { balance: '1', balance_checked_at: new Date(now).toISOString() })
  f.routing.openai_api.balance_refresh_interval_minutes = 30
  f.setTime(now + 29 * 60_000)
  await f.manager.tick()
  assert.equal(f.calls.http.length, 0)
  f.setTime(now + 30 * 60_000)
  await f.manager.tick()
  await f.settle()
  assert.equal(f.calls.http.length, 1)
  f.routing.openai_api.balance_refresh_interval_minutes = 0
  f.setTime(now + 24 * 60 * 60_000)
  await f.manager.tick()
  assert.equal(f.calls.http.length, 1)
  assert.equal(f.manager.view(entry.vm).balance_refresh_interval_minutes, 0)
  await f.manager.refresh(entry.vm.id)
  await f.settle()
  assert.equal(f.calls.http.length, 2)
  assert.equal(f.calls.sessions.length, 0)
})

test('failed HTTP retries use the current interval rather than the value saved when the request failed', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.installKey(entry)
  f.cacheBilling(entry)
  const now = Date.now()
  f.setTime(now)
  f.repo.upsertOrg('org-test', { balance_checked_at: '2020-01-01T00:00:00Z' })
  f.routing.openai_api.balance_refresh_interval_minutes = 30
  f.behavior.http = () => {
    throw Object.assign(new Error('network'), { code: 'billing_network_error' })
  }
  await f.manager.tick()
  await f.settle()
  f.setTime(now + 6 * 60_000)
  await f.manager.tick()
  assert.equal(f.calls.http.length, 1)
  f.routing.openai_api.balance_refresh_interval_minutes = 5
  f.behavior.http = null
  await f.manager.tick()
  await f.settle()
  assert.equal(f.calls.http.length, 2)
})

test('waiting HTTP work uses the latest bound proxy after a manual browser closes', async (t) => {
  const f = fixture(t)
  const a = f.add()
  const b = f.add('vm-b', 'account-b')
  f.installKey(a)
  f.cacheBilling(a)
  await f.manager.browserManager.acquire(b.vm.id, { purpose: 'oauth', interactive: true })
  f.manager.enqueue(f.credits.accountForVm(a.vm.id), 'balance', false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls.http.length, 0)
  a.vm.proxy = { url: 'socks5h://127.0.0.1:2080' }
  await f.manager.browserManager.close(b.vm.id)
  await f.settle()
  assert.equal(f.calls.http[0].proxyUrl, 'socks5h://127.0.0.1:2080')
  assert.equal(f.calls.sessions.length, 1, 'only the explicitly opened manual browser was launched')
})

test('a proxy change while HTTP is in flight cannot replace the balance or cookies', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.installKey(entry)
  const before = f.cacheBilling(entry)
  f.repo.upsertOrg('org-test', { balance: '12.5' })
  let finish
  f.behavior.http = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  await f.manager.refresh(entry.vm.id)
  await until(() => !!finish)
  entry.vm.proxy = { url: 'socks5h://127.0.0.1:2080' }
  finish({ summary: { balance: '999' }, cookies: [{ name: 'bad', value: 'late' }] })
  await f.settle()
  assert.equal(f.repo.getOrg('org-test').balance, '12.5')
  assert.deepEqual(f.profiles.get(entry.vm.id).storage_state, before.storage_state)
  assert.equal(f.calls.sessions.length, 0)
})

test('cancelled queued HTTP work cannot let a later request overlap its predecessor', async (t) => {
  const f = fixture(t)
  const entries = [f.add(), f.add('vm-b', 'account-b'), f.add('vm-c', 'account-c')]
  for (const entry of entries) {
    f.installKey(entry)
    f.cacheBilling(entry)
  }
  let releaseFirst
  let active = 0
  let maximum = 0
  f.behavior.http = async () => {
    active++
    maximum = Math.max(maximum, active)
    try {
      if (f.calls.http.length === 1)
        await new Promise((resolve) => {
          releaseFirst = resolve
        })
      return { summary: { balance: '2' }, cookies: [] }
    } finally {
      active--
    }
  }
  for (const entry of entries) f.manager.enqueue(f.credits.accountForVm(entry.vm.id), 'balance', false)
  await until(() => !!releaseFirst)
  await f.manager.cancel(entries[1].vm.id)
  assert.equal(f.calls.http.length, 1)
  releaseFirst()
  await f.settle()
  assert.equal(f.calls.http.length, 2)
  assert.equal(maximum, 1)
  assert.equal(f.calls.sessions.length, 0)
})

test('deleting a slot during HTTP cancels the job and does not recreate its saved state', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.installKey(entry)
  f.cacheBilling(entry)
  f.repo.upsertOrg('org-test', { balance: '12.5' })
  let finish
  f.behavior.http = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  await f.manager.refresh(entry.vm.id)
  await until(() => !!finish)
  f.identities.delete(entry.vm.id)
  const cancelled = f.manager.cancel(entry.vm.id, { forget: true })
  finish({ summary: { balance: '999' }, cookies: [] })
  await cancelled
  await f.settle()
  assert.equal(f.repo.getOrg('org-test').balance, '12.5')
  assert.equal(f.profiles.get(entry.vm.id), null)
  assert.equal(f.manager.jobs.size, 0)
})

test('a manual browser opened during HTTP prevents the old response from overwriting its cookies', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  f.installKey(entry)
  const before = f.cacheBilling(entry)
  f.repo.upsertOrg('org-test', { balance: '12.5' })
  let finish
  f.behavior.http = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  await f.manager.refresh(entry.vm.id)
  await until(() => !!finish)
  await f.manager.browserManager.acquire(entry.vm.id, { purpose: 'oauth', interactive: true })
  finish({ summary: { balance: '999' }, cookies: [{ name: 'bad', value: 'late' }] })
  await f.settle()
  assert.equal(f.repo.getOrg('org-test').balance, '12.5')
  assert.deepEqual(f.profiles.get(entry.vm.id).storage_state, before.storage_state)
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'error')
})

for (const failurePoint of ['addKey', 'account', 'reload']) {
  test(`new key saving retries ${failurePoint} failures without duplicate or partial local records`, async (t) => {
    const f = fixture(t)
    const entry = f.add()
    const created = { organizationId: 'org-test', projectId: 'proj-test', apiKey: 'sk-atomic-fixture-secret' }
    if (failurePoint === 'addKey') {
      const addKey = f.store.addKey.bind(f.store)
      let first = true
      f.store.addKey = (...args) => {
        if (first) {
          first = false
          throw new Error('fixture key insertion failure')
        }
        return addKey(...args)
      }
    } else if (failurePoint === 'account') {
      const upsertAccount = f.repo.upsertAccount.bind(f.repo)
      let first = true
      f.repo.upsertAccount = (accountId, patch) => {
        if (first && patch.key_id) {
          first = false
          throw new Error('fixture account association failure')
        }
        return upsertAccount(accountId, patch)
      }
    } else {
      const reload = f.manager.reload.bind(f.manager)
      let first = true
      f.manager.reload = () => {
        if (first) {
          first = false
          assert.equal(f.repo.db.isTransaction, false, 'scheduler reload must follow the database commit')
          throw new Error('fixture scheduler reload failure')
        }
        return reload()
      }
    }
    f.behavior.configure = async (options) => {
      await assert.rejects(options.onKey(created), /fixture .* failure/)
      const persisted = failurePoint === 'reload'
      assert.equal(f.store.listRaw().length, persisted ? 1 : 0)
      assert.equal(!!f.repo.getAccount(entry.accountId).key_id, persisted)
      assert.equal(!!f.repo.getOrg('org-test'), persisted)
      assert.equal(f.repo.db.prepare('SELECT count(*) AS count FROM api_endpoint_keys').get().count, persisted ? 1 : 0)
      await options.onKey(created)
      const keyId = f.repo.getAccount(entry.accountId).key_id
      await options.onKey(created)
      assert.equal(f.repo.getAccount(entry.accountId).key_id, keyId, 'a repeated save reuses the committed key')
      return created
    }
    f.manager.setup(entry.vm.id)
    await f.settle()
    assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
    assert.equal(f.store.listRaw().length, 1)
    assert.equal(f.store.listRaw()[0].api_key_entries.length, 1)
    assert.equal(f.repo.getKey(f.repo.getAccount(entry.accountId).key_id).api_key, created.apiKey)
  })
}

test('a key save reuses an unassociated matching source key and rejects another secret', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const endpoint = f.store.create({ kind: 'openai', name: 'Interrupted local save' })
  const created = { organizationId: 'org-test', projectId: 'proj-test', apiKey: 'sk-existing-unassociated-fixture' }
  const key = f.store.addKey(endpoint.id, {
    api_key: created.apiKey,
    source_vm_id: entry.vm.id,
    source_account_id: entry.accountId,
  })
  f.behavior.configure = async (options) => {
    await options.onKey(created)
    assert.equal(f.repo.getAccount(entry.accountId).key_id, key.id)
    await assert.rejects(options.onKey({ ...created, apiKey: 'sk-conflicting-fixture' }), {
      code: 'platform_key_save_conflict',
    })
    assert.equal(f.repo.getKey(key.id).api_key, created.apiKey)
    return created
  }
  f.manager.setup(entry.vm.id)
  await f.settle()
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
  assert.equal(f.store.listRaw().length, 1)
  assert.equal(f.store.listRaw()[0].api_key_entries.length, 1)
})

test('manual key input keeps one configuring job and wires continue to the active adapter', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  let options, complete
  f.behavior.configure = (value) => {
    options = value
    options.onState('awaiting_key_input', '请选择期限并完成创建')
    return new Promise((resolve) => {
      complete = resolve
    })
  }
  f.manager.setup(entry.vm.id)
  await until(() => !!complete)
  const live = f.manager.sessions.get(entry.vm.id)
  const job = f.manager.jobs.get(entry.vm.id)
  assert.equal(job.keyName, options.keyName)
  assert.match(job.keyName, /^vm2api-[a-f0-9]{12}-[a-f0-9]{8}$/)
  f.manager.setup(entry.vm.id)
  assert.equal(f.manager.jobs.get(entry.vm.id), job, 'repeated setup during handoff retains the same job')
  assert.equal(job.keyName, options.keyName)
  assert.equal(f.calls.configured.length, 1, 'an active handoff does not start another creation')
  assert.equal(options.signal.aborted, false)
  assert.equal(options.assertCurrent().accountId, entry.accountId)
  assert.equal(live.inputLocked, false)
  assert.equal(live.waiting, true)
  assert.equal(f.manager.browserManager.state(entry.vm.id).status, 'awaiting_key_input')
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'configuring')
  let continued = 0,
    disposed = false
  live.adapter.dispose = () => {
    disposed = true
  }
  live.adapter.continueKeySetup = async () => {
    continued++
    options.onState('key_save_failed', '本地保存失败，请重试保存')
  }
  await live.checkLogin()
  assert.equal(continued, 1)
  assert.equal(live.inputLocked, false)
  assert.equal(live.waiting, true)
  assert.equal(disposed, false)
  assert.equal(f.manager.jobs.get(entry.vm.id), job)
  assert.equal(f.manager.browserManager.state(entry.vm.id).status, 'key_save_failed')
  live.adapter.continueKeySetup = async () => {
    continued++
    options.onState('configuring', '正在保存并继续配置')
    assert.equal(live.inputLocked, true)
    assert.equal(live.waiting, false)
    const created = { organizationId: 'org-test', projectId: 'proj-test', apiKey: 'sk-manual-input-fixture' }
    await options.onKey(created)
    complete(created)
  }
  await live.checkLogin()
  await f.settle()
  assert.equal(continued, 2)
  assert.equal(disposed, true)
  assert.equal(live.checkLogin, null)
  assert.equal(live.waiting, false)
  assert.equal(f.calls.sessions.length, 1)
  assert.equal(f.calls.configured.length, 1)
  assert.equal(f.calls.models.length, 1)
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
})

test('closing a browser aborts manual key input and prevents a late key save', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  let options
  f.behavior.configure = (value) => {
    options = value
    options.onState('awaiting_key_input', '请完成创建')
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  }
  f.manager.setup(entry.vm.id)
  await until(() => !!options)
  const live = f.manager.sessions.get(entry.vm.id)
  await f.manager.browserManager.close(entry.vm.id)
  await f.settle()
  assert.equal(options.signal.aborted, true)
  assert.throws(options.assertCurrent)
  await assert.rejects(options.onKey({ organizationId: 'org-test', projectId: 'proj-test', apiKey: 'sk-late-fixture' }))
  assert.equal(live.checkLogin, null)
  assert.equal(f.store.listRaw().length, 0)
  assert.equal(f.repo.getAccount(entry.accountId).key_id, '')
})

test('setting the interval to zero lets in-flight HTTP finish and drops queued background work without changing its state', async (t) => {
  const f = fixture(t)
  const a = f.add()
  const b = f.add('vm-b', 'account-b')
  f.installKey(a)
  f.installKey(b)
  f.repo.upsertAccount(b.accountId, {
    organization_id: 'org-second',
    setup_status: 'error',
    last_error: 'previous Billing error',
  })
  f.repo.upsertOrg('org-test', { balance: '1' })
  f.repo.upsertOrg('org-second', { balance: '7', balance_error: 'previous Billing error' })
  f.cacheBilling(a)
  f.cacheBilling(b)
  let finish
  f.behavior.http = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  f.manager.enqueue(f.credits.accountForVm(a.vm.id), 'balance', false)
  f.manager.enqueue(f.credits.accountForVm(b.vm.id), 'balance', false)
  await until(() => !!finish)
  assert.equal(f.repo.getAccount(b.accountId).setup_status, 'error')
  f.routing.openai_api.balance_refresh_interval_minutes = 0
  finish({ summary: { balance: '2' }, cookies: [] })
  await f.settle()
  assert.equal(f.calls.http.length, 1)
  assert.equal(f.calls.sessions.length, 0)
  assert.equal(f.repo.getOrg('org-test').balance, '2')
  assert.equal(f.repo.getAccount(a.accountId).setup_status, 'ready')
  assert.equal(f.repo.getAccount(b.accountId).setup_status, 'error')
  assert.equal(f.repo.getAccount(b.accountId).last_error, 'previous Billing error')
  assert.equal(f.repo.getOrg('org-second').balance, '7')
  assert.equal(f.repo.getOrg('org-second').balance_error, 'previous Billing error')
})

test('setting the interval to zero during HTTP prevents a later 401 from starting browser recovery', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const key = f.installKey(entry)
  const block = '9999-12-31T23:59:59.999Z'
  f.store.setKeyCooldown(key.id, block)
  f.repo.upsertAccount(entry.accountId, { last_error: 'upstream quota blocked' })
  const checkedAt = '2026-01-01T00:00:00Z'
  f.repo.upsertOrg('org-test', { balance: '-0.5', balance_checked_at: checkedAt })
  const profile = f.cacheBilling(entry)
  let rejectHttp
  f.behavior.http = () =>
    new Promise((_resolve, reject) => {
      rejectHttp = reject
    })
  f.manager.enqueue(f.credits.accountForVm(entry.vm.id), 'balance', false)
  await until(() => !!rejectHttp)
  f.routing.openai_api.balance_refresh_interval_minutes = 0
  rejectHttp(Object.assign(new Error('expired Billing session'), { code: 'platform_login_required' }))
  await f.settle()
  assert.equal(f.calls.http.length, 1)
  assert.equal(f.calls.sessions.length, 0)
  assert.equal(f.repo.getOrg('org-test').balance, '-0.5')
  assert.equal(f.repo.getOrg('org-test').balance_checked_at, checkedAt)
  assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'needs_login')
  assert.match(f.repo.getAccount(entry.accountId).last_error, /expired Billing session/)
  assert.equal(f.repo.getAccount(entry.accountId).enabled, true)
  assert.equal(f.repo.getKey(key.id).cooldown_until, block)
  assert.equal(f.repo.getKey(key.id).disabled, false)
  assert.deepEqual(f.profiles.get(entry.vm.id).billing_session, profile.billing_session)
  assert.deepEqual(f.profiles.get(entry.vm.id).storage_state, profile.storage_state)
})

test('background work waiting for a manual browser does not request HTTP or recover a missing session after zero is saved', async (t) => {
  const f = fixture(t)
  const a = f.add()
  const b = f.add('vm-b', 'account-b')
  f.installKey(a)
  await f.manager.browserManager.acquire(b.vm.id, { purpose: 'oauth', interactive: true })
  f.manager.enqueue(f.credits.accountForVm(a.vm.id), 'balance', false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.repo.getAccount(a.accountId).setup_status, 'ready')
  f.routing.openai_api.balance_refresh_interval_minutes = 0
  await f.manager.browserManager.close(b.vm.id)
  await f.settle()
  assert.equal(f.calls.http.length, 0)
  assert.equal(f.calls.sessions.length, 1, 'only the administrator-opened browser ran')
  assert.equal(f.profiles.get(a.vm.id), null)
  assert.equal(f.repo.getAccount(a.accountId).setup_status, 'ready')
})

test('a read-only local database preserves the active task and captured secret until saving is retried', async (t) => {
  const f = fixture(t)
  const entry = f.add()
  const created = { apiKey: 'sk-readonly-local-save-fixture', remoteKeyId: 'key-readonly-fixture' }
  let adapter,
    setup,
    failed = false
  f.behavior.configure = async (options) => {
    adapter = new PlatformAdapter({ page: new EventEmitter(), email: entry.account.email })
    adapter.identity.email = entry.account.email
    adapter.identity.organizationId = 'org-test'
    setup = adapter.beginKeySetup({ ...options, organizationName: 'Personal', projectId: 'proj-test' })
    const live = f.manager.sessions.get(entry.vm.id)
    live.adapter.continueKeySetup = () => adapter.continueKeySetup()
    live.adapter.dispose = () => adapter.dispose()
    f.repo.db.exec('PRAGMA query_only = ON')
    try {
      await assert.rejects(adapter.saveCreatedKey(created, setup), /readonly|read-only/i)
      failed = true
      return await setup.result
    } finally {
      adapter.endKeySetup(setup)
    }
  }
  f.manager.setup(entry.vm.id)
  try {
    await until(() => failed)
    const live = f.manager.sessions.get(entry.vm.id)
    const job = f.manager.jobs.get(entry.vm.id)
    assert.ok(job, 'a broad database write failure must not finish the setup task')
    assert.equal(live.job, job)
    assert.equal(live.inputLocked, false)
    assert.equal(f.manager.browserManager.state(entry.vm.id).status, 'key_save_failed')
    assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'configuring')
    assert.equal(adapter.keySetup, setup)
    assert.equal(adapter.createdKey.apiKey, created.apiKey)
    assert.equal(f.store.listRaw().length, 0)
    assert.equal(f.repo.db.isTransaction, false)
    f.repo.db.exec('PRAGMA query_only = OFF')
    await live.checkLogin()
    await f.settle()
    assert.equal(f.repo.getAccount(entry.accountId).setup_status, 'ready')
    assert.equal(f.repo.getKey(f.repo.getAccount(entry.accountId).key_id).api_key, created.apiKey)
    assert.equal(f.store.listRaw().length, 1)
    assert.equal(f.store.listRaw()[0].api_key_entries.length, 1)
    assert.equal(f.calls.sessions.length, 1)
    assert.equal(f.calls.configured.length, 1)
  } finally {
    f.repo.db.exec('PRAGMA query_only = OFF')
  }
})
