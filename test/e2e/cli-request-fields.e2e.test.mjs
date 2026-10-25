import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { startRealChain } from './helpers/real-chain.mjs'
import { listCacheMarkers } from '../../src/lib/protocol/cache-ttl.mjs'
import { checkOfficial303Wire, checkOfficial303WireRules } from '../../src/lib/protocol/outbound-shape.mjs'

const kernelBin = process.env.VM2API_FIELDS_KERNEL
const cliBin = process.env.VM2API_FIELDS_CLI
const skip = !kernelBin || !cliBin ? 'set VM2API_FIELDS_KERNEL and VM2API_FIELDS_CLI to isolated candidates' : false
const thinking = { type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } }
const context_management = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] }

for (const preset of ['official', 'official_full', 'zero']) {
  for (const ttl of ['5m', '1h']) {
    test(`real CLI ${preset} ${ttl}: native fields, cache budget and final serialization`, {
      skip,
      timeout: 120_000,
    }, async () => {
      const h = await startRealChain({
        kernelBin,
        cliBin,
        preset,
        cacheTtl: ttl,
        routingBase: { compatibility: { thinking_display: 'passthrough' } },
      })
      try {
        const request = {
          model: 'claude-opus-5-5',
          max_tokens: 1024,
          stream: true,
          metadata: { user_id: JSON.stringify({ session_id: randomUUID() }) },
          messages: [
            {
              role: 'user',
              clear_at: 'msg_fixture',
              tools: [],
              output_config: { effort: 'low' },
              content: [
                { type: 'text', text: `first ${'\u754c'.repeat(25_000)}`, cache_control: { type: 'ephemeral' } },
              ],
            },
            { role: 'assistant', content: [{ type: 'text', text: 'reply', cache_control: { type: 'ephemeral' } }] },
            { role: 'user', content: [{ type: 'text', text: 'next', cache_control: { type: 'ephemeral' } }] },
          ],
          thinking,
          context_management,
          tools: [],
          stop_sequences: [],
          output_config: { effort: 'medium' },
          safeguards: [{ type: 'dangerous_tool_use', mode: 'test' }],
        }
        const out = await h.send({ request: { body: request } })
        assert.equal(out.status, 200, out.response)
        assert.equal(out.count, 1)
        const wire = out.body
        assert.deepEqual(wire.tools, [])
        assert.deepEqual(wire.stop_sequences, [])
        assert.deepEqual(wire.thinking, thinking)
        assert.deepEqual(wire.context_management, context_management)
        assert.deepEqual(wire.safeguards, request.safeguards)
        assert.equal(wire.output_config.effort, 'medium')
        assert.equal(wire.messages[0].content[0].text, request.messages[0].content[0].text)
        assert.equal(wire.messages[0].clear_at, 'msg_fixture')
        assert.deepEqual(wire.messages[0].tools, [])
        assert.deepEqual(wire.messages[0].output_config, { effort: 'low' })
        assert.ok(!out.raw.includes('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'))
        const markers = listCacheMarkers(wire)
        assert.ok(markers.length > 0 && markers.length <= 4)
        assert.ok(markers.every((marker) => marker.ttl === ttl))
        const messageMarkers = markers.filter((marker) => marker.section === 'messages')
        assert.deepEqual(
          messageMarkers.map((marker) => marker.index),
          [wire.messages.length - 1],
        )
        const blocking = checkOfficial303Wire(out).filter((problem) => problem.blocking !== false)
        assert.deepEqual(blocking, [])
        if (preset !== 'zero') assert.deepEqual(checkOfficial303WireRules(wire), [])
        const { tools, stop_sequences, context_management: _context, ...omitted } = request
        const next = await h.send({ request: { body: omitted } })
        assert.equal(next.status, 200, next.response)
        assert.equal(Object.hasOwn(next.body, 'tools'), false)
        assert.equal(Object.hasOwn(next.body, 'stop_sequences'), false)
        assert.equal(Object.hasOwn(next.body, 'context_management'), false)
        const tool = {
          name: 'Probe',
          input_schema: { type: 'object', properties: {} },
          strict: true,
          defer_loading: true,
        }
        const continued = await h.send({
          request: {
            body: {
              ...request,
              tools: [tool],
              stop_sequences: ['END'],
              tool_choice: { type: 'auto' },
              messages: [
                ...wire.messages,
                { role: 'assistant', content: 'ok' },
                { role: 'user', content: 'continued' },
              ],
            },
          },
        })
        assert.equal(continued.status, 200, continued.response)
        assert.deepEqual(continued.body.tools, [tool])
        assert.deepEqual(continued.body.stop_sequences, ['END'])
        assert.deepEqual(continued.body.tool_choice, { type: 'auto' })
        const unmarked = (messages) =>
          messages.map((message) => ({
            ...message,
            content: message.content.map(({ cache_control, ...block }) => block),
          }))
        assert.deepEqual(unmarked(continued.body.messages.slice(0, wire.messages.length)), unmarked(wire.messages))
      } finally {
        await h.close()
      }
    })
  }
}
