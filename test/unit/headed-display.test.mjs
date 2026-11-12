import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHeadedDisplay } from '../../src/lib/browser/headed-display.mjs'

function fixture() {
  const calls = []
  const children = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.pid = 100 + children.length
    child.command = command
    child.stdio = [null, null, null, new PassThrough()]
    child.kill = (signal) => {
      calls.push({ command, signal })
      queueMicrotask(() => child.emit('exit', 0, signal))
      return true
    }
    children.push(child)
    if (command === 'Xvfb') queueMicrotask(() => child.stdio[3].write('73\n'))
    return child
  }
  return { calls, children, dependencies: { spawn, waitForWindowManager: async () => {} } }
}

test('virtual desktop starts Xvfb at full HD and Openbox on its allocated display, then closes in reverse order', async () => {
  const f = fixture()
  const display = await createHeadedDisplay({}, f.dependencies)
  assert.equal(display.env.DISPLAY, ':73')
  assert.deepEqual(f.calls[0].args, ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-noreset'])
  assert.equal(f.calls[1].command, 'openbox')
  assert.deepEqual(f.calls[1].args, ['--sm-disable'])
  assert.equal(f.calls[1].options.env.DISPLAY, ':73')
  await display.close()
  await display.close()
  assert.deepEqual(f.calls.slice(2), [
    { command: 'openbox', signal: 'SIGTERM' },
    { command: 'Xvfb', signal: 'SIGTERM' },
  ])
})

test('failed window-manager readiness closes both helper processes', async () => {
  const f = fixture()
  await assert.rejects(
    createHeadedDisplay(
      {},
      {
        ...f.dependencies,
        waitForWindowManager: async () => {
          throw new Error('fixture readiness failure')
        },
      },
    ),
    /fixture readiness failure/,
  )
  assert.deepEqual(
    f.calls.slice(2).map((call) => call.command),
    ['openbox', 'Xvfb'],
  )
})

test('cancellation before starting creates no display process', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(createHeadedDisplay({ signal: controller.signal }, f.dependencies), { name: 'AbortError' })
  assert.deepEqual(f.calls, [])
})

test('an incomplete display close remains retryable and retains Xvfb until Openbox exits', async () => {
  const f = fixture()
  let failed = true
  const stopped = []
  const display = await createHeadedDisplay(
    {},
    {
      ...f.dependencies,
      stopProcess: async (state) => {
        if (failed && state.child.command === 'openbox') throw new Error('fixture close failure')
        stopped.push(state.child.command)
      },
    },
  )
  await assert.rejects(display.close(), /fixture close failure/)
  assert.deepEqual(stopped, [])
  failed = false
  await display.close()
  assert.deepEqual(stopped, ['openbox', 'Xvfb'])
})
