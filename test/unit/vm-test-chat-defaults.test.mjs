import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { readVmTestChatDefaults, resolveVmTestChatPrompt } from '../../src/lib/admin/vm-test-chat-defaults.mjs'

test('test-chat defaults persist the original text, validate the limit, and keep read/write permissions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-test-chat-defaults-'))
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  openDatabase({ dataDir: root })
  const settings = new SettingsRepo()
  settings.set('vm_test_schedule:vm-existing', { prompt: 'scheduled original', enabled: false })
  const call = async (role, method, body) => {
    let response
    const handler = createPanelHandler({
      cfg: { paths: { project: root } },
      routingConfig: {},
      requireAuth(req) {
        Object.assign(req, { panelUser: role, panelRole: role })
        return true
      },
      readBody: async () => body,
      json(_res, status, payload) {
        response = { status, payload }
      },
    })
    await handler({ method, headers: {} }, {}, new URL('http://localhost/api/panel/test-chat/defaults'))
    return response
  }
  assert.deepEqual((await call('admin', 'GET')).payload.data, { prompt: 'hello' })
  assert.equal((await call('user', 'GET')).status, 200)
  assert.equal((await call('super', 'GET')).status, 403)
  assert.equal((await call('user', 'PUT', { prompt: 'unauthorized' })).status, 403)
  const original = '  新默认提示词\n保留原始换行和空格  '
  assert.deepEqual((await call('admin', 'PUT', { prompt: original })).payload.data, { prompt: original })
  assert.deepEqual((await call('user', 'GET')).payload.data, { prompt: original })
  assert.equal(resolveVmTestChatPrompt(undefined, settings), original)
  assert.equal(resolveVmTestChatPrompt(' \n\t ', settings), original)
  assert.equal(resolveVmTestChatPrompt('once', settings), 'once')
  assert.equal(settings.get('vm_test_schedule:vm-existing').prompt, 'scheduled original')
  for (const prompt of ['', ' \n ', 42, 'x'.repeat(16001)]) {
    const rejected = await call('admin', 'PUT', { prompt })
    assert.equal(rejected.status, 400)
    assert.equal(rejected.payload.error.code, 'invalid_test_chat_defaults')
    assert.equal(readVmTestChatDefaults(settings).prompt, original)
  }
  assert.equal((await call('admin', 'PUT', { prompt: 'x'.repeat(16000) })).status, 200)
})
