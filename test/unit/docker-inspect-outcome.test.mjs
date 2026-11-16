import test from 'node:test'
import assert from 'node:assert/strict'
import {
  destroyVmRuntime,
  discardSlotContainer,
  inspectContainerOutcome,
  preflightSlotContainerDiscard,
} from '../../src/lib/vm/vm-runtime.mjs'
import { isDockerInspectNotFound } from '../../src/lib/vm/docker-container.mjs'

test('isDockerInspectNotFound matches docker inspect stderr for absent names', () => {
  assert.equal(isDockerInspectNotFound({ stderr: 'Error: No such object: kin-05' }), true)
  assert.equal(isDockerInspectNotFound({ stderr: 'Error response from daemon: No such container: kin-05' }), true)
  assert.equal(isDockerInspectNotFound({ stderr: 'Cannot connect to the Docker daemon' }), false)
})

test('inspectContainerOutcome: missing container', () => {
  const outcome = inspectContainerOutcome('kin-ghost', {
    run: () => ({
      ok: false,
      stderr: 'Error: No such object: kin-ghost',
      stdout: '',
      code: 1,
    }),
  })
  assert.deepEqual(outcome, { status: 'missing' })
})

test('inspectContainerOutcome: daemon down is an error, not missing', () => {
  const outcome = inspectContainerOutcome('kin-01', {
    run: () => ({
      ok: false,
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
      stdout: '',
      code: 1,
    }),
  })
  assert.equal(outcome.status, 'error')
  assert.match(outcome.error, /Cannot connect/)
})

test('inspectContainerOutcome: found parses running state', () => {
  const outcome = inspectContainerOutcome('kin-01', {
    run: () => ({
      ok: true,
      stdout: 'true|12345|kin-px-net|2026-01-01T00:00:00Z|img|host|docker||false',
      stderr: '',
    }),
  })
  assert.equal(outcome.status, 'found')
  assert.equal(outcome.container.running, true)
  assert.equal(outcome.container.pid, 12345)
})

test('destroyVmRuntime only succeeds when deletion or absence is confirmed', async (t) => {
  const found = { ok: true, stdout: 'true|12345|bridge||||||false', stderr: '' }
  const missing = { ok: false, stderr: 'Error: No such object: kin-delete' }
  const unavailable = { ok: false, stderr: 'Cannot connect to the Docker daemon' }
  const removed = { ok: true, stdout: 'kin-delete', stderr: '' }
  const failed = { ok: false, stderr: 'container removal failed' }
  for (const scenario of [
    { name: 'initial inspect fails', results: [unavailable], ok: false },
    { name: 'container is absent', results: [missing], ok: true, action: 'absent' },
    { name: 'remove succeeds without another inspect', results: [found, removed], ok: true, action: 'removed' },
    { name: 'failed removal leaves container', results: [found, failed, found], ok: false },
    { name: 'failed removal cannot be checked', results: [found, failed, unavailable], ok: false },
    { name: 'failed removal but container is gone', results: [found, failed, missing], ok: true, action: 'removed' },
  ]) {
    await t.test(scenario.name, () => {
      const runtime = { pid: 12345, ip: '127.0.0.1', stopped: false, removed: false }
      const vm = { id: 'vm-delete', runtime }
      const commands = []
      const result = destroyVmRuntime(vm, {
        run: (argv) => {
          commands.push(argv[1])
          assert.ok(commands.length <= scenario.results.length, 'unexpected Docker command')
          return scenario.results[commands.length - 1]
        },
      })
      assert.equal(result.ok, scenario.ok)
      assert.equal(result.action, scenario.action)
      assert.deepEqual(commands, ['inspect', 'rm', 'inspect'].slice(0, scenario.results.length))
      if (scenario.ok) {
        assert.deepEqual(vm.runtime, { pid: null, ip: null, stopped: true, removed: true })
      } else {
        assert.strictEqual(vm.runtime, runtime)
        assert.deepEqual(vm.runtime, { pid: 12345, ip: '127.0.0.1', stopped: false, removed: false })
        assert.ok(result.error)
      }
    })
  }
})

test('discardSlotContainer refuses an unavailable Docker inspect without removing the container', () => {
  const commands = []
  const outcome = discardSlotContainer('vm-01', {
    run(argv) {
      commands.push(argv)
      return { ok: false, stderr: 'Cannot connect to the Docker daemon' }
    },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'container_inspect_failed')
  assert.equal(commands.length, 1)
  assert.equal(commands[0][1], 'inspect')
})

test('slot container discard preflight only inspects and admits absent or stopped containers', () => {
  for (const scenario of [
    { stdout: 'false|0|bridge||||||false', expected: { ok: true, exists: true } },
    { stderr: 'Error: No such object: kin-01', expected: { ok: true, exists: false } },
    { stdout: 'true|123|bridge||||||false', code: 'vm_running' },
    { stdout: 'false|0|bridge||||||true', code: 'vm_running' },
  ]) {
    const commands = []
    const outcome = preflightSlotContainerDiscard('vm-01', {
      run(argv) {
        commands.push(argv)
        return { ok: !!scenario.stdout, stdout: scenario.stdout || '', stderr: scenario.stderr || '' }
      },
    })
    if (scenario.expected) assert.deepEqual(outcome, scenario.expected)
    else assert.equal(outcome.code, scenario.code)
    assert.equal(commands.length, 1)
    assert.equal(commands[0][1], 'inspect')
  }
})

const containerId = 'a'.repeat(64)
const found = { ok: true, stdout: containerId }
const removed = { ok: true, stdout: containerId }
const missing = { ok: false, code: 1, stderr: 'Error: No such container: kin-01' }
const unavailable = { ok: false, code: 1, stderr: 'Cannot connect to the Docker daemon' }

test('reclaim teardown removes the inspected container ID and confirms absence by name', () => {
  const replies = [found, removed, missing]
  const calls = []
  const outcome = destroyVmRuntime(
    { id: 'vm-01' },
    {
      requireConfirmation: true,
      run(argv) {
        calls.push(argv)
        return replies.shift()
      },
    },
  )
  assert.equal(outcome.teardownConfirmed, true)
  assert.equal(outcome.action, 'removed')
  assert.deepEqual(calls, [
    ['docker', 'container', 'inspect', '--format', '{{.Id}}', 'kin-01'],
    ['docker', 'rm', '-f', containerId],
    ['docker', 'container', 'inspect', '--format', '{{.Id}}', 'kin-01'],
  ])
})

test('no verified teardown on daemon failure, failed removal, or a replaced container', () => {
  for (const replies of [[unavailable], [found, unavailable], [found, removed, unavailable], [found, removed, found]]) {
    const outcome = destroyVmRuntime({ id: 'vm-01' }, { requireConfirmation: true, run: () => replies.shift() })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.teardownConfirmed, undefined)
  }
  const absent = destroyVmRuntime({ id: 'vm-01' }, { requireConfirmation: true, run: () => missing })
  assert.equal(absent.teardownConfirmed, true)
  assert.equal(absent.action, 'absent')
})
