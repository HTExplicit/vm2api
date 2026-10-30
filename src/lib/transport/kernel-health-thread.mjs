import { Worker } from 'node:worker_threads'

let current = null
let sequence = 0

function failPending(state, error) {
  if (current === state) current = null
  for (const request of state.pending.values()) request.reject(error)
  state.worker.unref()
}

function healthWorker() {
  if (current) return current
  const worker = new Worker(new URL('./kernel-health-worker.mjs', import.meta.url), {
    name: 'vm2api-kernel-health',
  })
  const state = { worker, pending: new Map() }
  current = state
  worker.on('message', ({ id, health }) => state.pending.get(id)?.resolve(health))
  worker.once('error', (error) => failPending(state, error))
  worker.once('exit', (code) => {
    failPending(
      state,
      Object.assign(new Error(`kernel health worker exited (${code})`), { code: 'worker_unavailable' }),
    )
  })
  worker.unref()
  return state
}

// Keep health I/O and its deadline independent of synchronous panel queries.
export function kernelHealthInWorker(exec, { timeoutMs = 3000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' }))
      return
    }
    const state = healthWorker()
    const id = ++sequence
    const finish = (settle, value) => {
      if (!state.pending.delete(id)) return
      signal?.removeEventListener('abort', onAbort)
      if (state.pending.size === 0) state.worker.unref()
      settle(value)
    }
    const request = {
      resolve: (value) => finish(resolve, value),
      reject: (error) => finish(reject, error),
    }
    const onAbort = () => {
      try {
        state.worker.postMessage({ type: 'abort', id })
      } catch (error) {
        request.reject(error)
      }
    }
    state.pending.set(id, request)
    signal?.addEventListener('abort', onAbort, { once: true })
    state.worker.ref()
    try {
      state.worker.postMessage({ type: 'health', id, exec, timeoutMs })
    } catch (error) {
      request.reject(error)
    }
  })
}
