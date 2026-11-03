import { describe, expect, it } from 'vitest'
import { navGroupsFor } from './sidebar-data'

describe('sidebar permissions', () => {
  it('does not treat an explicit empty view list as unrestricted', () => {
    expect(navGroupsFor([])).toEqual([])
  })

  it('shows only routes named by the panel capability list', () => {
    const groups = navGroupsFor(['overview', 'logs'])
    const urls = groups.flatMap((group) => group.items.map((item) => item.url))

    expect(urls).toEqual(['/overview', '/logs'])
  })

  it('shows account API management only with its own view capability', () => {
    expect(
      navGroupsFor(['vm', 'keys']).flatMap((group) =>
        group.items.map((item) => item.url)
      )
    ).not.toContain('/openai-apikey')
    const items = navGroupsFor(['openai-apikey']).flatMap(
      (group) => group.items
    )
    expect(items).toEqual([
      expect.objectContaining({ title: 'OpenAiAPIKEY', url: '/openai-apikey' }),
    ])
  })

  it('keeps the monitoring pages together in hub order', () => {
    // A stale `usage` capability from an older server must not resurrect the removed page.
    const groups = navGroupsFor([
      'usage',
      'logs',
      'statistics',
      'overview',
      'vm',
    ])

    expect(groups[0].title).toBe('监控')
    expect(groups[0].items.map((item) => item.url)).toEqual([
      '/overview',
      '/statistics',
      '/logs',
    ])
    expect(groups[1].items.map((item) => item.url)).toEqual(['/vm'])
  })
})
