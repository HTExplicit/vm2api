import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { PELICAN_TEST_PROMPT, respondPelicanTest, runPelicanTest } from '../../src/lib/admin/pelican-test.mjs'
import { runVmTestChat } from '../../src/lib/admin/vm-test-chat.mjs'
import { authorizePanelRoute, canViewPage } from '../../src/lib/admin/panel-acl.mjs'
import { handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-pelican-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-gpt'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'config'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'config', 'routing.json'), '{}')
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-gpt', 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ access_token: 'test-access', refresh_token: 'test-refresh' }],
    }),
  )
  const vm = {
    id: 'vm-gpt',
    name: 'GPT account',
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    runtime: { stopped: false },
    proxy: { host: '127.0.0.1', port: 1080, url: 'socks5h://127.0.0.1:1080' },
  }
  const write = (patch = {}) =>
    fs.writeFileSync(path.join(root, 'vms', 'vm-gpt.json'), JSON.stringify({ ...vm, ...patch }))
  write()
  return { root, write }
}

test('pelican loopback pins the selected account, sends the exact prompt and returns full HTML', async (t) => {
  const { root } = fixture(t)
  const html = '<!doctype html><html><body><svg>' + '<!-- animation -->'.repeat(400) + '</svg></body></html>'
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: html })}\n\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', model: 'gpt-5.4', usage: { input_tokens: 20, output_tokens: 100 } },
      })}\n\n`,
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const result = await runPelicanTest({
    projectRoot: root,
    vmId: 'vm-gpt',
    model: 'gpt-5.4',
    reasoning_effort: 'high',
    prompt: 'must be ignored',
    apiKey: 'test-master',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, html)
  assert.ok(result.text.length > 4000)
  assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 100 })
  assert.equal(result.stop_reason, 'completed')
  assert.equal(result.reasoning_effort, 'high')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/v1/responses')
  assert.equal(calls[0].headers['x-kin-vm'], 'vm-gpt')
  assert.equal(calls[0].headers['x-kin-pelican-test'], '1')
  assert.equal(calls[0].body.input[0].content[0].text, PELICAN_TEST_PROMPT)
  assert.deepEqual(calls[0].body.reasoning, { effort: 'high' })
  assert.equal(result.body, undefined)
  assert.equal(result.log, undefined)
})

test('pelican rejects disabled, stopped and wrong-platform accounts before loopback; page and route are admin-only', async (t) => {
  const { root, write } = fixture(t)
  for (const [patch, code] of [
    [{ schedule_off: true }, 'vm_unschedulable'],
    [{ runtime: { stopped: true } }, 'vm_stopped'],
    [{ platform: 'anthropic', family: 'claude' }, 'platform_mismatch'],
  ]) {
    write(patch)
    const result = await runPelicanTest({ projectRoot: root, vmId: 'vm-gpt', model: 'gpt-5.4', apiKey: 'test-master' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, code)
  }
  for (const role of ['user', 'super']) {
    assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-gpt/pelican-test', role).ok, false)
    assert.equal(canViewPage(role, 'pelican'), false)
  }
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-gpt/pelican-test', 'admin').ok, true)
  assert.equal(canViewPage('admin', 'pelican'), true)
})

test('pelican protocol refuses an unhealthy kernel without starting it or sending a model request', async (t) => {
  resetOpenAIAccountRuntime()
  const { root } = fixture(t)
  let starts = 0
  let configs = 0
  let hops = 0
  let healthChecks = 0
  const res = { headersSent: false, writableEnded: false, write() {}, end() {} }
  const body = { model: 'gpt-5.4', input: PELICAN_TEST_PROMPT, stream: false }
  await handleCodexProtocol({
    req: { apiKeyKind: 'master', headers: { 'x-kin-vm': 'vm-gpt', 'x-kin-pelican-test': '1' } },
    res,
    protocol: 'openai.responses',
    ctx: { body },
    inbound: body,
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, payload) => {
      res.statusCode = status
      res.body = payload
    },
    writeSSEHeaders() {},
    routing: {},
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {
        configs++
      },
      codexKernelHealth: async () => {
        healthChecks++
        return { ok: false, reason: 'not_running' }
      },
      ensureCodexKernel: async () => {
        starts++
        return { ok: true }
      },
      streamCodexKernel: async () => {
        hops++
        return { ok: true }
      },
    },
  })
  assert.equal(healthChecks, 1)
  assert.equal(starts, 0)
  assert.equal(configs, 0)
  assert.equal(hops, 0)
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.error.code, 'codex_kernel_unavailable')
})

test('one operation deadline covers OAuth refresh and the remaining retry without resetting', {
  timeout: 3000,
}, async (t) => {
  for (const expiresDuring of ['refresh', 'retry']) {
    const { root } = fixture(t)
    let calls = 0
    let refreshSignal
    const server = http.createServer(async (req, res) => {
      req.resume()
      calls++
      if (calls === 1) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":{"code":"unauthorized","message":"401 Unauthorized"}}')
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => {
      server.closeAllConnections()
      server.close()
    })
    const signal = AbortSignal.timeout(150)
    const result = await runVmTestChat({
      projectRoot: root,
      vmId: 'vm-gpt',
      model: 'gpt-5.4',
      prompt: PELICAN_TEST_PROMPT,
      apiKey: 'test-master',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      timeoutMs: 600000,
      timeoutCapMs: 600000,
      signal,
      fetchImpl: async (_url, init) => {
        refreshSignal = init.signal
        if (expiresDuring === 'refresh') {
          await new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          )
        } else {
          await delay(70)
          return { status: 200, json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh' }) }
        }
      },
    })
    assert.equal(refreshSignal, signal)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'aborted')
    assert.equal(calls, expiresDuring === 'refresh' ? 1 : 2)
    assert.ok(result.duration_ms < 1000)
  }
})

test('JSON whitespace heartbeat preserves the envelope and stops on completion or disconnect', async () => {
  for (const disconnect of [false, true]) {
    const res = new EventEmitter()
    const chunks = []
    res.destroyed = false
    res.writableEnded = false
    res.writeHead = (_status, headers) => {
      res.headers = headers
    }
    res.write = (chunk) => chunks.push(chunk)
    res.end = (chunk) => {
      chunks.push(chunk)
      res.writableEnded = true
    }
    let finish
    const task = new Promise((resolve) => {
      finish = resolve
    })
    const responding = respondPelicanTest({ req: { headers: {} }, res, run: () => task, heartbeatMs: 10 })
    await delay(25)
    assert.ok(chunks.length > 0)
    assert.ok(chunks.every((chunk) => /^\s+$/.test(chunk)))
    if (disconnect) {
      res.destroyed = true
      res.emit('close')
    }
    finish({ ok: true, text: '<html></html>' })
    await responding
    const writes = chunks.length
    await delay(25)
    assert.equal(chunks.length, writes)
    assert.equal(res.listenerCount('close'), 0)
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
    if (!disconnect)
      assert.deepEqual(JSON.parse(chunks.join('')), { ok: true, data: { ok: true, text: '<html></html>' } })
    else assert.equal(res.writableEnded, false)
  }
})
