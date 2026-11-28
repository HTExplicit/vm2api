import test from 'node:test'
import assert from 'node:assert/strict'
import { detectInboundPlatform } from '../../src/lib/protocol/platform-detect.mjs'
import {
  applyCodexInboundModelRewrite,
  DEFAULT_CODEX_MODEL_MAPPING_FALLBACK,
  DEFAULT_CODEX_MODEL_MAPPINGS,
  normalizeCodexModelMappings,
  validateCodexModelMappingTarget,
  validateCodexModelMappingsPatch,
} from '../../src/lib/protocol/codex-model-mapping.mjs'
import { normalizeCodexRouting } from '../../src/lib/protocol/codex-route.mjs'
import { toCodexResponses } from '../../src/lib/protocol/codex-convert.mjs'
import { listGptPublicModels } from '../../src/lib/protocol/models.mjs'
import { formatSiwcBody } from '../../src/lib/transport/siwc-responses.mjs'
import {
  resetGptModelPolicy,
  saveGptModelPolicy,
  syncGptIdsIntoPolicy,
} from '../../src/lib/protocol/gpt-model-policy.mjs'

test('default map rewrites codex-auto-review before platform detect', () => {
  resetGptModelPolicy()
  const rewrite = applyCodexInboundModelRewrite({ model: 'codex-auto-review' }, {})
  assert.equal(rewrite.ok, true)
  assert.equal(rewrite.mapped, true)
  assert.equal(rewrite.requestedModel, 'codex-auto-review')
  assert.equal(rewrite.upstreamModel, DEFAULT_CODEX_MODEL_MAPPINGS['codex-auto-review'])
  const platform = detectInboundPlatform(rewrite.body.model)
  assert.equal(platform.ok, true)
  assert.equal(platform.platform, 'openai')
  assert.equal(platform.model, 'gpt-6-luna')
})

test('literal detectInboundPlatform still fail-closes codex-auto-review', () => {
  assert.equal(detectInboundPlatform('codex-auto-review').ok, false)
})

test('custom routing.model_mappings overrides default target', () => {
  resetGptModelPolicy()
  const routing = { codex: { model_mappings: { 'codex-auto-review': 'gpt-6-sol' } } }
  const rewrite = applyCodexInboundModelRewrite({ model: 'codex-auto-review' }, routing)
  assert.equal(rewrite.upstreamModel, 'gpt-6-sol')
  assert.equal(detectInboundPlatform(rewrite.body.model).platform, 'openai')
})

test('Fast aliases rewrite to the base model and force priority', () => {
  resetGptModelPolicy()
  syncGptIdsIntoPolicy([{ id: 'gpt-6-luna', catalog: { service_tiers: [{ id: 'priority', name: 'fast' }] } }])
  saveGptModelPolicy({
    models: {
      'gpt-6-luna': {
        enabled: true,
        expose_fast: true,
      },
    },
  })
  const rewrite = applyCodexInboundModelRewrite({ model: 'gpt-6-luna-fast', service_tier: 'flex' }, {})
  assert.equal(rewrite.ok, true)
  assert.equal(rewrite.body.model, 'gpt-6-luna')
  assert.equal(rewrite.body.service_tier, 'priority')
  assert.equal(rewrite.requestedModel, 'gpt-6-luna-fast')
  assert.deepEqual(validateCodexModelMappingTarget('gpt-6-luna-fast'), {
    ok: true,
    target: 'gpt-6-luna',
    service_tier: 'priority',
    alias: 'gpt-6-luna-fast',
  })
})

test('explicit Ultrafast aliases are listed and converted alongside Fast and standard', () => {
  resetGptModelPolicy()
  const model = 'gpt-6.2-sol'
  const fast = `${model}-fast`
  const ultrafast = `${model}-ultrafast`
  const tiers = { service_tiers: [{ id: 'priority', name: 'Fast' }] }
  syncGptIdsIntoPolicy([
    { id: model, catalog: tiers },
    { id: 'gpt-6-luna', catalog: tiers },
  ])
  saveGptModelPolicy({ models: { [model]: { enabled: true, expose_fast: true } } })
  assert.equal(applyCodexInboundModelRewrite({ model: ultrafast }).code, 'model_ultrafast_unavailable')
  assert.equal(
    listGptPublicModels().some((row) => row.id === ultrafast),
    false,
  )

  saveGptModelPolicy({
    models: {
      [model]: { enabled: true, expose_fast: true, expose_ultrafast: true },
      'gpt-6-luna': { enabled: true, expose_ultrafast: true },
    },
  })
  syncGptIdsIntoPolicy([
    { id: model, catalog: tiers },
    { id: 'gpt-6-luna', catalog: tiers },
  ])
  const models = new Map(listGptPublicModels().map((row) => [row.id, row]))
  assert.equal(models.get(fast)?.service_tier, 'priority')
  assert.equal(models.get(ultrafast)?.service_tier, 'ultrafast')
  assert.equal(models.has('gpt-6-luna-ultrafast'), false)

  for (const [id, tier] of [
    [model, 'default'],
    [fast, 'priority'],
    [ultrafast, 'ultrafast'],
  ]) {
    const request = { model: id, input: 'ping', service_tier: 'default' }
    const rewritten = applyCodexInboundModelRewrite(request)
    assert.equal(rewritten.ok, true)
    assert.equal(rewritten.body.model, model)
    assert.equal(rewritten.body.service_tier, tier)
    const converted = toCodexResponses('openai.responses', request)
    assert.equal(converted.ok, true)
    assert.equal(formatSiwcBody(converted.body).model, model)
    assert.equal(formatSiwcBody(converted.body).service_tier, tier)
  }

  saveGptModelPolicy({ models: { [model]: { enabled: false } } })
  assert.equal(applyCodexInboundModelRewrite({ model: ultrafast }).code, 'model_disabled')
  assert.equal(
    listGptPublicModels().some((row) => row.id === ultrafast),
    false,
  )
})

test('unavailable Fast aliases fail locally and mapping keys take precedence', () => {
  resetGptModelPolicy()
  const unavailable = applyCodexInboundModelRewrite({ model: 'gpt-6-luna-fast' }, {})
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.code, 'model_fast_unavailable')
  const mapped = applyCodexInboundModelRewrite(
    { model: 'gpt-6-luna-fast' },
    { codex: { model_mappings: { 'gpt-6-luna-fast': 'gpt-6-sol' } } },
  )
  assert.equal(mapped.ok, true)
  assert.equal(mapped.body.model, 'gpt-6-sol')
})

test('actual GPT catalog ids cannot be mapping aliases', () => {
  resetGptModelPolicy()
  assert.throws(
    () => validateCodexModelMappingsPatch({ 'gpt-6-luna': 'gpt-6-sol' }),
    (error) => error.code === 'invalid_codex_model_mappings',
  )
})

test('empty configured target for codex-auto-review uses fallback sol model', () => {
  resetGptModelPolicy()
  const mappings = normalizeCodexModelMappings({ 'codex-auto-review': '' })
  assert.equal(mappings['codex-auto-review'], DEFAULT_CODEX_MODEL_MAPPING_FALLBACK)
  const rewrite = applyCodexInboundModelRewrite(
    { model: 'codex-auto-review' },
    { codex: { model_mappings: { 'codex-auto-review': '' } } },
  )
  assert.equal(rewrite.upstreamModel, DEFAULT_CODEX_MODEL_MAPPING_FALLBACK)
})

test('invalid non-GPT mapping target returns codex_model_mapping_invalid', () => {
  resetGptModelPolicy()
  const rewrite = applyCodexInboundModelRewrite(
    { model: 'codex-auto-review' },
    { codex: { model_mappings: { 'codex-auto-review': 'claude-sonnet-4-6' } } },
  )
  assert.equal(rewrite.ok, false)
  assert.equal(rewrite.code, 'codex_model_mapping_invalid')
})

test('disabled GPT mapping target returns model_disabled', () => {
  resetGptModelPolicy()
  saveGptModelPolicy({
    models: {
      'gpt-6-luna': { id: 'gpt-6-luna', enabled: false },
    },
  })
  const check = validateCodexModelMappingTarget('gpt-6-luna')
  assert.equal(check.ok, false)
  assert.equal(check.code, 'model_disabled')
  const rewrite = applyCodexInboundModelRewrite({ model: 'codex-auto-review' }, {})
  assert.equal(rewrite.ok, false)
  assert.equal(rewrite.code, 'model_disabled')
})

test('normalizeCodexRouting hot-loads model_mappings defaults', () => {
  const codex = normalizeCodexRouting({})
  assert.equal(codex.model_mappings['codex-auto-review'], 'gpt-6-luna')
})

test('mapping patch rejects aliases that would hijack Claude or image requests', () => {
  resetGptModelPolicy()
  for (const alias of [
    'claude-opus-5-5',
    'anthropic.claude-sonnet-5',
    'sonnet-5',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst-2026-09-08',
    'my alias',
    'tab\talias',
  ]) {
    assert.throws(
      () => validateCodexModelMappingsPatch({ [alias]: 'gpt-6-luna' }),
      (error) => error.code === 'invalid_codex_model_mappings',
      alias,
    )
  }
})

test('mapping patch accepts plain aliases and codex-auto-review', () => {
  resetGptModelPolicy()
  assert.doesNotThrow(() =>
    validateCodexModelMappingsPatch({
      'codex-auto-review': 'gpt-6-sol',
      'my-fast': 'gpt-6-luna',
      'gpt-5': 'gpt-6-luna',
    }),
  )
  assert.doesNotThrow(() => validateCodexModelMappingsPatch({ 'codex-auto-review': null }))
})

test('stored invalid aliases are kept on normalize; only new writes are rejected', () => {
  const merged = normalizeCodexModelMappings({ 'claude-x': 'gpt-6-luna' })
  assert.equal(merged['claude-x'], 'gpt-6-luna')
})

test('mapping patch rejects a disabled GPT target with model_disabled', () => {
  resetGptModelPolicy()
  saveGptModelPolicy({ models: { 'gpt-6-sol': { id: 'gpt-6-sol', enabled: false } } })
  assert.throws(
    () => validateCodexModelMappingsPatch({ 'codex-auto-review': 'gpt-6-sol' }),
    (error) => error.code === 'model_disabled',
  )
  resetGptModelPolicy()
})
