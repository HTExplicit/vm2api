import { describe, expect, it } from 'vitest'
import { REPO_URL, UPGRADE_COMMAND } from './repo'

describe('fork release source', () => {
  it('uses the fork for repository links and the fallback upgrade command', () => {
    expect(REPO_URL).toBe('https://github.com/HTExplicit/vm2api')
    expect(UPGRADE_COMMAND).toBe(
      'curl -sSL https://raw.githubusercontent.com/HTExplicit/vm2api/maint/deploy/install.sh | sudo bash -s -- upgrade'
    )
  })
})
