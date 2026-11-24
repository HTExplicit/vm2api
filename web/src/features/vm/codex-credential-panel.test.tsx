import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CodexCredentialPanel } from './codex-credential-panel'

function render(role: 'admin' | 'user' | 'super', patch: Partial<Vm> = {}) {
  const client = new QueryClient()
  client.setQueryData(['panel', 'me'], { user: 'operator', role })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CodexCredentialPanel
        vm={{ id: 'slot-new', family: 'codex', platform: 'openai', ...patch }}
      />
    </QueryClientProvider>
  )
  client.clear()
  return html
}

describe('OpenAI credential entry points', () => {
  it('adds the browser login for administrators and keeps link and file login', () => {
    const html = render('admin')
    expect(html).toContain('浏览器登录')
    expect(html).toContain('使用本槽固定身份与绑定代理')
    expect(html).toContain('生成授权链接')
    expect(html).toContain('账号文件')
    expect(html).not.toContain('更换账号')
  })

  it('offers SIWC management to administrators of an existing GPT slot', () => {
    const connected = {
      has_token: true,
      codex_siwc: {
        enabled: true,
        bound: true,
        status: 'ready',
        has_token: true,
        expires_at: null,
        next_refresh_at: null,
        models: [{ id: 'gpt-5.4', name: 'GPT 5.4', visible: true }],
      },
    }
    const admin = render('admin', connected)
    expect(admin).toContain('在槽位浏览器重新绑定')
    expect(admin).toContain('手动授权')
    expect(admin).toContain('切回普通 Codex')
    expect(admin).toContain('本地解绑')
    expect(admin).toContain('GPT 5.4')
    expect(render('user', connected)).not.toContain('Sign in with ChatGPT')
    expect(render('admin')).not.toContain('Sign in with ChatGPT')
  })

  it('keeps the new browser operation out of non-admin credential panels', () => {
    for (const role of ['user', 'super'] as const) {
      const html = render(role)
      expect(html).not.toContain('浏览器登录')
      expect(html).toContain('生成授权链接')
    }
  })
})
