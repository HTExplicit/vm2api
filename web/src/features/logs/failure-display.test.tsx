import type { UsageLogRow } from '@/types/panel-usage-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { StatusBadge } from './log-cells'
import { FailureDiagnosticsPanel } from './log-detail/failure-diagnostics'

describe('failure display', () => {
  it('makes a classified stream failure visible beside its original HTTP code', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <StatusBadge
          statusCode={200}
          finalState='incomplete'
          errorClass='transport'
          errorLabel='传输中断'
          errorCode='ECONNRESET'
        />
      </TooltipProvider>
    )
    expect(html).toContain('传输中断')
    expect(html).toContain('HTTP 200')
    expect(html).not.toContain('bg-green-100')
  })

  it('shows observed stage and copy controls without native output or invented root cause', () => {
    const row = {
      requestId: 'request-one',
      failureDiagnostics: {
        component: 'codex-kernel',
        phase: 'stream',
        kernelRunId: 'run-one',
        lastEventType: 'response.output_text.delta',
        lastEventAgoMs: 1000,
        responseCommitted: true,
        usageState: 'partial',
      },
    } as UsageLogRow
    const html = renderToStaticMarkup(<FailureDiagnosticsPanel row={row} />)
    expect(html).toContain('读取响应流')
    expect(html).toContain('仅取得部分用量')
    expect(html).toContain('复制请求 ID')
    expect(html).toContain('复制内核运行 ID')
    expect(html).toContain('根因需结合服务器内核日志确认')
    expect(html).not.toContain('stdout')
  })
})
