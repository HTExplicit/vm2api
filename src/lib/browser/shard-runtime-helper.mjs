import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SHARD_HELPER_PATH = fileURLToPath(new URL('../../../generated/shardbrowser/helper.cjs', import.meta.url))
export const SHARD_SDK_VERSION = '2.1.6'

/** Execute the independent installer/profile bundle; it never launches a page. */
export function runShardHelper(command, args, { env = process.env, signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHARD_HELPER_PATH, command, ...args], {
      env,
      signal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    let tail = ''
    let result
    let processError
    const line = (value) => {
      let message
      try {
        message = JSON.parse(value)
      } catch {
        tail = `${tail}\n${value}`.slice(-2000)
        return
      }
      if (message.type === 'progress') onProgress(message)
      if (message.type === 'result') result = message.result
    }
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let boundary
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 1)
      }
    })
    child.stderr.on('data', (chunk) => {
      tail = `${tail}${chunk}`.slice(-2000)
    })
    child.once('error', (error) => {
      processError = error
    })
    child.once('close', (code) => {
      if (buffer.trim()) line(buffer)
      if (signal?.aborted) return reject(signal.reason || new Error('Browser operation cancelled'))
      if (processError) return reject(processError)
      if (code === 0 && result) return resolve(result)
      reject(
        Object.assign(new Error(tail.trim() || 'Shard helper did not complete'), { code: 'browser_helper_failed' }),
      )
    })
  })
}

export function prepareShardProfile({ cacheDir, profileDir, timezone, env, signal }) {
  return runShardHelper('create-profile', [cacheDir, profileDir, timezone], { env, signal })
}
