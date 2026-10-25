import test from 'node:test'
import assert from 'node:assert/strict'
import { ccEntrypointFromRouting, buildBillingAttributionText } from '../../src/lib/identity/crs-persona.mjs'
import { officialClaudeCliUa, OFFICIAL_CLAUDE_CLI_UA } from '../../src/lib/identity/vm-identity.mjs'
import { renderOfficial303Guidance } from '../../src/lib/identity/official-profiles.mjs'
import { buildOutboundProfile } from '../../src/lib/admin/outbound-profile.mjs'

test('missing or invalid entrypoint defaults to cli across billing, UA and reference', () => {
  for (const value of [undefined, null, '', 'vscode', 'cli']) {
    const routing = { compatibility: { cc_entrypoint: value } }
    assert.equal(ccEntrypointFromRouting(routing), 'cli')
    const profile = buildOutboundProfile(routing)
    assert.equal(profile.cc_entrypoint, 'cli')
    assert.equal(profile.user_agent, officialClaudeCliUa(undefined, 'cli'))
  }
  assert.equal(ccEntrypointFromRouting(), 'cli')
  assert.equal(officialClaudeCliUa(), OFFICIAL_CLAUDE_CLI_UA)
  assert.match(OFFICIAL_CLAUDE_CLI_UA, /\(external, cli\)$/)
  assert.match(buildBillingAttributionText('hello'), /cc_entrypoint=cli;/)
  assert.equal(renderOfficial303Guidance(), renderOfficial303Guidance({ entrypoint: 'cli' }))
})

test('explicit sdk-cli remains supported without changing the default', () => {
  const routing = { compatibility: { cc_entrypoint: 'sdk-cli' } }
  assert.equal(ccEntrypointFromRouting(routing), 'sdk-cli')
  assert.equal(buildOutboundProfile(routing).user_agent, officialClaudeCliUa(undefined, 'sdk-cli'))
  assert.match(buildBillingAttributionText('hello', undefined, '', null, 'sdk-cli'), /cc_entrypoint=sdk-cli;/)
  assert.notEqual(renderOfficial303Guidance(), renderOfficial303Guidance({ entrypoint: 'sdk-cli' }))
})
