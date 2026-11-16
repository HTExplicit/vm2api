import { REPO_URL } from '@/config/repo'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareVersions,
  fetchLatestRelease,
  hasNewerRelease,
} from './release-check'

afterEach(() => vi.unstubAllGlobals())

describe('release-check', () => {
  it('compares numeric segments, not strings', () => {
    expect(compareVersions('1.4.110', '1.4.109')).toBeGreaterThan(0)
    expect(compareVersions('v1.4.9', '1.4.10')).toBeLessThan(0)
    expect(compareVersions('1.4.109-rc.1', '1.4.109')).toBe(0)
    expect(compareVersions('1.4.11301', '1.4.11001')).toBeGreaterThan(0)
  })

  it('reports newer release unless that version was dismissed', () => {
    const latest = { version: '1.4.110', url: 'u' }
    expect(hasNewerRelease('1.4.109', latest, null)).toBe(true)
    expect(hasNewerRelease('1.4.110', latest, null)).toBe(false)
    expect(hasNewerRelease('1.4.109', latest, '1.4.110')).toBe(false)
    // 关闭的是旧版本提示，再出更新的版本仍要提示
    expect(hasNewerRelease('1.4.109', latest, '1.4.109')).toBe(true)
    expect(hasNewerRelease(undefined, latest, null)).toBe(false)
  })

  it('checks the fork release and uses its release link', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'v1.4.11301',
        html_url: `${REPO_URL}/releases/tag/v1.4.11301`,
      }),
    })
    vi.stubGlobal('fetch', fetch)
    const latest = await fetchLatestRelease(REPO_URL)
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/HTExplicit/vm2api/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' } }
    )
    expect(latest).toEqual({
      version: '1.4.11301',
      url: `${REPO_URL}/releases/tag/v1.4.11301`,
    })
    expect(hasNewerRelease('1.4.11001', latest, null)).toBe(true)
    expect(hasNewerRelease('1.4.11001', latest, '1.4.11301')).toBe(false)
  })
})
