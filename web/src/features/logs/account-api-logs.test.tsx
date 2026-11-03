import type { ProviderChainItem, UsageLogRow } from '@/types/panel-usage-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActiveFiltersDisplay } from './filters/active-filters-display'
import { LogicTraceTab } from './log-detail/logic-trace-tab'
import { chainItemName, finalProviderName } from './log-display'
import {
  activeFilterCount,
  filtersToApi,
  filtersToSearch,
  searchToFilters,
  usageLogFiltersQuery,
  validateLogsSearch,
} from './search'

function attempt(
  overrides: Partial<ProviderChainItem> = {}
): ProviderChainItem {
  return {
    attemptNumber: 1,
    vmId: null,
    vmName: null,
    accountId: 'ek_old',
    providerName: 'ek_old',
    model: 'gpt-example',
    selectionReason: 'roundrobin',
    upstreamStatus: 401,
    errorScope: 'credential',
    terminalState: 'rejected',
    action: 'next_unit',
    downstreamCommitted: false,
    waitMs: null,
    queueWaitMs: null,
    schedulingMs: null,
    ttftMs: null,
    latencyMs: 100,
    startedAt: '2026-11-03T12:00:00Z',
    completedAt: '2026-11-03T12:00:00.100Z',
    ...overrides,
  }
}

describe('account API source log links', () => {
  it('preserves source identity through URL, draft, API and export query conversion', () => {
    const search = validateLogsSearch({
      source_account_id: ' account-A ',
      vmId: 'slot-A',
      keyId: 'client-key',
    })
    const draft = searchToFilters(search)
    expect(draft.sourceAccountId).toBe('account-A')
    expect(filtersToSearch(draft)).toEqual({
      source_account_id: 'account-A',
      vmId: 'slot-A',
      keyId: 'client-key',
    })
    const api = filtersToApi(draft, [])
    const query = usageLogFiltersQuery({ ...api, accountId: 'ek_old' })
    expect(query.get('source_account_id')).toBe('account-A')
    expect(query.get('account_id')).toBe('ek_old')
    expect(query.get('vm_id')).toBe('slot-A')
    expect(activeFilterCount(draft)).toBe(3)
  })

  it('omits an empty source filter', () => {
    const search = validateLogsSearch({ source_account_id: ' ' })
    const draft = searchToFilters(search)
    expect(filtersToSearch(draft)).toEqual({})
    expect(
      usageLogFiltersQuery(filtersToApi(draft, [])).has('source_account_id')
    ).toBe(false)
  })

  it('shows the selected account name in a removable source chip', () => {
    const html = renderToStaticMarkup(
      <ActiveFiltersDisplay
        isAdmin
        filters={{ sourceAccountId: 'account-A' }}
        options={{
          users: [],
          keys: [],
          vms: [],
          accounts: [],
          models: [],
          protocols: [],
          endpoints: [],
          statusCodes: [],
          sourceAccounts: [{ id: 'account-A', name: 'saved@example.test' }],
        }}
        onRemove={() => {}}
        onClearAll={() => {}}
      />
    )
    expect(html).toContain('账号 API 来源')
    expect(html).toContain('saved@example.test')
    expect(html).toContain('aria-label="移除筛选"')
  })
})

describe('account API source history display', () => {
  it('uses the captured source email after the original key has been removed', () => {
    const item = attempt({
      sourceEmail: 'saved@example.test',
      sourceAccountId: 'account-A',
    })
    expect(chainItemName(item)).toBe('saved@example.test')
    expect(
      finalProviderName({
        providerChain: [],
        sourceEmail: 'saved@example.test',
        providerName: 'ek_old',
      } as unknown as UsageLogRow)
    ).toBe('saved@example.test')
    expect(
      chainItemName(
        attempt({
          vmId: 'oauth-slot',
          vmName: 'OAuth slot',
          providerName: 'OAuth account',
        })
      )
    ).toBe('OAuth slot')
  })

  it('renders the rejected attempt source and official error without replacing its billing key id', () => {
    const rejected = attempt({
      sourceAccountId: 'account-A',
      sourceVmId: 'slot-A',
      sourceEmail: 'saved@example.test',
      errorCode: 'invalid_api_key',
      errorMessage: 'The key is no longer valid',
    })
    const row = {
      providerChain: [
        rejected,
        attempt({
          attemptNumber: 2,
          accountId: 'ek_other',
          sourceAccountId: 'account-B',
          sourceVmId: 'slot-B',
          sourceEmail: 'other@example.test',
          upstreamStatus: 200,
          terminalState: 'verified',
          downstreamCommitted: true,
        }),
      ],
      statusCode: 200,
      blockedBy: null,
      errorMessage: null,
      durationMs: null,
    } as unknown as UsageLogRow
    const html = renderToStaticMarkup(
      <LogicTraceTab row={row} initialExpandedIndex={0} />
    )
    expect(html).toContain('saved@example.test')
    expect(html).toContain('slot-A')
    expect(html).toContain('invalid_api_key')
    expect(html).toContain('The key is no longer valid')
    expect(html).toContain('ek_old')
    expect(html).toContain('上游 key ID')
    expect(html).toContain('2 个供应商')
    expect(finalProviderName(row)).toBe('other@example.test')
  })
})
