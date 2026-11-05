import type { UsageLogRow } from '@/types/panel-usage-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ModelDisplayWithRedirect } from './log-cells'
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
    <ModelDisplayWithRedirect
      row={{ ...historicalRow, ...overrides }}
      onRedirectClick={() => {}}
    />
  )
}

describe('separate sent and returned model display', () => {
  it('keeps historical observations unknown without reusing the primary model or old mismatch', () => {
    const html = cell()
    expect(html).toContain('legacy-model')
    expect(html).toContain('发送：未知')
    expect(html).toContain('上游返回：未知')
    expect(html).not.toContain('发送与上游返回的模型名称不同')
  })

  it('shows both observations even when they are equal', () => {
    const html = cell({ sentModel: 'model-a', actualResponseModel: 'model-a' })
    expect(html).toContain('发送：model-a')
    expect(html).toContain('上游返回：model-a')
    expect(html).not.toContain('发送与上游返回的模型名称不同')
  })

  it('shows the upstream declaration and names the difference without making a billing claim', () => {
    const html = cell({ sentModel: 'model-a', actualResponseModel: 'model-b' })
    expect(html).toContain('发送：model-a')
    expect(html).toContain('上游返回：model-b')
    expect(html).toContain('发送与上游返回的模型名称不同')
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
