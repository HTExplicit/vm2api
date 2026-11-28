import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  keyLimitsPayload,
  parseModelList,
  type KeyLimitsDraft,
} from './key-payload'

const draft: KeyLimitsDraft = {
  name: ' ops ',
  category: 'api',
  max_concurrency: 4,
  quota_requests: 12,
  quota_usd: 3.5,
  rpm: 60,
  expires_in_days: 30,
  group_type: 'anthropic',
  allowed_vms: ['vm-01', 'vm-01', ' '],
  allowed_models: '',
}

describe('API key limit payload', () => {
  it('saves Gemini as admin-only OAuth without a VM scope', () => {
    const gemini = {
      ...draft,
      category: 'oauth',
      group_type: 'gemini',
      vm_pool_id: '',
    } as const
    for (const mode of ['create', 'edit'] as const) {
      expect(keyLimitsPayload(gemini, mode)).toMatchObject({
        group_type: 'gemini',
        category: 'oauth',
        allowed_vms: [],
        pool_binding_mode: 'legacy_scope',
        default_pool_id: null,
        allowed_pool_ids: [],
        vm_pool_id: null,
      })
    }
    expect(() =>
      keyLimitsPayload(gemini, 'create', { isAdmin: false })
    ).toThrow('只允许管理员')
    expect(() =>
      keyLimitsPayload({ ...gemini, category: 'api' }, 'create')
    ).toThrow('宿主机 OAuth')
  })

  it('keeps request and USD quotas separate', () => {
    expect(keyLimitsPayload(draft, 'create')).toEqual({
      name: 'ops',
      category: 'api',
      max_concurrency: 4,
      quota_requests: 12,
      quota_usd: 3.5,
      rpm: 60,
      expires_in_days: 30,
      group_type: 'anthropic',
      allowed_vms: [],
      vm_pool_id: null,
      allowed_models: [],
    })
  })

  it('splits allowed models on commas, spaces and new lines, deduping by case', () => {
    expect(
      parseModelList(
        ' claude-sonnet-5, gpt-6-sol，CLAUDE-SONNET-5\nclaude-haiku-4-5  '
      )
    ).toEqual(['claude-sonnet-5', 'gpt-6-sol', 'claude-haiku-4-5'])
    expect(parseModelList(' ,  ')).toEqual([])
  })

  it('sends allowed models on create and edit; empty clears the limit', () => {
    const limited = { ...draft, allowed_models: 'claude-sonnet-5, gpt-6-sol' }
    for (const mode of ['create', 'edit'] as const) {
      expect(keyLimitsPayload(limited, mode).allowed_models).toEqual([
        'claude-sonnet-5',
        'gpt-6-sol',
      ])
      expect(
        keyLimitsPayload(limited, mode, { isAdmin: false }).allowed_models
      ).toEqual(['claude-sonnet-5', 'gpt-6-sol'])
    }
    expect(keyLimitsPayload(draft, 'edit').allowed_models).toEqual([])
    const tooMany = Array.from({ length: 201 }, (_, i) => `m-${i}`).join(',')
    expect(() =>
      keyLimitsPayload({ ...draft, allowed_models: tooMany }, 'create')
    ).toThrow('最多 200 个')
  })

  it('sends category and permission fields only for admins', () => {
    const adminPayload = keyLimitsPayload(
      {
        ...draft,
        permission_tier: 'tenant',
        owner_id: 'u_alice',
        allowed_endpoints: ['ep_1', 'ep_1', ' ep_2 '],
        allowed_gemini_envs: ['gem_1', ' '],
      },
      'create',
      { isAdmin: true }
    )
    expect(adminPayload).toMatchObject({
      category: 'api',
      permission_tier: 'tenant',
      owner_id: 'u_alice',
      allowed_endpoints: ['ep_1', 'ep_2'],
      allowed_gemini_envs: ['gem_1'],
    })

    const nonAdmin = keyLimitsPayload(
      {
        ...draft,
        permission_tier: 'tenant',
        owner_id: 'u_alice',
        allowed_endpoints: ['ep_1'],
        allowed_gemini_envs: ['gem_1'],
      },
      'create',
      { isAdmin: false }
    )
    expect(nonAdmin).not.toHaveProperty('category')
    expect(nonAdmin).not.toHaveProperty('permission_tier')
    expect(nonAdmin).not.toHaveProperty('owner_id')
    expect(nonAdmin).not.toHaveProperty('allowed_endpoints')
    expect(nonAdmin).not.toHaveProperty('allowed_gemini_envs')
  })

  it('omits create-only fields from edits and rejects invalid quotas', () => {
    expect(keyLimitsPayload(draft, 'edit')).not.toHaveProperty('name')
    expect(keyLimitsPayload(draft, 'edit')).not.toHaveProperty(
      'expires_in_days'
    )
    expect(() =>
      keyLimitsPayload({ ...draft, quota_requests: 1.5 }, 'create')
    ).toThrow('请求额度')
    expect(() =>
      keyLimitsPayload({ ...draft, quota_usd: -1 }, 'create')
    ).toThrow('USD 额度')
    expect(
      keyLimitsPayload(
        { ...draft, group_type: 'all', allowed_vms: ['vm-01'] },
        'create'
      )
    ).toMatchObject({
      group_type: 'all',
      allowed_vms: [],
    })
    expect(() =>
      keyLimitsPayload(
        { ...draft, category: 'oauth', allowed_vms: [] },
        'create'
      )
    ).toThrow('至少选择一台 VM')
    expect(
      keyLimitsPayload(
        { ...draft, category: 'api', group_type: 'openai', allowed_vms: [] },
        'create'
      )
    ).toMatchObject({
      category: 'api',
      group_type: 'openai',
      allowed_vms: [],
    })
    expect(
      keyLimitsPayload(
        {
          ...draft,
          category: 'all',
          api_endpoint_id: 'ep_tenant',
          group_type: 'anthropic',
          allowed_vms: [],
        },
        'edit'
      )
    ).toMatchObject({
      category: 'all',
      api_endpoint_id: 'ep_tenant',
      group_type: 'anthropic',
      allowed_vms: [],
    })
    expect(
      keyLimitsPayload(
        {
          ...draft,
          category: 'oauth',
          permission_tier: 'tenant',
          owner_id: 'u_alice',
          group_type: 'anthropic',
          allowed_vms: [],
        },
        'edit'
      )
    ).toMatchObject({
      category: 'oauth',
      permission_tier: 'tenant',
      owner_id: 'u_alice',
      group_type: 'anthropic',
      allowed_vms: [],
    })
  })

  it('handles strict_pool & legacy_scope bindings for admin and strips pool fields for non-admin', () => {
    const strictDraft: KeyLimitsDraft = {
      ...draft,
      category: 'oauth',
      group_type: 'all',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_12345678',
      allowed_pool_ids: ['pool_87654321'],
    }

    const adminCreate = keyLimitsPayload(strictDraft, 'create', {
      isAdmin: true,
    })
    expect(adminCreate).toMatchObject({
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_12345678',
      allowed_pool_ids: ['pool_12345678', 'pool_87654321'],
      vm_pool_id: 'pool_12345678',
      group_type: 'all',
      allowed_vms: [],
    })

    // Empty strict_pool fails closed
    expect(() =>
      keyLimitsPayload(
        {
          ...strictDraft,
          default_pool_id: '',
          allowed_pool_ids: [],
        },
        'create',
        { isAdmin: true }
      )
    ).toThrow('至少选择一个分组池')

    // Legacy mode with cleared pool resets pool fields to null / []
    const adminLegacy = keyLimitsPayload(
      {
        ...draft,
        group_type: 'all',
        pool_binding_mode: 'legacy_scope',
        default_pool_id: '',
        allowed_pool_ids: [],
      },
      'edit',
      { isAdmin: true }
    )
    expect(adminLegacy).toMatchObject({
      pool_binding_mode: 'legacy_scope',
      default_pool_id: null,
      allowed_pool_ids: [],
      vm_pool_id: null,
    })

    // Non-admin payload never carries pool fields
    for (const mode of ['create', 'edit'] as const) {
      const tenant = keyLimitsPayload(strictDraft, mode, { isAdmin: false })
      expect(tenant).not.toHaveProperty('pool_binding_mode')
      expect(tenant).not.toHaveProperty('default_pool_id')
      expect(tenant).not.toHaveProperty('allowed_pool_ids')
      expect(tenant).not.toHaveProperty('vm_pool_id')
      expect(tenant.group_type).toBe('all')
    }
  })

  it('keeps the account API group explicit and clears a previous named pool', () => {
    const body = keyLimitsPayload(
      {
        ...draft,
        category: 'oauth',
        group_type: 'openai_apikey',
        allowed_vms: ['gpt-a', 'gpt-a', 'gpt-b'],
        vm_pool_id: 'pool_12345678',
      },
      'edit'
    )
    expect(body).toMatchObject({
      category: 'api',
      group_type: 'openai_apikey',
      allowed_vms: ['gpt-a', 'gpt-b'],
      vm_pool_id: null,
    })
  })

  it('requires configured funded account keys and does not open the group to tenants', () => {
    const apiDraft: KeyLimitsDraft = {
      ...draft,
      group_type: 'openai_apikey',
      allowed_vms: ['gpt-a'],
    }
    const configured = {
      id: 'gpt-a',
      family: 'codex',
      openai_api: { has_key: true, enabled: false, balance: '37.000' },
    } as Vm
    expect(
      keyLimitsPayload(apiDraft, 'create', { vms: [configured] })
    ).toMatchObject({ allowed_vms: ['gpt-a'], category: 'api' })
    expect(() => keyLimitsPayload(apiDraft, 'create', { vms: [] })).toThrow(
      '新增账号需已配置 API key'
    )
    expect(() =>
      keyLimitsPayload({ ...apiDraft, allowed_vms: [] }, 'create')
    ).toThrow('至少选择一个 API 账号')
    expect(() =>
      keyLimitsPayload(apiDraft, 'create', { isAdmin: false })
    ).toThrow('仅管理员')
  })

  it.each(['anthropic', 'openai', 'openai_apikey'] as const)(
    'removes deleted selections when editing a %s key',
    (group_type) => {
      const family = group_type === 'anthropic' ? 'claude' : 'codex'
      const old = {
        id: 'old',
        family,
        openai_api: { has_key: true, balance: '0.000' },
      } as Vm
      const fresh = {
        id: 'fresh',
        family,
        openai_api: { has_key: true, balance: '37.000' },
      } as Vm
      const options = {
        vms: [old, fresh],
        currentAllowedVms: ['deleted', 'old'],
      }

      expect(
        keyLimitsPayload(
          {
            ...draft,
            category: 'oauth',
            group_type,
            allowed_vms: ['deleted', 'fresh'],
          },
          'edit',
          options
        )
      ).toMatchObject({ group_type, allowed_vms: ['fresh'] })
      expect(
        keyLimitsPayload(
          {
            ...draft,
            category: 'oauth',
            group_type,
            allowed_vms: ['deleted', 'old', 'fresh'],
          },
          'edit',
          options
        )
      ).toMatchObject({ group_type, allowed_vms: ['old', 'fresh'] })
    }
  )

  it.each(['anthropic', 'openai', 'openai_apikey'] as const)(
    'requires a selection when all bound %s slots have been deleted',
    (group_type) => {
      expect(() =>
        keyLimitsPayload(
          { ...draft, category: 'oauth', group_type, allowed_vms: ['deleted'] },
          'edit',
          { vms: [], currentAllowedVms: ['deleted'] }
        )
      ).toThrow(
        group_type === 'openai_apikey'
          ? '至少选择一个 API 账号'
          : '至少选择一台 VM'
      )
    }
  )

  it('preserves create scopes and edits without a supplied VM list', () => {
    const scopedDraft = {
      ...draft,
      category: 'oauth' as const,
      allowed_vms: ['deleted', 'vm-01'],
    }
    expect(
      keyLimitsPayload(scopedDraft, 'create', { vms: [{ id: 'vm-01' } as Vm] })
    ).toMatchObject({ allowed_vms: ['deleted', 'vm-01'] })
    expect(keyLimitsPayload(scopedDraft, 'edit')).toMatchObject({
      allowed_vms: ['deleted', 'vm-01'],
    })
  })

  it('accepts configured zero, negative and unknown balances while validating key presence', () => {
    const apiDraft: KeyLimitsDraft = {
      ...draft,
      group_type: 'openai_apikey',
      allowed_vms: ['old'],
    }
    const old = {
      id: 'old',
      family: 'codex',
      openai_api: { has_key: true, balance: '0.000' },
    } as Vm
    const fresh = {
      id: 'fresh',
      family: 'codex',
      plan_type: 'free',
      openai_api: {
        has_key: true,
        balance: '0.0000000000000000001',
        enabled: false,
      },
    } as Vm
    expect(
      keyLimitsPayload(apiDraft, 'edit', {
        vms: [old, fresh],
        currentAllowedVms: ['old'],
      })
    ).toMatchObject({ allowed_vms: ['old'] })
    expect(
      keyLimitsPayload({ ...apiDraft, allowed_vms: ['old', 'fresh'] }, 'edit', {
        vms: [old, fresh],
        currentAllowedVms: ['old'],
      })
    ).toMatchObject({ allowed_vms: ['old', 'fresh'] })
    expect(
      keyLimitsPayload(apiDraft, 'create', {
        vms: [old],
        currentAllowedVms: ['old'],
      })
    ).toMatchObject({ allowed_vms: ['old'] })
    expect(
      keyLimitsPayload({ ...apiDraft, allowed_vms: ['old', 'other'] }, 'edit', {
        vms: [
          old,
          {
            ...old,
            id: 'other',
            openai_api: { ...old.openai_api!, balance: '-2' },
          },
        ],
        currentAllowedVms: ['old'],
      })
    ).toMatchObject({ allowed_vms: ['old', 'other'] })
    expect(
      keyLimitsPayload({ ...apiDraft, allowed_vms: ['unknown'] }, 'create', {
        vms: [
          {
            ...old,
            id: 'unknown',
            openai_api: { ...old.openai_api!, balance: null },
          },
        ],
      })
    ).toMatchObject({ allowed_vms: ['unknown'] })
    expect(() =>
      keyLimitsPayload({ ...apiDraft, allowed_vms: ['missing'] }, 'create', {
        vms: [
          {
            ...old,
            id: 'missing',
            openai_api: { ...old.openai_api!, has_key: false },
          },
        ],
      })
    ).toThrow('新增账号需已配置 API key')
  })
})
