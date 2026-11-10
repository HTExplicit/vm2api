import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('../../scripts/fetch-payload.mjs', import.meta.url))

test('payload downloads honor per-file releases and --pin returns all files to one release', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-payload-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const base = Buffer.from('pinned kernel')
  const cli = Buffer.from('new cli-node')
  const responses = new Map([
    ['/base/kin-kernel', base],
    ['/v1.4.061/cli-node', cli],
  ])
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    const body = responses.get(req.url)
    res.writeHead(body ? 200 : 404)
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const file = (target, asset, body, release) => ({
    path: target,
    asset,
    size: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    ...(release ? { release } : {}),
  })
  const manifest = path.join(dir, 'payload.json')
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      repo: 'unused/offline',
      release: 'base',
      files: [file('bin/kin-kernel', 'kin-kernel', base), file('share/cli-node', 'cli-node', cli, 'v1.4.061')],
    }),
  )
  const args = [script, '--manifest', manifest, '--dest', dir]
  await execute(process.execPath, args, {
    env: { ...process.env, VM2API_PAYLOAD_BASE_URL: `http://127.0.0.1:${server.address().port}` },
  })
  assert.deepEqual(requests, ['/base/kin-kernel', '/v1.4.061/cli-node'])
  assert.deepEqual(fs.readFileSync(path.join(dir, 'share/cli-node')), cli)
  await execute(process.execPath, [...args, '--check'])
  await execute(process.execPath, [...args, '--pin', 'fork-release'])
  const pinned = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  assert.equal(pinned.release, 'fork-release')
  assert.ok(pinned.files.every((entry) => !Object.hasOwn(entry, 'release')))
})
