import test from 'node:test'
import assert from 'node:assert/strict'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { prepareAnthropicRequest } from '../../src/lib/protocol/anthropic-policy.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'

const model = 'claude-sonnet-5-5'
const schema = {
  type: 'object',
  properties: { task: { type: 'string' } },
  required: ['task'],
  additionalProperties: false,
}
const tools = [
  { name: '_todo', input_schema: schema },
  { name: '_read', input_schema: schema },
]
const messages = [{ role: 'user', content: 'Plan the work.' }]

const requests = [
  ['anthropic.messages', { messages, tools, tool_choice: { type: 'tool', name: '_todo' } }],
  [
    'openai.chat',
    {
      messages,
      tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, parameters: tool.input_schema } })),
      tool_choice: { type: 'function', function: { name: '_todo' } },
    },
  ],
  [
    'openai.responses',
    {
      input: 'Plan the work.',
      tools: tools.map((tool) => ({ type: 'function', name: tool.name, parameters: tool.input_schema })),
      tool_choice: { type: 'function', name: '_todo' },
    },
  ],
]

for (const [protocol, request] of requests) {
  test(`${protocol} Sonnet 5.5 cli-hop passthrough vs direct Anthropic policy`, () => {
    const input = { ...structuredClone(request), model, output_config: { effort: 'low' } }
    const before = structuredClone(input)
    const { claude } = toClaudeMessages(protocol, input)
    const hopOut = prepareCliHopBody(claude)
    assert.deepEqual(hopOut.tool_choice, { type: 'tool', name: '_todo' })
    assert.equal(hopOut.tools[0].name, '_todo')
    assert.equal(hopOut.tools[0].strict, undefined)
    assert.deepEqual(hopOut.tools[0].input_schema, schema)
    assert.equal(hopOut.tools[1].strict, undefined)
    assert.equal(hopOut.output_config.effort, 'low')

    const anthOut = prepareAnthropicRequest(claude)
    assert.deepEqual(anthOut.tool_choice, { type: 'auto' })
    assert.equal(anthOut.tools[0].strict, true)
    assert.equal(anthOut.tools[1].strict, undefined)
    assert.equal(anthOut.output_config.effort, 'low')

    assert.deepEqual(input, before)
    assert.deepEqual(prepareCliHopBody(hopOut), hopOut)
    const sonnet5 = prepareAnthropicRequest(toClaudeMessages(protocol, { ...input, model: 'claude-sonnet-5' }).claude)
    assert.deepEqual(sonnet5.tool_choice, { type: 'tool', name: '_todo' })
    assert.equal(sonnet5.tools[0].strict, undefined)
  })
}

test('Sonnet 5.5 cli-hop preserves tool_choice; direct path adapts required to auto', () => {
  for (const choice of [{ type: 'any' }, 'required', { type: 'auto' }, { type: 'none' }]) {
    const body = { model, messages, tools, tool_choice: choice }
    const hopOut = prepareCliHopBody(body)
    const expectedHop = typeof choice === 'string' ? choice : choice
    assert.deepEqual(hopOut.tool_choice, expectedHop)
    assert.deepEqual(hopOut.tools, tools)

    const anthOut = prepareAnthropicRequest(structuredClone(body))
    assert.deepEqual(anthOut.tool_choice, { type: choice.type === 'none' ? 'none' : 'auto' })
  }
})

test('Sonnet 5.5 cli-hop leaves server tools unchanged; direct path adapts forced choice', () => {
  const serverTools = [
    { name: 'web_search', type: 'web_search_20250305' },
    { name: 'computer', type: 'computer_20251124' },
  ]
  const input = {
    model,
    messages,
    tools: serverTools,
    tool_choice: { type: 'tool', name: 'web_search' },
  }
  const hopOut = prepareCliHopBody(input)
  assert.deepEqual(hopOut.tool_choice, { type: 'tool', name: 'web_search' })
  assert.equal(hopOut.tools[0].strict, undefined)
  assert.equal(hopOut.tools[1].type, 'computer_20251124')

  const anthOut = prepareAnthropicRequest(structuredClone(input))
  assert.deepEqual(anthOut.tool_choice, { type: 'auto' })
  assert.equal(anthOut.tools[0].strict, undefined)
})

test('Sonnet 5.5 repaired cli-hop applies thinking display only', () => {
  for (const type of ['disabled', 'enabled', 'adaptive']) {
    const input = {
      model,
      messages,
      tools,
      thinking: { type, budget_tokens: 2048, display: 'summarized' },
      tool_choice: { type: 'tool', name: '_todo' },
    }
    const out = prepareCliHopBody(input, { repaired: true })
    assert.equal(out.thinking.type, type)
    assert.equal(out.thinking.budget_tokens, 2048)
    if (type === 'disabled') assert.equal(out.thinking.display, 'summarized')
    else assert.equal(out.thinking.display, 'summarized')
    assert.deepEqual(out.tool_choice, { type: 'tool', name: '_todo' })
    assert.equal(out.tools[0].strict, undefined)
  }
})

test('Sonnet 5.5 schema conversion preserves effort and fills nested object constraints', () => {
  const outputSchema = {
    type: 'object',
    properties: { result: { type: 'object', properties: { ok: { type: 'boolean' } } } },
  }
  for (const protocol of ['anthropic.messages', 'openai.chat', 'openai.responses']) {
    const input = { model, messages, input: 'Return JSON.', output_config: { effort: 'low' } }
    if (protocol === 'openai.responses') input.text = { format: { type: 'json_schema', schema: outputSchema } }
    else input.response_format = { type: 'json_schema', json_schema: { schema: outputSchema } }
    const out = prepareCliHopBody(toClaudeMessages(protocol, input).claude)
    assert.equal(out.output_config.effort, 'low')
    assert.equal(out.output_config.format.type, 'json_schema')
    assert.equal(out.output_config.format.schema.additionalProperties, false)
    assert.equal(out.output_config.format.schema.properties.result.additionalProperties, false)
    assert.equal(out.output_config.format.schema.properties.result.properties.ok.type, 'boolean')
    assert.equal(outputSchema.additionalProperties, undefined)
  }
})

test('an explicit Anthropic output format wins over compatibility response_format', () => {
  const format = { type: 'json_schema', schema }
  const { claude } = toClaudeMessages('openai.chat', {
    model,
    messages,
    output_config: { effort: 'low', format },
    response_format: { type: 'json_object' },
  })
  assert.deepEqual(prepareCliHopBody(claude).output_config, { effort: 'low', format })
})
