import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('release checks and installer commands use the fork default or explicit repository', async (t) => {
  const previous = process.env.VM2API_GITHUB_REPO
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-source-'))
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '')
  t.after(() => {
    if (previous === undefined) delete process.env.VM2API_GITHUB_REPO
    else process.env.VM2API_GITHUB_REPO = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const [value, expected] of [
    [undefined, 'HTExplicit/vm2api'],
    ['  ', 'HTExplicit/vm2api'],
    [' ExampleOrg/custom.vm2api ', 'ExampleOrg/custom.vm2api'],
  ]) {
    if (value === undefined) delete process.env.VM2API_GITHUB_REPO
    else process.env.VM2API_GITHUB_REPO = value
    const release = await import(`../../src/lib/admin/release.mjs?source=${encodeURIComponent(String(value))}`)
    const status = await release.buildUpdateStatus({
      projectRoot: root,
      currentVersion: '1.4.028',
      fetchImpl: async (url) => {
        assert.equal(url, `https://api.github.com/repos/${expected}/releases/latest`)
        return { ok: true, json: async () => ({ tag_name: 'v1.4.2801' }) }
      },
    })
    assert.equal(status.repo, expected)
    assert.equal(status.html_url, `https://github.com/${expected}/releases/tag/v1.4.2801`)
    assert.equal(status.update_available, true)
    assert.equal(
      status.upgrade_command,
      `curl -sSL https://raw.githubusercontent.com/${expected}/maint/deploy/install.sh | sudo bash -s -- upgrade --version v1.4.2801`,
    )
  }
})
