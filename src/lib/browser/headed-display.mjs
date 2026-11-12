import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const exec = promisify(execFile)

function problem(code, message) {
  return Object.assign(new Error(message), { code })
}

function processState(child) {
  const state = { child, exited: false, error: null }
  state.done = new Promise((resolve) => {
    child.once('exit', () => {
      state.exited = true
      resolve()
    })
    child.once('error', (error) => {
      state.error = error
      if (!child.pid) {
        state.exited = true
        resolve()
      }
    })
  })
  return state
}

async function stopProcess(state, timeout = 5000) {
  if (!state || state.exited) return
  const wait = async () => {
    let timer
    try {
      return await Promise.race([
        state.done.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeout)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  state.child.kill('SIGTERM')
  if (await wait()) return
  state.child.kill('SIGKILL')
  if (!(await wait())) throw problem('browser_display_close_failed', '浏览器显示进程尚未退出，请重试关闭。')
}

function displayNumber(state, signal, timeout) {
  return new Promise((resolve, reject) => {
    const stream = state.child.stdio[3]
    let value = ''
    const finish = (error, number) => {
      clearTimeout(timer)
      stream.off('data', data)
      state.child.off('error', failed)
      state.child.off('exit', failed)
      signal?.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve(number)
    }
    const failed = () => finish(problem('browser_display_failed', '无法启动浏览器虚拟显示。'))
    const aborted = () => finish(signal.reason)
    const data = (chunk) => {
      value += chunk.toString()
      if (!value.includes('\n')) return
      const number = value.trim()
      if (!/^\d+$/.test(number)) return failed()
      finish(null, number)
    }
    const timer = setTimeout(failed, timeout)
    stream.on('data', data)
    state.child.once('error', failed)
    state.child.once('exit', failed)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted()
  })
}

async function waitForWindowManager(env, signal, states) {
  for (let attempt = 0; attempt < 50; attempt++) {
    signal?.throwIfAborted()
    if (states.some((state) => state.exited || state.error)) break
    try {
      const { stdout } = await exec('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], {
        env,
        timeout: 1000,
        windowsHide: true,
      })
      if (/window id # 0x[0-9a-f]+/i.test(stdout)) return
    } catch {}
    await delay(100, undefined, { signal })
  }
  throw problem('browser_display_failed', '浏览器窗口管理器未就绪。')
}

/** One real X11 desktop for the single active account browser. */
export async function createHeadedDisplay({ signal } = {}, overrides = {}) {
  signal?.throwIfAborted()
  const spawnProcess = overrides.spawn || spawn
  const stop = overrides.stopProcess || stopProcess
  let xvfb
  let openbox
  let closing
  let env
  const close = () => {
    if (closing) return closing
    closing = (async () => {
      await stop(openbox)
      await stop(xvfb)
    })().finally(() => {
      closing = null
    })
    return closing
  }
  try {
    xvfb = processState(
      spawnProcess('Xvfb', ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-noreset'], {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
        windowsHide: true,
      }),
    )
    const number = await displayNumber(xvfb, signal, overrides.startTimeout || 10_000)
    env = { ...process.env, DISPLAY: `:${number}` }
    signal?.throwIfAborted()
    openbox = processState(spawnProcess('openbox', ['--sm-disable'], { env, stdio: 'ignore', windowsHide: true }))
    await (overrides.waitForWindowManager || waitForWindowManager)(env, signal, [xvfb, openbox])
    signal?.throwIfAborted()
    return { env, close }
  } catch (error) {
    try {
      await close()
    } catch (closeError) {
      closeError.pendingDisplay = { env, close }
      throw closeError
    }
    throw error
  }
}
