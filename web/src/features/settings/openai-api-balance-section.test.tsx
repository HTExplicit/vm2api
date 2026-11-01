import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OpenaiApiBalanceSection } from './openai-api-balance-section'
import { OpenaiPane } from './openai-pane'

vi.mock('./openai-quota-section', () => ({ OpenaiQuotaSection: () => null }))

describe('account API balance refresh settings', () => {
  it('shows the default interval and preserves explicit manual-only zero', () => {
    const defaults = renderToStaticMarkup(
      <OpenaiApiBalanceSection value={{}} onChange={() => {}} />
    )
    expect(defaults).toContain('每 10 分钟')
    expect(defaults).toContain('value="10"')
    const manual = renderToStaticMarkup(
      <OpenaiApiBalanceSection
        value={{ balance_refresh_interval_minutes: 0 }}
        onChange={() => {}}
      />
    )
    expect(manual).toContain('仅手动刷新')
    expect(manual).toContain('value="0"')
    expect(manual).toContain('min="0"')
    expect(manual).toContain('max="1440"')
  })

  it('is editable with OAuth routing disabled and disables editing only while saving', () => {
    const props = {
      codex: { enabled: false },
      websocket: {},
      openaiApi: { balance_refresh_interval_minutes: 30 },
      onCodexChange: () => {},
      onWebsocketChange: () => {},
      onOpenaiApiChange: () => {},
    }
    const active = renderToStaticMarkup(<OpenaiPane {...props} />)
    const intervalInput = active.match(
      /<input[^>]*aria-label="余额刷新间隔（分钟）"[^>]*>/
    )?.[0]
    expect(active).toContain('每 30 分钟')
    expect(intervalInput).toBeTruthy()
    expect(intervalInput).not.toContain(' disabled=""')
    const saving = renderToStaticMarkup(<OpenaiPane {...props} saving />)
    expect(
      saving.match(/<input[^>]*aria-label="余额刷新间隔（分钟）"[^>]*>/)?.[0]
    ).toContain(' disabled=""')
  })
})
