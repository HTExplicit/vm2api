import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CodexCredentialPanel } from './codex-credential-panel'

function render(role: 'admin' | 'user' | 'super') {
  const client = new QueryClient()
  client.setQueryData(['panel', 'me'], { user: 'operator', role })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CodexCredentialPanel
        vm={{ id: 'slot-new', family: 'codex', platform: 'openai' }}
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

  it('keeps the new browser operation out of non-admin credential panels', () => {
    for (const role of ['user', 'super'] as const) {
      const html = render(role)
      expect(html).not.toContain('浏览器登录')
      expect(html).toContain('生成授权链接')
    }
  })
})
