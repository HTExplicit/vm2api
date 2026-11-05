import type { UsageLogRow } from '@/types/panel-usage-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RequestResponseModelDisplay } from './log-cells'
import { SummaryTab } from './log-detail/summary-tab'

const historicalRow: UsageLogRow = {
  id: 'old-log',
  requestId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  userId: null,
  userName: null,
  keyId: null,
  keyName: null,
  sessionId: null,
  clientSessionId: null,
  inboundDeviceId: null,
  providerName: null,
  accountId: null,
  vmId: null,
  vmName: null,
  model: 'legacy-model',
  originalModel: 'client-alias',
  sentModel: null,
  actualResponseModel: null,
  modelMismatch: 1,
  endpoint: '/v1/responses',
  protocol: 'openai.responses',
  method: 'POST',
  statusCode: 200,
  logMode: 'normal',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: null,
  cacheCreation5mInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheTtlApplied: null,
  totalTokens: 0,
  costUsd: null,
  actualCostUsd: null,
  costBreakdown: null,
  groupCostMultiplier: null,
  durationMs: null,
  firstByteMs: null,
  ttftMs: null,
  generationMs: null,
  stopReason: null,
  attemptCount: null,
  finalState: null,
  via: null,
  stream: null,
  hasTools: null,
  serviceTier: null,
  upstreamServiceTier: null,
  speed: null,
  context1mApplied: null,
  reasoningEffort: null,
  errorClass: null,
  errorLabel: null,
  errorOwner: null,
  errorCode: null,
  errorMessage: null,
  jevState: null,
  blockedBy: null,
  blockedReason: null,
  userAgent: null,
  clientIp: null,
  apiKeyPresented: null,
  specialSettings: [],
  providerChain: [],
}

function cell(overrides: Partial<UsageLogRow> = {}) {
  return renderToStaticMarkup(
    <RequestResponseModelDisplay row={{ ...historicalRow, ...overrides }} />
  )
}

describe('requested and returned model display', () => {
  it('uses the historical model only for a missing request name and keeps the upstream return unknown', () => {
    const html = cell({ originalModel: null })
    expect(html).toContain('legacy-model')
    expect(html).toContain('未知')
    expect(html).not.toContain('client-alias')
    expect(html).not.toContain('发送')
    expect(html.match(/legacy-model/g)).toHaveLength(1)
  })

  it('keeps both lines when the request and upstream return names are equal', () => {
    const html = cell({
      originalModel: 'model-a',
      sentModel: 'model-a',
      actualResponseModel: 'model-a',
    })
    expect(html).toContain('model-a')
    expect(html).not.toContain('发送')
    expect(html.match(/model-a/g)).toHaveLength(2)
  })

  it('shows the request alias and upstream return while omitting the sent target', () => {
    const html = cell({
      originalModel: 'alias-a',
      sentModel: 'sent-model-b',
      actualResponseModel: 'returned-model-c',
    })
    expect(html).toContain('alias-a')
    expect(html).toContain('returned-model-c')
    expect(html).not.toContain('sent-model-b')
    expect(html).not.toContain('legacy-model')
    expect(html).not.toContain('发送')
    expect(html).not.toContain('计费仍然基于')
  })

  it.each([
    {
      sentModel: null,
      actualResponseModel: null,
      sent: '未知',
      returned: '未知',
    },
    {
      sentModel: 'model-a',
      actualResponseModel: 'model-a',
      sent: 'model-a',
      returned: 'model-a',
    },
    {
      sentModel: 'model-a',
      actualResponseModel: 'model-b',
      sent: 'model-a',
      returned: 'model-b',
    },
  ])(
    'always shows all three model sources in details: $sent / $returned',
    ({ sentModel, actualResponseModel, sent, returned }) => {
      const html = renderToStaticMarkup(
        <SummaryTab
          row={{ ...historicalRow, sentModel, actualResponseModel }}
          scrollToRedirect={false}
        />
      )
      const text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, '')
      expect(text).toContain(
        `请求模型client-alias发送模型${sent}上游返回模型${returned}`
      )
      expect(text).not.toContain('计费:实际')
      expect(text).not.toContain('实际响应模型')
    }
  )
})
