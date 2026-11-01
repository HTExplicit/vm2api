import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { OpenaiApiRepo } from '../../src/lib/db/repos/openai-api-repo.mjs'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { OpenaiApiManager } from '../../src/lib/openai-api/manager.mjs'
import { PlatformAdapter } from '../../src/lib/openai-api/platform-adapter.mjs'

const SECRET = 'sk-proj-integration-fixture-only-secret'

async function until(predicate, message = 'key handoff did not reach the expected state', timeout = 2000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await sleep(5)
  }
}

// This represents the official form's observable labels and controls. The
// expiration field is absent, so the real adapter must yield to manual input.
function formPage() {
  const page = new EventEmitter()
  const calls = { navigations: [], opens: 0, submits: 0, name: '' }
  const element = (properties) => ({ visible: true, ...properties })
  const nameInput = element({ tagName: 'INPUT', fill: async (value) => (calls.name = value) })
  const projectInput = element({ tagName: 'BUTTON', textContent: 'Default project' })
  const nameLabel = element({ textContent: 'Name Optional', control: nameInput })
  const projectLabel = element({ textContent: 'Project', control: projectInput })
  const create = element({ textContent: 'Create new secret key', click: async () => calls.opens++ })
  const submit = element({
    textContent: 'Create secret key',
    click: async () => {
      calls.submits++
      await calls.submitAction?.()
    },
  })
  const dialog = element({ tagName: 'DIV' })
  let revealed = []

  const matches = (pattern, value) => (typeof pattern === 'string' ? pattern === value : pattern.test(value))
  function locator(values) {
    return {
      count: async () => values.length,
      first: () => locator(values.slice(0, 1)),
      nth: (index) => locator(values.slice(index, index + 1)),
      isVisible: async () => !!values[0]?.visible,
      waitFor: async ({ state } = {}) => {
        if (state !== 'hidden' && values.length !== 1) throw new Error('fixture control is absent')
      },
      filter: ({ hasText, visible } = {}) =>
        locator(
          values.filter(
            (value) => (!hasText || matches(hasText, value.textContent || '')) && (!visible || value.visible),
          ),
        ),
      locator: (selector) => {
        if (selector === '..') return locator(values.map((value) => ({ ...value, parent: true })))
        if (selector === 'label') return locator([nameLabel, projectLabel])
        return locator(values.filter((value) => value.parent && value.control).map((value) => value.control))
      },
      getByLabel: () => locator([]),
      getByText: () => locator([]),
      getByRole: (role, { name } = {}) => {
        if (role === 'button' && (!name || matches(name, submit.textContent))) return locator([submit])
        return locator([])
      },
      fill: async (value) => values[0].fill(value),
      click: async () => values[0]?.click?.(),
      innerText: async () => values[0]?.textContent || '',
      inputValue: async () => values[0]?.value || '',
      evaluate: async (fn) => fn(values[0]),
      evaluateAll: async () => (typeof revealed === 'function' ? revealed() : revealed),
    }
  }
  page.url = () => 'https://platform.openai.com/api-keys'
  page.goto = async (url) => calls.navigations.push(url)
  page.getByRole = (role, { name } = {}) => {
    if (role === 'dialog') return locator([dialog])
    if (role === 'button' && (!name || matches(name, create.textContent))) return locator([create])
    return locator([])
  }
  page.locator = () => locator([element({})])
  page.waitForTimeout = (milliseconds) => sleep(Math.min(milliseconds, 5))
  return { page, calls, reveal: (secrets) => (revealed = secrets) }
}

function fixture(t, { balanceError = null, automaticExpiration = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-key-handoff-'))
  const db = createDatabase({ dataDir: directory })
  const repo = new OpenaiApiRepo(db)
  const store = new ApiEndpointStore({ db })
  const { page, calls, reveal } = formPage()
  const statuses = []
  const entry = {
    vm: {
      id: 'vm-handoff',
      status: 'stopped',
      schedulable: false,
      family: 'codex',
      codex: { chatgpt_account_id: 'handoff-account' },
      proxy: { url: 'socks5h://127.0.0.1:1080' },
    },
    account: { email: 'handoff@example.test' },
    accountId: 'handoff-account',
  }
  repo.upsertAccount(entry.accountId, {
    vm_id: entry.vm.id,
    claim_status: 'claimed',
    organization_id: 'org-test',
  })
  const credits = {
    accountForVm: () => ({ ...entry, record: repo.getAccount(entry.accountId) }),
    view: () => repo.getAccount(entry.accountId),
  }
  class Adapter extends PlatformAdapter {
    constructor(options) {
      super(options)
      this.identity = {
        email: options.email,
        organizationId: 'org-test',
        organizations: [{ id: 'org-test', name: 'Personal' }],
        projects: [{ id: 'proj-test', name: 'Default project', is_default: true, organizationId: 'org-test' }],
      }
      this.projectLists.add('org-test')
    }
    async inspect() {
      return { ...this.identity, authenticated: this.identity.email === this.email }
    }
    async goto(url) {
      await this.page.goto(url)
    }
    async selectExpiration(dialog) {
      if (!automaticExpiration) await super.selectExpiration(dialog)
    }
    async readBalance() {
      if (balanceError) throw balanceError
      return { balance: '37', paid_balance: '0', grants: [] }
    }
    billingSessionFor(organizationId) {
      return {
        organization_id: organizationId,
        headers: { authorization: 'Bearer fixture', 'user-agent': 'fixture' },
      }
    }
  }
  const manager = new OpenaiApiManager({
    cfg: {},
    repo,
    credits,
    apiEndpointStore: store,
    apiScheduler: { reload() {} },
    Adapter,
    createSession: async ({ onFingerprint }) => {
      await onFingerprint({ device: 'handoff-fixture' })
      return {
        page,
        context: {},
        storageState: async () => ({ cookies: [], origins: [] }),
        close: async () => page.emit('close'),
      }
    },
    fetchModels: async () => ({ models: [{ name: 'fixture-model', alias: 'fixture-model' }] }),
  })
  const setStatus = manager.browserManager.setStatus.bind(manager.browserManager)
  manager.browserManager.setStatus = (live, status, message, details) => {
    statuses.push({ status, message })
    return setStatus(live, status, message, details)
  }
  function creation({
    name = calls.name,
    organizationId = 'org-test',
    projectId = 'proj-test',
    secret = SECRET,
    extraHeaders = {},
    extraBody = {},
  } = {}) {
    const request = {
      url: () => 'https://api.openai.com/dashboard/user/api_keys',
      method: () => 'POST',
      headers: () => ({ 'openai-organization': organizationId, ...extraHeaders }),
      postDataJSON: () => ({ name, project_id: projectId, ...extraBody }),
    }
    const response = {
      url: request.url,
      request: () => request,
      ok: () => true,
      headers: () => ({ 'content-type': 'application/json' }),
      json: async () => ({ api_key: { id: 'key-fixture', secret } }),
    }
    return { request, response }
  }
  t.after(async () => {
    await manager.stop()
    db.close()
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    manager,
    repo,
    store,
    db,
    entry,
    page,
    calls,
    statuses,
    reveal,
    creation,
    live: () => manager.sessions.get(entry.vm.id),
    settle: () => until(() => manager.jobs.size === 0),
    async start() {
      manager.setup(entry.vm.id)
      await until(() => manager.browserManager.state(entry.vm.id).status === 'awaiting_key_input')
      return this.live()
    },
    emitCreation(options) {
      const created = creation(options)
      page.emit('request', created.request)
      page.emit('response', created.response)
      return created
    },
    counts: () => ({
      endpoints: db.prepare('SELECT count(*) AS count FROM api_endpoints').get().count,
      keys: db.prepare('SELECT count(*) AS count FROM api_endpoint_keys').get().count,
    }),
  }
}

test('real adapter handoff keeps its manager job alive and saves manual creation before a failed balance lookup', async (t) => {
  const f = fixture(t, { balanceError: new Error('fixture balance unavailable') })
  const live = await f.start()
  const job = f.manager.jobs.get(f.entry.vm.id)
  assert.equal(live.job, job)
  assert.equal(live.inputLocked, false)
  assert.equal(f.repo.getAccount(f.entry.accountId).setup_status, 'configuring')
  assert.ok(f.page.listenerCount('response') > 0)
  const created = f.emitCreation()
  f.page.emit('response', created.response)
  await f.settle()
  const account = f.repo.getAccount(f.entry.accountId)
  assert.equal(account.setup_status, 'ready')
  const key = f.repo.getKey(account.key_id)
  assert.equal(key.api_key, SECRET)
  assert.equal(key.source_account_id, f.entry.accountId)
  assert.equal(key.source_vm_id, f.entry.vm.id)
  assert.deepEqual(f.counts(), { endpoints: 1, keys: 1 })
  assert.equal(f.repo.getOrg('org-test').balance_error, 'fixture balance unavailable')
  assert.equal(f.calls.opens, 1)
  assert.equal(f.calls.submits, 0, 'only the user submits the official form during handoff')
  assert.equal(f.page.listenerCount('response'), 0)
  assert.equal(JSON.stringify(f.statuses).includes(SECRET), false)
})

test('repeated continue checks keep the same form and never submit a second creation', async (t) => {
  const f = fixture(t)
  const live = await f.start()
  const initialNavigations = f.calls.navigations.length
  const keyName = f.calls.name
  assert.match(keyName, /^vm2api-[a-f0-9]{12}-[a-f0-9]{8}$/)
  assert.equal(live.job.keyName, keyName)
  f.manager.setup(f.entry.vm.id)
  assert.equal(f.manager.sessions.get(f.entry.vm.id), live)
  await Promise.all([live.checkLogin(), live.checkLogin(), live.checkLogin()])
  assert.equal(f.calls.navigations.length, initialNavigations)
  assert.equal(f.calls.submits, 0)
  assert.equal(f.calls.name, keyName, 'one setup job keeps its creation name while checking for its result')
  assert.equal(f.manager.sessions.get(f.entry.vm.id), live)
  const created = f.creation()
  f.page.emit('request', created.request)
  await Promise.all([live.checkLogin(), live.checkLogin()])
  assert.equal(f.calls.submits, 0)
  f.page.emit('response', created.response)
  await f.settle()
  assert.deepEqual(f.counts(), { endpoints: 1, keys: 1 })
  assert.equal(f.calls.opens, 1)
})

test('real adapter retries a failed local save using the captured secret without another official request', async (t) => {
  const f = fixture(t)
  const live = await f.start()
  const addKey = f.store.addKey.bind(f.store)
  let saves = 0
  f.store.addKey = (...args) => {
    if (++saves === 1) throw new Error('fixture local storage unavailable')
    return addKey(...args)
  }
  f.emitCreation()
  await until(() => f.manager.browserManager.state(f.entry.vm.id).status === 'key_save_failed')
  assert.equal(f.manager.sessions.get(f.entry.vm.id), live)
  assert.equal(live.inputLocked, false)
  assert.deepEqual(f.counts(), { endpoints: 0, keys: 0 }, 'the failed transaction leaves no orphan endpoint')
  await Promise.all([live.checkLogin(), live.checkLogin()])
  await f.settle()
  assert.equal(saves, 2)
  assert.equal(f.repo.getKey(f.repo.getAccount(f.entry.accountId).key_id).api_key, SECRET)
  assert.deepEqual(f.counts(), { endpoints: 1, keys: 1 })
  assert.equal(f.calls.submits, 0)
  assert.equal(f.calls.opens, 1)
})

for (const cancel of ['task', 'browser']) {
  test(`closing the ${cancel} during real adapter handoff cannot save a late creation response`, async (t) => {
    const f = fixture(t)
    await f.start()
    const created = f.creation()
    f.page.emit('request', created.request)
    if (cancel === 'task') await f.manager.cancel(f.entry.vm.id)
    else await f.manager.browserManager.close(f.entry.vm.id)
    await f.settle()
    f.page.emit('response', created.response)
    await new Promise(setImmediate)
    assert.deepEqual(f.counts(), { endpoints: 0, keys: 0 })
    assert.equal(f.page.listenerCount('response'), 0)
    assert.ok(!f.repo.getAccount(f.entry.accountId).key_id)
  })
}

for (const [description, scope] of [
  ['another key name', { name: 'another-manually-created-key' }],
  ['another organization', { organizationId: 'org-other' }],
  ['another project', { projectId: 'proj-other' }],
  ['a conflicting organization body', { extraBody: { organization_id: 'org-other' } }],
  ['a conflicting project header', { extraHeaders: { 'openai-project': 'proj-other' } }],
  ['a conflicting project alias', { extraBody: { project: { id: 'proj-other' } } }],
  ['a conflicting organization alias', { extraBody: { organization: { id: 'org-other' } } }],
]) {
  test(`real adapter handoff does not bind a secret from ${description}`, async (t) => {
    const f = fixture(t)
    const live = await f.start()
    f.emitCreation(scope)
    await live.adapter.settled()
    assert.deepEqual(f.counts(), { endpoints: 0, keys: 0 })
    assert.ok(!f.repo.getAccount(f.entry.accountId).key_id)
    assert.equal(
      f.statuses.some(({ status }) => status === 'api_ready'),
      false,
    )
    await f.manager.cancel(f.entry.vm.id)
  })
}

test('DOM fallback requires a matching successful response and cannot race it into saving twice', async (t) => {
  const f = fixture(t)
  const live = await f.start()
  const created = f.creation()
  f.reveal([SECRET])
  f.page.emit('request', created.request)
  await live.checkLogin()
  assert.deepEqual(f.counts(), { endpoints: 0, keys: 0 }, 'a visible secret without confirmed creation is not trusted')
  f.page.emit('response', { ...created.response, json: async () => ({ api_key: { id: 'key-fixture' } }) })
  await live.adapter.settled()
  let finishDom
  f.reveal(() => new Promise((resolve) => (finishDom = resolve)))
  const checking = live.checkLogin()
  await until(() => !!finishDom)
  f.page.emit('response', created.response)
  finishDom([SECRET])
  await checking
  await f.settle()
  assert.deepEqual(f.counts(), { endpoints: 1, keys: 1 })
  assert.equal(f.repo.getKey(f.repo.getAccount(f.entry.accountId).key_id).api_key, SECRET)
  assert.equal(f.calls.submits, 0)
})

for (const change of ['account', 'proxy']) {
  test(`changing the ${change} during handoff terminates the old job before saving a secret`, async (t) => {
    const f = fixture(t)
    await f.start()
    const created = f.creation()
    f.page.emit('request', created.request)
    if (change === 'account') f.entry.accountId = 'replacement-account'
    else f.entry.vm.proxy = { url: 'socks5h://127.0.0.1:2080' }
    f.page.emit('response', created.response)
    await f.settle()
    assert.deepEqual(f.counts(), { endpoints: 0, keys: 0 })
    assert.equal(f.page.listenerCount('response'), 0)
    assert.equal(
      f.statuses.some(({ status }) => status === 'api_ready'),
      false,
    )
    assert.equal(f.repo.getAccount('replacement-account'), null)
  })
}

test('cancelling a failed local save removes the captured secret and its listeners without recreating the key', async (t) => {
  const f = fixture(t)
  const live = await f.start()
  const adapter = live.adapter
  f.store.addKey = () => {
    throw new Error('fixture local storage unavailable')
  }
  f.emitCreation()
  await until(() => f.manager.browserManager.state(f.entry.vm.id).status === 'key_save_failed')
  assert.equal(adapter.createdKey.apiKey, SECRET)
  await f.manager.cancel(f.entry.vm.id)
  await adapter.continueKeySetup()
  assert.equal(adapter.createdKey, null)
  assert.equal(adapter.keySetup, null)
  assert.equal(f.page.listenerCount('request'), 0)
  assert.equal(f.page.listenerCount('response'), 0)
  assert.deepEqual(f.counts(), { endpoints: 0, keys: 0 })
})

test('an uncertain automatic submit waits for its late response and continue never resubmits', async (t) => {
  const f = fixture(t, { automaticExpiration: true })
  let created
  f.calls.submitAction = () => {
    created = f.creation()
    f.page.emit('request', created.request)
    throw new Error('fixture click timed out after the request was sent')
  }
  const live = await f.start()
  assert.equal(f.calls.submits, 1)
  assert.equal(live.inputLocked, false)
  await Promise.all([live.checkLogin(), live.checkLogin(), live.checkLogin()])
  assert.equal(f.calls.submits, 1, 'the uncertain official submission must never be repeated')
  assert.deepEqual(f.counts(), { endpoints: 0, keys: 0 })
  f.page.emit('response', created.response)
  await f.settle()
  assert.equal(f.repo.getAccount(f.entry.accountId).setup_status, 'ready')
  assert.equal(f.repo.getKey(f.repo.getAccount(f.entry.accountId).key_id).api_key, SECRET)
  assert.deepEqual(f.counts(), { endpoints: 1, keys: 1 })
  assert.equal(f.calls.submits, 1)
})

test('the existing fifteen-minute browser idle watchdog closes a pending handoff without saving a key', async (t) => {
  const f = fixture(t)
  const live = await f.start()
  const adapter = live.adapter
  f.manager.browserManager.now = () => live.touchedAt + 15 * 60_000 + 1
  await until(
    () => !f.manager.browserManager.state(f.entry.vm.id).active && f.manager.jobs.size === 0,
    'the browser idle watchdog did not close the pending handoff',
    3500,
  )
  assert.deepEqual(f.counts(), { endpoints: 0, keys: 0 })
  assert.equal(adapter.keySetup, null)
  assert.equal(adapter.createdKey, null)
  assert.equal(f.page.listenerCount('request'), 0)
  assert.equal(f.page.listenerCount('response'), 0)
  assert.equal(f.manager.sessions.size, 0)
})

test('an unrelated earlier creation disables DOM recovery while the expected JSON result remains usable', async (t) => {
  const f = fixture(t)
  const live = await f.start()
  f.emitCreation({ name: 'an-unrelated-key' })
  await live.adapter.settled()
  const expected = f.creation()
  f.page.emit('request', expected.request)
  f.page.emit('response', { ...expected.response, json: async () => ({ api_key: { id: 'key-fixture' } }) })
  await live.adapter.settled()
  f.reveal(['sk-proj-unrelated-fixture-secret'])
  await live.checkLogin()
  assert.deepEqual(f.counts(), { endpoints: 0, keys: 0 }, 'an ambiguous page secret cannot supply the account key')
  f.page.emit('response', expected.response)
  await f.settle()
  assert.equal(f.repo.getKey(f.repo.getAccount(f.entry.accountId).key_id).api_key, SECRET)
  assert.deepEqual(f.counts(), { endpoints: 1, keys: 1 })
})
