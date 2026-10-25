import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { listCacheMarkers } from '../../src/lib/protocol/cache-ttl.mjs'

const request = (extra = {}) => ({
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
})

test('cli-hop preserves explicit context edits and adaptive block binding without adding defaults', () => {
  const context_management = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] }
  const thinking = { type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } }
  const out = prepareCliHopBody(request({ context_management, thinking }), {
    routing: { compatibility: { thinking_display: 'passthrough' } },
  })
  assert.deepEqual(out.context_management, context_management)
  assert.deepEqual(out.thinking, thinking)
  assert.equal(Object.hasOwn(prepareCliHopBody(request()), 'context_management'), false)
})

test('cli-hop distinguishes explicit empty collections from omission', () => {
  const empty = prepareCliHopBody(request({ tools: [], stop_sequences: [] }))
  assert.deepEqual(empty.tools, [])
  assert.deepEqual(empty.stop_sequences, [])
  const omitted = prepareCliHopBody(request())
  assert.equal(Object.hasOwn(omitted, 'tools'), false)
  assert.equal(Object.hasOwn(omitted, 'stop_sequences'), false)
})

test('cli-hop retains supported sampling with thinking disabled, not adaptive thinking', () => {
  const sampling = { temperature: 0.5, top_p: 0.9, top_k: 40 }
  const out = prepareCliHopBody(request({ model: 'claude-haiku-4-5', ...sampling }))
  for (const [key, value] of Object.entries(sampling)) assert.equal(out[key], value)
  const adaptive = prepareCliHopBody(request({ ...sampling, thinking: { type: 'adaptive' } }))
  for (const key of Object.keys(sampling)) assert.equal(Object.hasOwn(adaptive, key), false)
})

test('custom system marker budget is capped without mutating the caller', () => {
  const input = request({
    system: [
      ...Array.from({ length: 6 }, (_, index) => ({
        type: 'text',
        text: `prompt ${index}`,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      })),
      { type: 'text', text: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__' },
    ],
  })
  const before = structuredClone(input)
  assert.equal(listCacheMarkers(prepareCliHopBody(input)).length, 4)
  assert.deepEqual(input, before)
})

for (const ttl of ['5m', '1h']) {
  test(`prepared system keeps panel ${ttl} and replaces all caller message markers with one tail`, () => {
    const cc = { type: 'ephemeral', ttl: '1h', scope: 'global' }
    const input = request({
      system: [
        { type: 'text', text: 'harness', cache_control: cc },
        { type: 'text', text: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__' },
        { type: 'text', text: 'guidance', cache_control: cc },
      ],
      messages: [
        { role: 'user', cache_control: cc, content: [{ type: 'text', text: 'hello', cache_control: cc }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reply', cache_control: cc }] },
        { role: 'user', content: 'next' },
        { role: 'system', content: '# Environment\nfixture' },
      ],
    })
    const before = structuredClone(input)
    const out = prepareCliHopBody(input, { cacheTtl: ttl })
    const markers = listCacheMarkers(out)
    assert.equal(markers.length, 3)
    assert.ok(markers.every((marker) => marker.ttl === ttl))
    assert.deepEqual(
      markers.filter((marker) => marker.section === 'messages').map((marker) => marker.index),
      [3],
    )
    assert.ok(out.messages.every((message) => !Object.hasOwn(message, 'cache_control')))
    assert.equal(out.system[0].cache_control.scope, ttl === '1h' ? 'global' : undefined)
    assert.deepEqual(input, before)
    const continued = prepareCliHopBody(
      { ...input, messages: [...input.messages, { role: 'user', content: 'continue' }] },
      { cacheTtl: ttl },
    )
    const content = (messages) => messages.map(({ content }) => content.map(({ cache_control, ...block }) => block))
    assert.deepEqual(content(continued.messages.slice(0, out.messages.length)), content(out.messages))
  })
}
