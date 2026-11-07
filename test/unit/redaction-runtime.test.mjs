import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import {
  createSseRestorer,
  ensureRedaction,
  maskJson,
  publishRedactionForTests,
  restoreJsonValue,
} from '../../src/lib/redaction/runtime.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-redact-runtime-'))
const bin = path.join(root, 'kin-redact')

let helper = null

afterEach(() => {
  helper?.kill()
  helper = null
  publishRedactionForTests(null)
})
after(() => fs.rmSync(root, { recursive: true, force: true }))

describe('redaction runtime', () => {
  it('stays out of the request path when the switch is off', async () => {
    const state = await ensureRedaction({}, { projectRoot: root, binPath: bin })
    assert.equal(state.enabled, false)
    assert.equal(state.ready, true)
    assert.deepEqual(
      await maskJson({ messages: [{ role: 'user', content: 'sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg' }] }, { principal: 'key-a' }),
      {
        messages: [{ role: 'user', content: 'sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg' }],
      },
    )
  })

  it('masks and restores through the real helper when enabled', { timeout: 60_000 }, async () => {
    execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], {
      cwd: path.join(process.cwd(), 'redact'),
      stdio: 'inherit',
    })
    const policy = { enabled: true, secrets: true, personal: false, words: [], rules: [] }
    const state = await ensureRedaction({ redaction: policy }, { projectRoot: root, binPath: bin })
    assert.equal(state.ready, true)
    helper = state.child
    const secret = 'sk-' + 'proj-' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg'
    const masked = await maskJson(
      { messages: [{ role: 'user', content: `token ${secret}` }] },
      { principal: 'key-a', session: 's1' },
    )
    const text = JSON.stringify(masked)
    assert.equal(text.includes(secret), false)
    assert.ok(text.includes('{{R_API_KEY_'))
    const restored = await restoreJsonValue(masked, { principal: 'key-a', session: 's1' })
    assert.ok(JSON.stringify(restored).includes(secret))
    const other = await restoreJsonValue(masked, { principal: 'key-b', session: 's1' })
    assert.equal(JSON.stringify(other).includes(secret), false)

    const ctx = { principal: 'key-a', session: 's1' }
    const tag = text.match(/\{\{R_API_KEY_[a-z2-7]{26}\}\}/)?.[0]
    assert.ok(tag)
    const data = (event) => `data: ${JSON.stringify(event)}`
    const decoded = (line) => JSON.parse(line.slice(5).trim())
    for (const field of ['text', 'thinking', 'partial_json']) {
      const restorer = createSseRestorer(ctx)
      const event = (value) => ({ type: 'content_block_delta', index: 2, delta: { [field]: value } })
      const first = decoded(await restorer.line(data(event(tag.slice(0, 1)))))
      const second = decoded(await restorer.line(data(event(tag.slice(1, -1)))))
      const last = decoded(await restorer.line(data(event(tag.slice(-1)))))
      assert.equal(first.delta[field] + second.delta[field] + last.delta[field], secret)
      assert.deepEqual(restorer.finish(), [])
    }
    for (const type of [
      'response.output_text.delta',
      'response.function_call_arguments.delta',
      'response.custom_tool_call_input.delta',
    ]) {
      const restorer = createSseRestorer(ctx)
      const event = (value) => ({ type, item_id: 'call-a', output_index: 1, content_index: 0, delta: value })
      const first = decoded(await restorer.line(data(event(tag.slice(0, 4)))))
      const middle = decoded(await restorer.line(data({ ...event('untouched'), item_id: 'call-b', output_index: 2 })))
      const last = decoded(await restorer.line(data(event(tag.slice(4)))))
      assert.equal(first.delta + last.delta, secret)
      assert.equal(middle.delta, 'untouched')
      assert.equal(last.item_id, 'call-a')
      assert.deepEqual(restorer.finish(), [])
    }
    const unfinished = createSseRestorer(ctx)
    const literal = { type: 'response.output_text.delta', item_id: 'literal', output_index: 0, delta: 'brace {' }
    const emitted = decoded(await unfinished.line(data(literal)))
    const final = unfinished.finish().map(decoded)
    assert.equal(emitted.delta + final[0].delta, literal.delta)

    for (const [delta, terminal] of [
      [
        { type: 'content_block_delta', index: 3, delta: { text: 'literal {' } },
        { type: 'content_block_stop', index: 3 },
      ],
      [literal, { type: 'response.output_item.done', output_index: 0, item: { id: 'literal' } }],
      [literal, { type: 'response.completed' }],
      [literal, '[DONE]'],
    ]) {
      const restorer = createSseRestorer(ctx)
      const first = await restorer.line(data(delta))
      assert.deepEqual(restorer.before(data({ type: 'content_block_stop', index: 99 })), [])
      const last = terminal === '[DONE]' ? 'data: [DONE]' : data(terminal)
      const wire = [first, ...restorer.before(last), await restorer.line(last)]
      const dataEvents = wire.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
      assert.equal(dataEvents.at(-1), terminal === '[DONE]' ? '[DONE]' : JSON.stringify(terminal))
      const restoredLiteral = JSON.parse(dataEvents[1])
      assert.equal(typeof delta.delta === 'string' ? restoredLiteral.delta : restoredLiteral.delta.text, '{')
      assert.ok(wire.indexOf(`event: ${delta.type}`) < wire.lastIndexOf(last))
      if (terminal !== '[DONE]') assert.equal(wire.at(-2), `event: ${terminal.type}`)
      assert.deepEqual(restorer.finish(), [])
    }
  })
})
