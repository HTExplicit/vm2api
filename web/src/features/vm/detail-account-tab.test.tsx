import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CodexSiwcState, Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fmtExpiresAt } from '@/lib/format'
import { Tabs } from '@/components/ui/tabs'
import { VmAccountTab } from './detail-account-tab'

const codexExpiry = Date.parse('2026-11-27T09:00:00Z')
const siwcExpiry = Date.parse('2026-11-27T10:00:00Z')
const subscriptionExpiry = '2026-12-31T00:00:00Z'
const grant: CodexSiwcState = {
  bound: true,
  enabled: false,
  status: 'ready',
  expires_at: siwcExpiry,
  next_refresh_at: 0,
  has_token: true,
  models: null,
}

function render(patch: Partial<Vm> = {}) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['panel', 'me'], { user: 'operator', role: 'admin' })
  const vm: Vm = {
    id: 'gpt-slot',
    family: 'codex',
    platform: 'openai',
    has_token: true,
    codex_access_expires_at: codexExpiry,
    codex_siwc: grant,
    chatgpt_subscription_active_until: subscriptionExpiry,
    ...patch,
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Tabs value='account'>
        <VmAccountTab
          id={vm.id}
          vm={vm}
          acc={{}}
          dash={{ data: undefined }}
          credType='none'
          officialCc={false}
          u5={0}
          u7={0}
          tierKey='none'
          todayReadCache={0}
          todayWriteCache={0}
          todayHit={null}
          today={{ requests: 0, input: 0, output: 0 }}
          canRefresh={false}
          refreshBlocked=''
          busy={() => false}
          onNeedProxy={() => {}}
          onAction={() => {}}
          onCredentialCommitted={() => {}}
        />
      </Tabs>
    </QueryClientProvider>
  )
  queryClient.clear()
  return html
}

function fieldValue(html: string, label: string) {
  return html.match(new RegExp(label + '</div><div[^>]*>([^<]*)'))?.[1]
}

describe('GPT slot credential expiry', () => {
  it('shows both access expiries and a separate subscription with SIWC disabled', () => {
    const html = render()
    expect(fieldValue(html, 'Codex 令牌到期')).toBe(fmtExpiresAt(codexExpiry))
    expect(fieldValue(html, 'SIWC 令牌到期')).toBe(fmtExpiresAt(siwcExpiry))
    expect(html).toContain('订阅到期')
    expect(html).toContain(fmtExpiresAt(subscriptionExpiry))
  })

  it('distinguishes an unbound grant from one with an unknown expiry', () => {
    expect(fieldValue(render({ codex_siwc: null }), 'SIWC 令牌到期')).toBe(
      '未绑定'
    )
    const html = render({
      codex_access_expires_at: null,
      codex_siwc: { ...grant, expires_at: null },
      expires_at: new Date(siwcExpiry).toISOString(),
    })
    expect(fieldValue(html, 'Codex 令牌到期')).toBe('未知')
    expect(fieldValue(html, 'SIWC 令牌到期')).toBe('未知')
  })

  it('shows backoff and handles an immediately due renewal', () => {
    const retryAt = Date.parse('2099-11-27T10:00:00Z')
    const html = render({
      codex_siwc: {
        ...grant,
        status: 'refresh_backoff',
        next_refresh_at: retryAt,
      },
    })
    expect(html).toContain('等待重试续期')
    expect(html).toContain(fmtExpiresAt(retryAt))
    expect(render()).toContain('已到续期时间')
  })
})
