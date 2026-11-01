import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'

const model = 'gpt-4.1-mini'
const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
const events = [
  { type: 'response.created', response: { id: 'resp-test', model } },
  { type: 'response.output_text.delta', delta: 'Hello' },
  {
    type: 'response.completed',
    response: {
      id: 'resp-test',
      model,
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] }],
      usage,
    },
  },
]
const upstreamSse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

async function request(protocol) {
  const wire = []
  const res = { headersSent: false, write: (chunk) => wire.push(chunk) }
  const result = await runApiInference({
    req: { apiKeyKind: 'managed', apiKeyRecord: { category: 'api', group_type: 'openai_apikey', allowed_vms: ['A'] } },
    res,
    cfg: {},
    scheduler: {
      pick: (_model, _now, scope) => {
        assert.deepEqual(scope.allowed_vms, ['A'])
        return {
          ok: true,
          endpoint: { id: 'ep-account', kind: 'openai', protocol: 'openai', base_url: 'https://upstream.invalid' },
          key: { id: 'key-account', api_key: 'fixture-key', source_vm_id: 'A', source_account_id: 'account-A' },
          upstream_model: model,
        }
      },
    },
    store: {},
    protocol,
    inbound: { model },
    convertedBody: { model, messages: [{ role: 'user', content: 'hello' }] },
    clientStream: true,
    deliveryMode: 'verified',
    converters: { writeSSEHeaders: () => (res.headersSent = true) },
    forwardImpl: async () =>
      Object.assign(Readable.from([upstreamSse]), {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  })
  const text = wire.join('')
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
  return { result, text, data, chunks: data.filter((value) => value !== '[DONE]').map((value) => JSON.parse(value)) }
}

test('OpenAI Responses upstream emits text completion chunks with text, finish, usage and one terminator', async () => {
  const { result, data, chunks } = await request('openai.completions')
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'key-account')
  assert.equal(result.sourceAccountId, 'account-A')
  assert.equal(result.downstreamDone, true)
  assert.ok(chunks.length > 0)
  assert.ok(chunks.every((chunk) => chunk.object === 'text_completion'))
  assert.ok(chunks.every((chunk) => chunk.model === model))
  assert.ok(chunks.every((chunk) => !Object.hasOwn(chunk.choices[0], 'delta')))
  assert.equal(chunks.map((chunk) => chunk.choices[0].text).join(''), 'Hello')
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
  assert.equal(result.usage.input_tokens, 3)
  assert.equal(result.usage.output_tokens, 2)
  assert.equal(data.filter((value) => value === '[DONE]').length, 1)
  assert.equal(data.at(-1), '[DONE]')
})

test('OpenAI Responses upstream keeps the Chat streaming envelope', async () => {
  const { result, data, chunks } = await request('openai.chat')
  assert.equal(result.ok, true)
  assert.equal(result.downstreamDone, true)
  assert.ok(chunks.every((chunk) => chunk.object === 'chat.completion.chunk'))
  assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content || '').join(''), 'Hello')
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
  assert.equal(data.at(-1), '[DONE]')
})

test('OpenAI Responses upstream keeps Messages streaming events', async () => {
  const { result, chunks } = await request('anthropic.messages')
  assert.equal(result.ok, true)
  assert.equal(chunks[0].type, 'message_start')
  assert.equal(chunks.find((chunk) => chunk.type === 'content_block_delta').delta.text, 'Hello')
  assert.equal(chunks.at(-1).type, 'message_stop')
})

test('OpenAI Responses upstream keeps native Responses event frames', async () => {
  const { result, text, chunks } = await request('openai.responses')
  assert.equal(result.ok, true)
  assert.equal(text, upstreamSse)
  assert.deepEqual(chunks, events)
})
