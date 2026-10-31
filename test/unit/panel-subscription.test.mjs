import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDashboard, buildVmDetail, buildVmList } from '../../src/lib/admin/panel-api.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

test('panel dashboard, list and detail retain GPT subscription claims and authentication blocks', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-subscription-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const until = '2027-06-01T12:00:00Z'
  const tokenExpiry = 1_900_000_000
  const slots = [
    ...[
      ['chatgptprolite', 'prolite'],
      ['chatgptpro', 'pro'],
      ['chatgptpromax', 'promax'],
    ].map(([rawPlan, plan]) => ({
      id: `vm-tier-${plan}`,
      platform: 'openai',
      codex: {
        subscription: {
          account_id: `vm-tier-${plan}`,
          active_until: '2028-06-01T12:00:00.000Z',
          plan_type: rawPlan,
          source: 'accounts_check',
          last_success_at: '2026-10-31T00:00:00.000Z',
        },
      },
      claims: { chatgpt_subscription_active_until: until, chatgpt_plan_type: 'plus' },
      expectedUntil: '2028-06-01T12:00:00.000Z',
      expectedPlan: 'plus',
      expectedUsagePlan: plan,
      expectedSource: 'accounts_check',
    })),
    {
      id: 'vm-api-subscription',
      platform: 'openai',
      codex: {
        plan_type: 'team',
        auth_revision: 1,
        auth_block: {
          account_id: 'vm-api-subscription',
          reason: 'upstream_401',
          source: 'subscription',
          status: 401,
          at: '2026-10-31T00:00:00.000Z',
          message: 'OpenAI 认证失败，已停止分配，请刷新凭据',
        },
        subscription: {
          account_id: 'vm-api-subscription',
          active_until: '2028-06-01T12:00:00.000Z',
          plan_type: 'pro',
          source: 'accounts_check',
          last_success_at: '2026-10-31T00:00:00.000Z',
        },
      },
      claims: { chatgpt_subscription_active_until: until, chatgpt_plan_type: 'plus' },
      expectedUntil: '2028-06-01T12:00:00.000Z',
      expectedPlan: 'plus',
      expectedUsagePlan: 'team',
      expectedSource: 'accounts_check',
    },
    {
      id: 'vm-subscription',
      platform: 'openai',
      codex: { plan_type: 'team' },
      claims: { chatgpt_subscription_active_until: until, chatgpt_plan_type: 'plus' },
      expectedUntil: until,
      expectedPlan: 'plus',
      expectedUsagePlan: 'team',
    },
    {
      id: 'vm-no-subscription-date',
      platform: 'openai',
      codex: { extra: { codex_primary_reset_at: until } },
      claims: { chatgpt_plan_type: 'pro' },
      expectedUntil: null,
      expectedPlan: 'pro',
      expectedUsagePlan: null,
    },
    {
      id: 'vm-claude',
      platform: 'anthropic',
      codex: {},
      claims: { chatgpt_subscription_active_until: until, chatgpt_plan_type: 'plus' },
      expectedUntil: null,
      expectedPlan: null,
      expectedUsagePlan: null,
    },
  ]
  for (const slot of slots) {
    const home = path.join(project, 'vms', slot.id)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      path.join(project, 'vms', `${slot.id}.json`),
      JSON.stringify({ id: slot.id, platform: slot.platform, status: 'stopped', codex: slot.codex }),
    )
    fs.writeFileSync(
      path.join(home, 'codex-credentials.json'),
      JSON.stringify({
        accounts: [
          {
            access_token: jwt({
              exp: tokenExpiry,
              'https://api.openai.com/auth': { chatgpt_account_id: slot.id },
            }),
            refresh_token: 'fixture-refresh-secret',
            id_token: jwt({ 'https://api.openai.com/auth': slot.claims }),
            expires_at: tokenExpiry,
          },
        ],
      }),
    )
  }
  const cfg = { paths: { project }, rewrite: {}, base_url: '' }
  const accountQuota = { config: {}, snapshot: () => ({ accounts: [] }) }
  const dashboard = await buildDashboard({
    cfg,
    accountQuota,
    routingConfig: {},
    stickyRouter: { stats: () => ({ active_sessions: 0 }) },
    stats: {},
  })
  const listed = await buildVmList({ cfg, accountQuota })
  assert.equal(dashboard.ok, true)
  assert.equal(listed.ok, true)
  for (const slot of slots) {
    const detail = await buildVmDetail({ cfg, accountQuota, id: slot.id, slotProcessStatus: async () => ({}) })
    assert.equal(detail.ok, true)
    const views = [
      dashboard.data.vms.find((vm) => vm.id === slot.id),
      listed.data.items.find((vm) => vm.id === slot.id),
      detail.data.vm,
    ]
    for (const view of views) {
      assert.equal(view.chatgpt_subscription_active_until, slot.expectedUntil, `${slot.id} subscription date`)
      assert.equal(view.chatgpt_plan_type, slot.expectedPlan, `${slot.id} credential plan`)
      assert.equal(view.plan_type, slot.expectedUsagePlan, `${slot.id} usage plan`)
      if (slot.expectedSource) {
        assert.equal(view.subscription.source, slot.expectedSource)
        assert.equal(view.subscription.active_until, slot.expectedUntil)
        assert.equal(view.subscription.last_success_at, '2026-10-31T00:00:00.000Z')
        assert.equal(view.subscription.account_id, undefined)
      }
      assert.equal(view.access_token, undefined)
      assert.equal(view.id_token, undefined)
      assert.equal(view.refresh_token, undefined)
      if (slot.id === 'vm-api-subscription') {
        assert.equal(view.availability.key, 'bad')
        assert.equal(view.availability.accept, false)
        assert.equal(view.cred_status.key, 'bad')
        assert.equal(view.schedule_state, 'unschedulable')
        assert.equal(view.unschedulable_reason, 'credential_blocked')
        assert.deepEqual(view.unschedulable_detail, {
          reason: 'upstream_401',
          source: 'subscription',
          status: 401,
          at: '2026-10-31T00:00:00.000Z',
          message: 'OpenAI 认证失败，已停止分配，请刷新凭据',
        })
        assert.equal(view.unschedulable_detail.account_id, undefined)
        assert.equal(view.schedulable, true, 'operator scheduling intent is preserved')
      }
    }
  }
})

test('panel schedule enable and cooldown clear cannot release an OpenAI authentication block', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-auth-block-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const id = 'vm-auth-block'
  const vmPath = path.join(project, 'vms', `${id}.json`)
  const block = {
    account_id: id,
    reason: 'upstream_401',
    source: 'inference',
    status: 401,
    at: '2026-10-31T00:00:00.000Z',
    message: '认证失败，已停止分配',
  }
  fs.mkdirSync(path.join(project, 'vms', id), { recursive: true })
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id,
      platform: 'openai',
      status: 'running',
      schedulable: true,
      codex: { auth_revision: 1, auth_block: block },
    }),
  )
  fs.writeFileSync(
    path.join(project, 'vms', id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: id } }) }],
    }),
  )
  const response = {}
  const handle = createPanelHandler({
    cfg: { paths: { project }, vm: { id: null } },
    routingConfig: {},
    accountQuota: { config: {}, snapshot: () => ({ accounts: [] }) },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    readBody: async () => ({ schedulable: true }),
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
  })
  await handle({ method: 'POST' }, {}, new URL(`http://localhost/api/panel/vms/${id}/schedulable`))
  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, 'credential_unavailable')
  await handle({ method: 'POST' }, {}, new URL(`http://localhost/api/panel/vms/${id}/cooldown/clear`))
  assert.equal(response.status, 200)
  const saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.deepEqual(saved.codex.auth_block, block)
  assert.equal(saved.schedulable, true)
})
