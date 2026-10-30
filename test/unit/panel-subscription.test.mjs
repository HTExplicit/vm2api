import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDashboard, buildVmDetail, buildVmList } from '../../src/lib/admin/panel-api.mjs'

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

test('panel dashboard, list and detail retain GPT subscription claims without inferring missing dates', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-subscription-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const until = '2027-06-01T12:00:00Z'
  const tokenExpiry = 1_900_000_000
  const slots = [
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
            access_token: jwt({ exp: tokenExpiry }),
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
      assert.equal(view.access_token, undefined)
      assert.equal(view.id_token, undefined)
      assert.equal(view.refresh_token, undefined)
    }
  }
})
