import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PERSONA_PRESETS,
  DEFAULT_PERSONA_TEMPLATES,
  canonicalPersonaCompat,
  normalizePersonaPreset,
  validatePersonaTemplate,
} from '../../src/lib/identity/persona-template.mjs'
import {
  applyCrsUnofficialPersona,
  callerPersonaInputForAttempt,
  personaPreviewVars,
} from '../../src/lib/identity/crs-persona.mjs'
import { OFFICIAL_303_ENV_INSTRUCTIONS, profileForPreset } from '../../src/lib/identity/official-profiles.mjs'
import { normalizeSlotPersonaPreset } from '../../src/lib/vm/slot-engine.mjs'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'

function render(compat, body = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-regions-'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { overlay_preset: 'off', ...compat } }))
  try {
    return applyCrsUnofficialPersona(
      {
        model: 'claude-opus-5-5',
        system: 'CALLER_PROMPT',
        messages: [{ role: 'user', content: 'hello' }],
        ...body,
      },
      {
        routingFile,
        identity: { timezone: 'Asia/Tokyo', locale: 'zh-CN' },
      },
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const environment = (body) =>
  body.messages
    .filter((message) => message.role === 'system')
    .map((message) =>
      typeof message.content === 'string' ? message.content : message.content.map((block) => block.text).join('\n'),
    )
    .join('\n')
const prompt = (body) => body.system.map((block) => block.text).join('\n')

test('all preset versions are 303; retired selections normalize without a separate option', () => {
  assert.deepEqual(PERSONA_PRESETS, ['official', 'official_full', 'zero', 'custom'])
  assert.deepEqual(Object.keys(DEFAULT_PERSONA_TEMPLATES), PERSONA_PRESETS)
  for (const preset of [...PERSONA_PRESETS, '', 'rewrite', 'official_303', '303']) {
    assert.equal(profileForPreset(preset).cliVersion, '2.1.303')
  }
  for (const old of ['official_303', '303', 'official-303']) {
    assert.equal(normalizePersonaPreset(old), 'official_full')
    assert.equal(normalizeSlotPersonaPreset(old), 'official_full')
  }
})

test('retired saved templates and switches migrate, with explicit full values taking precedence', () => {
  const legacy = {
    persona_preset: 'official_303',
    persona_templates: { official_303: [{ type: 'text', text: 'saved prompt' }] },
    persona_env_presets: { official_303: false },
    persona_timezone_presets: { official_303: true, official_full: false },
  }
  const snapshot = structuredClone(legacy)
  const canonical = canonicalPersonaCompat(legacy)
  assert.equal(canonical.persona_preset, 'official_full')
  assert.equal(canonical.persona_templates.official_full[0].text, 'saved prompt')
  assert.deepEqual(canonical.persona_env_presets, { official_full: false })
  assert.deepEqual(canonical.persona_timezone_presets, { official_full: false })
  assert.deepEqual(legacy, snapshot)
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: legacy }), [])
  assert.equal(render(legacy).system[0].text, 'saved prompt')
})

test('official is the system-only version of official_full, without generated environment', () => {
  const out = render({
    persona_preset: 'official',
    persona_timezone_presets: { official: true },
    persona_locale_presets: { official: true },
    persona_env_instructions_presets: { official: true },
  })
  assert.equal(DEFAULT_PERSONA_TEMPLATES.official.some((block) => block.role === 'system'), false)
  assert.deepEqual(
    DEFAULT_PERSONA_TEMPLATES.official.map((block) => [block.id, block.text, block.cache_control]),
    DEFAULT_PERSONA_TEMPLATES.official_full
      .filter((block) => block.role !== 'system')
      .map((block) => [block.id, block.text, block.cache_control]),
  )
  assert.match(prompt(out), /# Harness/)
  assert.match(prompt(out), /# Session-specific guidance/)
  assert.equal(out.system.at(-1).text, 'CALLER_PROMPT')
  assert.equal(environment(out), '')
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hello' }])
  const prepared = prepareCliHopBody(out)
  assert.equal(environment(prepared), '')
  assert.equal(prompt(prepared), prompt(out))
})

test('official_full: system contains prompts; role=system contains environment, without optional timezone/language', () => {
  const out = render({ persona_preset: 'official_full' })
  assert.match(prompt(out), /# Harness/)
  assert.match(prompt(out), /# Session-specific guidance/)
  assert.equal(out.system.at(-1).text, 'CALLER_PROMPT')
  assert.match(environment(out), /^# Environment\nYou have been invoked/)
  assert.doesNotMatch(environment(out), /Timezone:|Language:|MCP Server Instructions|Available agent types/)
  assert.equal(
    out.system.some((block) => block.text.startsWith('# Environment')),
    false,
  )
  assert.equal(out.messages[0].content, 'hello')
  assert.equal(out.messages.at(-1).role, 'system')
  assert.equal(out.messages.at(-1).cache_control, undefined)
  const prepared = prepareCliHopBody(out)
  assert.equal(environment(prepared), environment(out))
  assert.equal(
    prepared.system.some((block) => block.text.startsWith('# Environment')),
    false,
  )
})

test('full captured environment instructions, timezone, language and per-model extra load independently', () => {
  const compat = {
    persona_preset: 'official_full',
    persona_env_instructions_presets: { official_full: true },
    persona_timezone_presets: { official_full: true },
    persona_locale_presets: { official_full: true },
    model_env_extra_presets: { official_full: true },
    model_env_extra: { 'claude-opus-5-5': 'MODEL_EXTRA' },
  }
  const out = render(compat)
  const env = environment(out)
  assert.ok(OFFICIAL_303_ENV_INSTRUCTIONS.length > 10_000)
  assert.ok(env.includes(OFFICIAL_303_ENV_INSTRUCTIONS))
  assert.match(env, /Timezone: Asia\/Tokyo/)
  assert.match(env, /Language: zh-CN/)
  assert.match(env, /MODEL_EXTRA/)
  assert.doesNotMatch(prompt(out), /Timezone:|Language:|MODEL_EXTRA|MCP Server Instructions/)
  assert.doesNotMatch(OFFICIAL_303_ENV_INSTRUCTIONS, /\/home\/mci777|Today's date is|<total_tokens>/)
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: compat }), [])
  const removed = render({ ...compat, persona_env_presets: { official_full: false } })
  assert.equal(environment(removed), '')
  assert.equal(prompt(removed), prompt(out))
  const selected = render({
    ...compat,
    persona_block_presets: { official_full: { env_instructions: false, env_timezone: false } },
  })
  assert.doesNotMatch(environment(selected), /MCP Server Instructions|Timezone:/)
  assert.match(environment(selected), /Language: zh-CN/)
})

test('environment opt-out preserves caller role=system without moving it into system', () => {
  const caller = { role: 'system', content: '# Environment\nCALLER_ENV' }
  const out = render(
    { persona_preset: 'official_full', persona_env_presets: { official_full: false } },
    {
      messages: [{ role: 'user', content: 'hello' }, caller],
    },
  )
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hello' }, caller])
  assert.doesNotMatch(prompt(out), /CALLER_ENV/)
})

test('custom role=system template blocks are stripped of metadata and do not leak into system', () => {
  const blocks = [
    { id: 'prompt', type: 'text', text: 'CUSTOM_PROMPT' },
    { id: 'env', note: 'metadata', role: 'system', type: 'text', text: 'CUSTOM_ENV' },
  ]
  assert.deepEqual(validatePersonaTemplate(blocks), [])
  const out = render({ persona_preset: 'custom', persona_templates: { custom: blocks } })
  assert.deepEqual(out.system, [{ type: 'text', text: 'CUSTOM_PROMPT' }])
  assert.deepEqual(out.messages.at(-1), { role: 'system', content: 'CUSTOM_ENV' })
  assert.notDeepEqual(validatePersonaTemplate([{ role: 'user', type: 'text', text: 'bad' }]), [])
  assert.notDeepEqual(validatePersonaTemplate([{ role: 'system', type: 'body', text: 'bad' }], { overlay: true }), [])
})

test('preview serves captured 303 environment instructions, not a legacy full-prompt substitute', () => {
  const vars = personaPreviewVars()
  assert.equal(vars.env_instructions_303, OFFICIAL_303_ENV_INSTRUCTIONS)
  assert.match(vars.harness_303, /# Harness/)
  assert.match(vars.guidance_303, /# Session-specific guidance/)
})

test('slot re-render retains repaired fields and filtered thinking instead of replaying original history', () => {
  const caller = {
    system: 'CALLER_PROMPT',
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'old', signature: 'foreign' }] },
      { role: 'user', content: 'hello' },
    ],
  }
  const generated = { role: 'system', content: 'GENERATED_ENV' }
  const rendered = { messages: [...caller.messages, generated] }
  const filtered = {
    model: 'claude-opus-5-5',
    system: 'RENDERED_PROMPT',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
      { role: 'user', content: 'hello' },
      { role: 'system', content: [{ type: 'text', text: 'GENERATED_ENV' }] },
    ],
    tools: [],
  }
  const next = callerPersonaInputForAttempt(filtered, caller, rendered)
  assert.deepEqual(next.messages, filtered.messages.slice(0, 2))
  assert.deepEqual(next.tools, [])
  assert.equal(next.system, 'CALLER_PROMPT')
  assert.deepEqual(filtered.messages.at(-1).content, [{ type: 'text', text: 'GENERATED_ENV' }])
  const callerEnv = { role: 'system', content: 'CALLER_ENV' }
  assert.deepEqual(
    callerPersonaInputForAttempt(
      { messages: [{ role: 'user', content: 'hello' }, callerEnv] },
      { messages: [callerEnv] },
      { messages: [callerEnv] },
    ).messages.at(-1),
    callerEnv,
  )
})

test('slot re-render removes only the generated overlay, preserving caller reminders', () => {
  const own = '<system-reminder>CALLER</system-reminder>hello'
  const overlay = '<system-reminder>GENERATED</system-reminder>\n'
  const caller = { messages: [{ role: 'user', content: own }] }
  const rendered = { messages: [{ role: 'user', content: overlay + own }] }
  const attempt = { messages: [{ role: 'user', content: [{ type: 'text', text: overlay + own }] }] }
  const next = callerPersonaInputForAttempt(attempt, caller, rendered)
  assert.equal(next.messages[0].content[0].text, own)
  assert.equal(attempt.messages[0].content[0].text, overlay + own)
  const blocks = [{ type: 'text', text: own }]
  const arrayCaller = { messages: [{ role: 'user', content: blocks }] }
  const arrayRendered = { messages: [{ role: 'user', content: [{ type: 'text', text: overlay }, ...blocks] }] }
  assert.deepEqual(callerPersonaInputForAttempt(arrayRendered, arrayCaller, arrayRendered).messages[0].content, blocks)
})
