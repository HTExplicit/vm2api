import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultRedaction, normalizeRedaction } from '../../src/lib/redaction/policy.mjs'

describe('redaction policy', () => {
  it('treats a missing block as off without inventing protection', () => {
    assert.deepEqual(normalizeRedaction(undefined), defaultRedaction())
  })

  it('rejects coerced booleans and unknown fields', () => {
    assert.throws(() => normalizeRedaction({ enabled: 'false', secrets: true, personal: true }), /enabled/)
    assert.throws(() => normalizeRedaction({ enabled: false, secrets: true, personal: true, shape: true }), /unknown/)
  })

  it('rejects an enabled policy with nothing to protect', () => {
    assert.throws(
      () => normalizeRedaction({ enabled: true, secrets: false, personal: false, words: ['  '], rules: [] }),
      /requires/,
    )
  })

  it('keeps words when the switch is off and drops blanks', () => {
    assert.deepEqual(
      normalizeRedaction({
        enabled: false,
        secrets: true,
        personal: false,
        words: [' 夜莺 ', '夜莺', ''],
        rules: [],
      }),
      {
        enabled: false,
        secrets: true,
        personal: false,
        words: ['夜莺'],
        wordsAnyCase: false,
        rules: [],
        kinds: {},
        allow: [],
      },
    )
  })

  it('keeps kind overrides, case folding, and the allow list', () => {
    const policy = normalizeRedaction({
      enabled: true,
      secrets: true,
      personal: true,
      words: ['Nightjar'],
      wordsAnyCase: true,
      rules: [{ kind: 'GATEWAY_KEY', prefix: 'oc_sk_' }],
      kinds: { ip: true, home: false },
      allow: [' build-01 '],
    })
    const { wordsAnyCase, kinds, allow, rules } = policy
    assert.deepEqual(
      { wordsAnyCase, kinds, allow, rules },
      {
        wordsAnyCase: true,
        kinds: { ip: true, home: false },
        allow: ['build-01'],
        rules: [{ kind: 'GATEWAY_KEY', prefix: 'oc_sk_', regex: '' }],
      },
    )
  })
})
