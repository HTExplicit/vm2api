import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRouting, validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'
import { appendOpenAiSystemPrompt } from '../../src/lib/protocol/openai-system-prompt.mjs'

const prompt = { enabled: true, text: 'Gateway prompt\n' }
const added = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: prompt.text }] }

test('the routing panel supplies the default and checks only the new config fields', () => {
  const compatibility = { openai_system_prompt: prompt }
  const stickyRouter = { stats: () => ({ active_sessions: 0 }) }
  assert.deepEqual(buildRouting({ routingConfig: {}, stickyRouter }).data.compatibility.openai_system_prompt, {
    enabled: false,
    text: '',
  })
  assert.deepEqual(
    buildRouting({ routingConfig: { compatibility }, stickyRouter }).data.compatibility.openai_system_prompt,
    prompt,
  )
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility }), [])
  assert.match(
    validatePersonaRoutingPatch({ compatibility: { openai_system_prompt: { ...prompt, text: 42 } } })[0],
    /openai_system_prompt/,
  )
})

test('the prompt follows leading tools and instructions while preserving the caller history', () => {
  const additionalTools = { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'lookup' }] }
  const system = { role: 'system', content: 'Caller system' }
  const developer = { type: 'message', role: 'developer', content: 'Caller developer' }
  const user = { role: 'user', content: 'First' }
  const reasoning = { type: 'reasoning', encrypted_content: 'opaque' }
  const lateDeveloper = { role: 'developer', content: 'Later instructions' }
  const body = {
    instructions: 'Caller top level',
    input: [additionalTools, system, developer, user, reasoning, lateDeveloper],
    tools: [{ type: 'function', name: 'example' }],
    prompt_cache_key: 'caller-key',
  }
  const result = appendOpenAiSystemPrompt(body, prompt)
  assert.deepEqual(result, {
    ...body,
    input: [additionalTools, system, developer, added, user, reasoning, lateDeveloper],
  })
  assert.equal(result.input[5], reasoning)
  assert.equal(result.tools, body.tools)
  assert.equal(appendOpenAiSystemPrompt(body, { ...prompt, enabled: false }), body)
  assert.equal(appendOpenAiSystemPrompt(body, { ...prompt, text: '\n  ' }), body)
})

test('string and missing input get a leading developer message', () => {
  assert.deepEqual(appendOpenAiSystemPrompt({ input: 'Hello', instructions: 'Caller instructions ' }, prompt), {
    instructions: 'Caller instructions ',
    input: [added, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
  })
  assert.deepEqual(appendOpenAiSystemPrompt({}, prompt), { input: [added] })
})

test('an upstream-managed continuation inherits developer instructions without duplicating them', () => {
  const body = { previous_response_id: 'resp_fixture', input: 'Next', instructions: 'This turn' }
  assert.equal(appendOpenAiSystemPrompt(body, prompt), body)
})
