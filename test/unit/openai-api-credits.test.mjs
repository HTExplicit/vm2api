import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { OpenaiApiRepo } from '../../src/lib/db/repos/openai-api-repo.mjs'
import { OpenaiApiCreditsService } from '../../src/lib/oauth/openai-api-credits.mjs'
import { readCodexAccounts, writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'

const ACCOUNT_ID = 'account-api-promo'
const ORG_ID = 'org-api-promo'
const EXPIRES = '2099-11-12T03:36:08Z'
const OFFER = {
  currency: 'USD',
  cadence: 'monthly',
  period_credit_amount_usd: '100.00',
  claimable_credit_amount_usd: '37.00',
  expires_at: EXPIRES,
}
const DESTINATION = {
  destination_type: 'api_org',
  destination_account_id: ORG_ID,
  display_name: 'Personal',
}

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function fixture(t, { plan = 'prolite', proxy = { url: 'socks5h://127.0.0.1:1080' } } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-api-credits-'))
  const db = createDatabase({ dataDir: path.join(projectRoot, 'data') })
  t.after(() => {
    db.close()
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })
  const vmId = 'vm-api-promo'
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  fs.mkdirSync(path.join(projectRoot, 'vms', vmId), { recursive: true })
  atomicWriteJson(file, {
    id: vmId,
    platform: 'openai',
    family: 'codex',
    status: 'stopped',
    schedulable: false,
    timezone: 'Asia/Singapore',
    proxy,
  })
  const account = {
    email: 'promo@example.test',
    access_token: jwt({ exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID } }),
    id_token: jwt({
      email: 'promo@example.test',
      'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID, chatgpt_plan_type: plan },
    }),
    chatgpt_account_id: ACCOUNT_ID,
    chatgpt_plan_type: plan,
  }
  writeCodexAccounts(projectRoot, vmId, [account])
  const repo = new OpenaiApiRepo(db)
  return {
    projectRoot,
    vmId,
    repo,
    account,
    vm: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    service: (fetchImpl, options = {}) => new OpenaiApiCreditsService({ projectRoot, repo, fetchImpl, ...options }),
  }
}

function mcpMock({
  preview = { eligible: true, ineligibility_reason: null, offer: OFFER },
  destinations = [DESTINATION],
  link,
  sse = false,
} = {}) {
  const calls = []
  const fetch = async (url, init) => {
    assert.equal(new URL(url).pathname, '/backend-api/product-account-links/mcp')
    assert.equal(init.method, 'POST')
    const headers = new Headers(init.headers)
    assert.match(headers.get('authorization'), /^Bearer header\./)
    assert.equal(headers.get('chatgpt-account-id'), ACCOUNT_ID)
    assert.equal(headers.get('origin'), 'https://chatgpt.com')
    assert.equal(headers.get('referer'), 'https://chatgpt.com/')
    assert.match(headers.get('user-agent'), /Mozilla\/5\.0/)
    const body = JSON.parse(init.body)
    calls.push(body)
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (body.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: { name: 'product-account-links', version: '1.0' },
        },
      })
    }
    assert.equal(body.method, 'tools/call')
    let data
    if (body.params.name === 'preview_api_credit_promo') data = preview
    else if (body.params.name === 'discover_api_orgs') data = { destinations }
    else if (body.params.name === 'link_api_org') data = await link(body.params.arguments)
    else assert.fail(`unexpected MCP tool ${body.params.name}`)
    const result = {
      jsonrpc: '2.0',
      id: body.id,
      result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false },
    }
    return sse
      ? new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      : Response.json(result)
  }
  return { fetch, calls, tools: () => calls.filter((call) => call.method === 'tools/call') }
}

function linked(outcome = 'pending') {
  return {
    id: 'link-fixture',
    state: 'active',
    destination_type: 'api_org',
    destination_account_id: ORG_ID,
    destination_display_name: 'Personal',
    delivery_result: {
      outcome,
      amount_usd: outcome === 'issued' ? '37.00' : null,
      expires_at: outcome === 'issued' ? EXPIRES : null,
      reason: null,
    },
    can_unlink: false,
  }
}

test('only the six normalized Pro plan values can query promo eligibility', async (t) => {
  for (const plan of ['prolite', 'chatgptprolite', 'pro', 'chatgptpro', 'promax', 'chatgptpromax']) {
    const slot = fixture(t, { plan })
    const mock = mcpMock()
    const view = await slot.service(mock.fetch).preview(slot.vmId)
    assert.equal(view.pro_eligible, true, plan)
    assert.equal(view.claim_status, 'eligible', plan)
    assert.equal(mock.tools().length, 2)
  }
  for (const plan of ['free', 'plus', 'team', 'business', 'edu']) {
    const slot = fixture(t, { plan })
    let requests = 0
    const service = slot.service(async () => {
      requests += 1
      assert.fail('non-Pro accounts must not query the MCP')
    })
    await assert.rejects(service.preview(slot.vmId))
    await assert.rejects(service.claim(slot.vmId))
    assert.equal(requests, 0, plan)
    assert.equal(service.view(slot.vm()).pro_eligible, false)
  }
})

test('repository rebind reads the restored database instead of its closed previous connection', (t) => {
  const slot = fixture(t)
  const restored = createDatabase({ dataDir: path.join(slot.projectRoot, 'restored') })
  try {
    new OpenaiApiRepo(restored).upsertAccount(ACCOUNT_ID, { vm_id: slot.vmId, claim_status: 'claimed' })
    slot.repo.upsertAccount(ACCOUNT_ID, { claim_status: 'eligible' })
    const sameRepo = slot.repo.rebind(restored)
    assert.equal(sameRepo, slot.repo)
    assert.equal(slot.repo.getAccount(ACCOUNT_ID).claim_status, 'claimed')
    slot.repo.upsertOrg(ORG_ID, { balance: '21.30', endpoint_id: 'ep-restored' })
    assert.equal(new OpenaiApiRepo(restored).getOrg(ORG_ID).endpoint_id, 'ep-restored')
  } finally {
    restored.close()
  }
})

test('preview persists the offer and destinations without modifying OAuth credentials or runtime intent', async (t) => {
  const slot = fixture(t)
  const before = readCodexAccounts(slot.projectRoot, slot.vmId)
  const mock = mcpMock({ sse: true })
  const view = await slot.service(mock.fetch).preview(slot.vmId)
  assert.deepEqual(view.offer, OFFER)
  assert.deepEqual(view.destinations, [DESTINATION])
  assert.equal(view.enabled, false)
  assert.equal(view.has_key, false)
  const record = slot.repo.getAccount(ACCOUNT_ID)
  assert.equal(record.vm_id, slot.vmId)
  assert.deepEqual(record.offer, OFFER)
  assert.deepEqual(readCodexAccounts(slot.projectRoot, slot.vmId), before)
  assert.equal(slot.vm().status, 'stopped')
  assert.equal(slot.vm().schedulable, false)
})

test('claim selects the sole organization and persists its operation before linking, then blocks duplicate claims', async (t) => {
  const slot = fixture(t)
  const linkedEvents = []
  let linkCalls = 0
  const mock = mcpMock({
    link: (args) => {
      linkCalls += 1
      const record = slot.repo.getAccount(ACCOUNT_ID)
      assert.match(args.operation_id, /^[0-9a-f-]{36}$/)
      assert.equal(record.operation_id, args.operation_id)
      assert.equal(record.destination_account_id, ORG_ID)
      assert.equal(args.destination_account_id, ORG_ID)
      return linked()
    },
  })
  const service = slot.service(mock.fetch, { onLinked: (...args) => linkedEvents.push(args) })
  await service.preview(slot.vmId)
  const view = await service.claim(slot.vmId)
  assert.equal(view.claim_status, 'pending')
  assert.equal(view.organization_id, ORG_ID)
  assert.equal(view.organization_name, 'Personal')
  assert.equal(slot.repo.getAccount(ACCOUNT_ID).claim_status, 'pending')
  assert.equal(linkedEvents.length, 0, 'API setup waits for the issued delivery result')
  await service.claim(slot.vmId).catch(() => {})
  assert.equal(linkCalls, 1, 'active pending links cannot create a second linking attempt')
})

test('multiple organizations require a deliberate selection before issuing link_api_org', async (t) => {
  const slot = fixture(t)
  const mock = mcpMock({
    destinations: [DESTINATION, { ...DESTINATION, destination_account_id: 'org-other', display_name: 'Other' }],
    link: () => assert.fail('selection is required'),
  })
  const service = slot.service(mock.fetch)
  await service.preview(slot.vmId)
  await assert.rejects(service.claim(slot.vmId))
  assert.equal(mock.tools().filter((call) => call.params.name === 'link_api_org').length, 0)
})

test('pending delivery survives service recreation and rechecks the same operation and destination', async (t) => {
  const slot = fixture(t)
  const linkArguments = []
  const mock = mcpMock({
    link: (args) => {
      linkArguments.push(args)
      return linked(linkArguments.length === 1 ? 'pending' : 'issued')
    },
  })
  const service = slot.service(mock.fetch)
  await service.preview(slot.vmId)
  await service.claim(slot.vmId)
  const restarted = slot.service(mock.fetch)
  const view = await restarted.refreshClaim(slot.vmId)
  assert.equal(view.claim_status, 'claimed')
  assert.equal(linkArguments.length, 2)
  assert.deepEqual(linkArguments[1], linkArguments[0])
  assert.equal(slot.repo.getAccount(ACCOUNT_ID).delivery.outcome, 'issued')
})

test('an uncertain link failure keeps the operation so the next attempt cannot issue a second claim', async (t) => {
  const slot = fixture(t)
  const attempts = []
  const mock = mcpMock({
    link: (args) => {
      attempts.push(args)
      if (attempts.length === 1) throw new Error('fixture connection ended after request')
      return linked('issued')
    },
  })
  const service = slot.service(mock.fetch)
  await service.preview(slot.vmId)
  await assert.rejects(service.claim(slot.vmId), /connection ended/)
  const saved = slot.repo.getAccount(ACCOUNT_ID)
  assert.equal(saved.operation_id, attempts[0].operation_id)
  assert.equal(saved.destination_account_id, ORG_ID)
  assert.deepEqual(saved.offer, OFFER)
  const recovered = await slot.service(mock.fetch).refreshClaim(slot.vmId)
  assert.equal(recovered.claim_status, 'claimed')
  assert.deepEqual(attempts[1], attempts[0])
})

test('external already_linked previews lock the claim action without issuing a new link', async (t) => {
  const slot = fixture(t)
  const benefit = { currency: 'USD', cadence: 'monthly', period_credit_amount_usd: '100', expires_at: EXPIRES }
  const mock = mcpMock({
    preview: { eligible: false, ineligibility_reason: 'already_linked', offer: null, benefit },
    link: () => assert.fail('an external active link must not be recreated'),
  })
  const service = slot.service(mock.fetch)
  const view = await service.preview(slot.vmId)
  assert.equal(view.claim_status, 'claimed')
  assert.deepEqual(view.benefit, benefit)
  await service.claim(slot.vmId).catch(() => {})
  assert.equal(mock.tools().filter((call) => call.params.name === 'link_api_org').length, 0)
})

test('missing proxy rejects before a promo request and does not fall back to direct transport', async (t) => {
  const slot = fixture(t, { proxy: null })
  let requests = 0
  await assert.rejects(
    slot
      .service(async () => {
        requests += 1
        assert.fail('missing proxy must prevent transport')
      })
      .preview(slot.vmId),
  )
  assert.equal(requests, 0)
})

test('same-action calls join while a concurrent claim cannot return an in-flight preview as success', async (t) => {
  const slot = fixture(t)
  let resumeInitialize
  let markStarted
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  const gate = new Promise((resolve) => {
    resumeInitialize = resolve
  })
  const mock = mcpMock({ link: () => assert.fail('a busy claim must not be submitted') })
  const service = slot.service(async (url, init) => {
    if (JSON.parse(init.body).method === 'initialize') {
      markStarted()
      await gate
    }
    return mock.fetch(url, init)
  })
  const firstPreview = service.preview(slot.vmId)
  await started
  const joinedPreview = service.preview(slot.vmId)
  assert.equal(joinedPreview, firstPreview)
  await assert.rejects(service.claim(slot.vmId), { code: 'api_promo_busy', status: 409 })
  await assert.rejects(service.refreshClaim(slot.vmId), { code: 'api_promo_busy', status: 409 })
  resumeInitialize()
  const [first, joined] = await Promise.all([firstPreview, joinedPreview])
  assert.equal(first, joined)
  assert.equal(first.claim_status, 'eligible')
  assert.equal(mock.tools().filter((call) => call.params.name === 'link_api_org').length, 0)
})

test('proxy rebind after MCP initialize stops the claim before another RPC is sent', async (t) => {
  const slot = fixture(t)
  slot.repo.upsertAccount(ACCOUNT_ID, {
    vm_id: slot.vmId,
    claim_status: 'eligible',
    offer: OFFER,
    destinations: [DESTINATION],
  })
  const mock = mcpMock({ link: () => assert.fail('the old proxy must not submit the link') })
  const service = slot.service(async (url, init) => {
    const response = await mock.fetch(url, init)
    if (JSON.parse(init.body).method === 'initialize') {
      atomicWriteJson(path.join(slot.projectRoot, 'vms', `${slot.vmId}.json`), {
        ...slot.vm(),
        proxy: { url: 'socks5h://127.0.0.1:2080' },
      })
    }
    return response
  })
  await assert.rejects(service.claim(slot.vmId), { code: 'api_proxy_changed' })
  assert.deepEqual(
    mock.calls.map((call) => call.method),
    ['initialize'],
  )
  const record = slot.repo.getAccount(ACCOUNT_ID)
  assert.equal(record.claim_status, 'eligible')
  assert.equal(record.organization_id, '')
  assert.equal(record.delivery, null)
  assert.ok(record.operation_id, 'the original operation remains available for a deliberate status recheck')
})

test('proxy rebind before preview persistence discards the old proxy result', async (t) => {
  const slot = fixture(t)
  const mock = mcpMock()
  const service = slot.service(async (url, init) => {
    const response = await mock.fetch(url, init)
    if (JSON.parse(init.body).params?.name === 'discover_api_orgs') {
      atomicWriteJson(path.join(slot.projectRoot, 'vms', `${slot.vmId}.json`), {
        ...slot.vm(),
        proxy: { url: 'socks5h://127.0.0.1:2080' },
      })
    }
    return response
  })
  await assert.rejects(service.preview(slot.vmId), { code: 'api_proxy_changed' })
  const record = slot.repo.getAccount(ACCOUNT_ID)
  assert.equal(record.claim_status, 'unknown')
  assert.equal(record.offer, null)
  assert.deepEqual(record.destinations, [])
})

test('proxy rebind during link response leaves only the persisted operation for recovery', async (t) => {
  const slot = fixture(t)
  slot.repo.upsertAccount(ACCOUNT_ID, {
    vm_id: slot.vmId,
    claim_status: 'eligible',
    offer: OFFER,
    destinations: [DESTINATION],
  })
  const mock = mcpMock({
    link: () => {
      atomicWriteJson(path.join(slot.projectRoot, 'vms', `${slot.vmId}.json`), {
        ...slot.vm(),
        proxy: { url: 'socks5h://127.0.0.1:2080' },
      })
      return linked('issued')
    },
  })
  const service = slot.service(mock.fetch)
  await assert.rejects(service.claim(slot.vmId), { code: 'api_proxy_changed' })
  const record = slot.repo.getAccount(ACCOUNT_ID)
  assert.equal(record.claim_status, 'eligible')
  assert.equal(record.organization_id, '')
  assert.equal(record.delivery, null)
  assert.equal(slot.repo.getOrg(ORG_ID), null)
  assert.equal(mock.tools().filter((call) => call.params.name === 'link_api_org').length, 1)
})

test('replacing the OAuth account does not inherit the previous account claim, key, session or balance', async (t) => {
  const slot = fixture(t)
  slot.repo.upsertOrg(ORG_ID, { display_name: 'Personal', balance: '37.00' })
  slot.repo.upsertAccount(ACCOUNT_ID, {
    vm_id: slot.vmId,
    organization_id: ORG_ID,
    claim_status: 'claimed',
    key_id: 'ek-previous',
    enabled: true,
    storage_state: { cookies: [{ name: 'session', value: 'previous' }] },
    fingerprint: { device: 'previous' },
  })
  writeCodexAccounts(slot.projectRoot, slot.vmId, [
    {
      ...slot.account,
      chatgpt_account_id: 'account-new',
      access_token: jwt({ exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-new' } }),
      id_token: jwt({
        email: 'new@example.test',
        'https://api.openai.com/auth': { chatgpt_account_id: 'account-new', chatgpt_plan_type: 'pro' },
      }),
    },
  ])
  const service = slot.service(async () => assert.fail('view does not perform requests'))
  const current = service.accountForVm(slot.vmId)
  assert.equal(current.accountId, 'account-new')
  const view = service.view(slot.vm())
  assert.equal(view.claim_status, 'unknown')
  assert.equal(view.has_key, false)
  assert.equal(view.enabled, false)
  assert.equal(view.balance, null)
  assert.equal(slot.repo.getAccount(ACCOUNT_ID).key_id, 'ek-previous', 'old account data remains preserved')
})

test('account patches preserve independent key, browser and claim state while balances stay organization-owned', (t) => {
  const slot = fixture(t)
  const storageState = { cookies: [{ name: 'session', value: 'account-private-session' }], origins: [] }
  slot.repo.upsertOrg(ORG_ID, {
    display_name: 'Shared organization',
    project_id: 'proj-vm2api',
    balance: '37.00',
    balance_checked_at: '2099-10-31T00:00:00Z',
  })
  slot.repo.upsertAccount(ACCOUNT_ID, {
    vm_id: slot.vmId,
    organization_id: ORG_ID,
    key_id: 'ek-saved',
    claim_status: 'claimed',
    operation_id: '01234567-89ab-cdef-0123-456789abcdef',
    fingerprint: { navigator: { platform: 'Linux x86_64' } },
    storage_state: storageState,
  })
  slot.repo.upsertAccount(ACCOUNT_ID, { enabled: true, setup_status: 'ready' })
  const saved = slot.repo.getAccount(ACCOUNT_ID)
  assert.equal(saved.claim_status, 'claimed')
  assert.equal(saved.key_id, 'ek-saved')
  assert.deepEqual(saved.storage_state, storageState)
  assert.deepEqual(saved.fingerprint, { navigator: { platform: 'Linux x86_64' } })
  assert.equal(saved.enabled, true)
  slot.repo.upsertAccount('account-second', { organization_id: ORG_ID })
  slot.repo.upsertOrg(ORG_ID, { balance: '31.20' })
  const org = slot.repo.getOrg(saved.organization_id)
  assert.equal(org.balance, '31.20')
  assert.equal(org.project_id, 'proj-vm2api')
  assert.equal(slot.repo.listOrgs().length, 1)
  assert.equal(slot.repo.getAccount('account-second').organization_id, saved.organization_id)
  assert.equal(saved.balance, undefined, 'organization balances are not copied to every account row')
})

test('Platform storageState is encrypted at the DB boundary and transparently restored', (t) => {
  const previousSecret = process.env.VM2API_DB_SECRET
  process.env.VM2API_DB_SECRET = 'isolated-test-secret-for-platform-session'
  t.after(() => {
    if (previousSecret === undefined) delete process.env.VM2API_DB_SECRET
    else process.env.VM2API_DB_SECRET = previousSecret
  })
  const slot = fixture(t)
  const state = { cookies: [{ name: 'session', value: 'never-plain-in-db' }], origins: [] }
  slot.repo.upsertAccount(ACCOUNT_ID, { vm_id: slot.vmId, storage_state: state })
  const raw = slot.repo.db
    .prepare('SELECT storage_state_enc FROM openai_api_accounts WHERE account_id = ?')
    .get(ACCOUNT_ID)
  assert.match(raw.storage_state_enc, /^enc:v1:/)
  assert.equal(raw.storage_state_enc.includes('never-plain-in-db'), false)
  assert.deepEqual(slot.repo.getAccount(ACCOUNT_ID).storage_state, state)
  slot.repo.upsertAccount(ACCOUNT_ID, { enabled: true })
  assert.deepEqual(slot.repo.getAccount(ACCOUNT_ID).storage_state, state)
})
