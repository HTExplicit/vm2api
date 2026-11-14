import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  createSseRestorer,
  ensureRedaction,
  maskJson,
  publishRedactionForTests,
  restoreJsonValue,
} from '../../src/lib/redaction/runtime.mjs'

let root
let bin
let helper = null

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-redact-runtime-'))
  bin = path.join(root, 'kin-redact')
})

afterEach(async () => {
  try {
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      const closed = once(helper, 'close')
      helper.kill()
      await closed
    }
  } finally {
    helper = null
    publishRedactionForTests(null)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('redaction runtime', () => {
  it('stays out of the request path when the switch is off', async () => {
    const state = await ensureRedaction({}, { projectRoot: root, binPath: bin })
    assert.equal(state.enabled, false)
    assert.equal(state.ready, true)
    const body = { messages: [{ role: 'user', content: 'sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg' }] }
    assert.equal(await maskJson(body, { principal: 'key-a' }), body)
    assert.equal(await restoreJsonValue(body, { principal: 'key-a' }), body)
  })

  it('rejects an older helper that cannot enforce the requested limit', async () => {
    fs.writeFileSync(
      bin,
      `#!${process.execPath}
import fs from 'node:fs'
import http from 'node:http'
const arg = (name) => process.argv[process.argv.indexOf(name) + 1]
http.createServer((req, res) => {
  req.resume()
  res.end(JSON.stringify({ protocol: 1 }))
}).listen(arg('-sock'), () => fs.writeFileSync(arg('-capability'), 'synthetic-capability'))
`,
      { mode: 0o700 },
    )
    await assert.rejects(
      ensureRedaction(
        { redaction: { enabled: true, secrets: true, personal: false } },
        { projectRoot: root, binPath: bin },
      ),
      { code: 'redaction_unavailable', status: 503, message: /must be rebuilt/ },
    )
  })

  it('masks and restores through the real helper when enabled', { timeout: 60_000 }, async () => {
    execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], {
      cwd: path.join(process.cwd(), 'redact'),
      stdio: 'inherit',
    })
    const policy = { enabled: true, secrets: true, personal: false, words: [], rules: [] }
    const state = await ensureRedaction(
      { redaction: policy, failover: { max_request_mib: 64 } },
      { projectRoot: root, binPath: bin },
    )
    assert.equal(state.ready, true)
    helper = state.child
    assert.equal(state.maxBodyBytes, 64 * 1024 * 1024)
    const secret = 'sk-' + 'proj-' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg'
    const body = { messages: [{ role: 'user', content: `token ${secret}` }] }
    const masked = await maskJson(body, { principal: 'key-a', session: 's1' })
    const text = JSON.stringify(masked)
    assert.equal(text.includes(secret), false)
    assert.ok(text.includes('{{R_API_KEY_'))
    const restored = await restoreJsonValue(masked, { principal: 'key-a', session: 's1' })
    assert.deepEqual(restored, body)
    const other = await restoreJsonValue(masked, { principal: 'key-b', session: 's1' })
    assert.deepEqual(other, masked)

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

  it('processes a body above 32 MiB when the panel allows 64 MiB', { timeout: 60_000 }, async () => {
    execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], {
      cwd: path.join(process.cwd(), 'redact'),
      stdio: 'inherit',
    })
    const policy = { enabled: true, secrets: false, personal: false, words: ['synthetic-secret'] }
    const state = await ensureRedaction(
      { redaction: policy, failover: { max_request_mib: 64 } },
      { projectRoot: root, binPath: bin },
    )
    helper = state.child
    const raw = { principal: 'synthetic-repro', session: 'raw', policy, maxBodyBytes: 63 }
    assert.equal((await state.client.mask({ ...raw, body: '界'.repeat(21) })).body, '界'.repeat(21))
    for (const body of ['界'.repeat(21) + 'x', '界'.repeat(128 * 1024)]) {
      await assert.rejects(state.client.mask({ ...raw, body }), { status: 413, code: 'redaction_body_too_large' })
    }
    const ctx = { principal: 'synthetic-repro', session: 'large-body', maxBodyBytes: state.maxBodyBytes }
    const original = { probe: 'synthetic-secret' }
    const saved = await maskJson(original, ctx)
    assert.ok(!saved.probe.includes('synthetic-secret'))
    const overhead = Buffer.byteLength(JSON.stringify({ data: '', probe: '__END__' }))
    for (const bytes of [32 * 1024 * 1024 + 1, 33761894, 64 * 1024 * 1024]) {
      const body = { data: 'x'.repeat(bytes - overhead), probe: '__END__' }
      const masked = await maskJson(body, ctx)
      assert.equal(masked.data.length, body.data.length)
      assert.equal(masked.probe, '__END__')
      const restored = await restoreJsonValue(masked, ctx)
      assert.equal(restored.data, body.data)
      assert.equal(restored.probe, '__END__')
    }

    const resized = await ensureRedaction(
      { redaction: policy, failover: { max_request_mib: 8 } },
      { projectRoot: root, binPath: bin },
    )
    assert.equal(resized.maxBodyBytes, 8 * 1024 * 1024)
    assert.equal(resized.child, helper)
    const oversized = { data: 'x'.repeat(8 * 1024 * 1024 + 1 - Buffer.byteLength('{"data":""}')) }
    const current = { principal: ctx.principal, session: ctx.session }
    for (const transform of [maskJson, restoreJsonValue]) {
      await assert.rejects(transform(oversized, current), (error) => {
        assert.equal(error.status, 413)
        assert.equal(error.code, 'redaction_body_too_large')
        assert.equal(error.details.retryable, false)
        return true
      })
    }
    // A request that already captured the previous limit keeps that limit.
    assert.equal((await maskJson(oversized, ctx)).data.length, oversized.data.length)
    assert.deepEqual(await restoreJsonValue(saved, current), original)
    const raised = await ensureRedaction(
      { redaction: policy, failover: { max_request_mib: 128 } },
      { projectRoot: root, binPath: bin },
    )
    assert.equal(raised.maxBodyBytes, 128 * 1024 * 1024)
    assert.equal(raised.child, helper)
  })
})
