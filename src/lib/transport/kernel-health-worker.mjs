import { parentPort } from 'node:worker_threads'
import { workerHealth } from './go-worker-client.mjs'

const controllers = new Map()

parentPort.on('message', async ({ type, id, exec, timeoutMs }) => {
  if (type === 'abort') {
    controllers.get(id)?.abort()
    return
  }
  const controller = new AbortController()
  controllers.set(id, controller)
  try {
    const health = await workerHealth(exec, { timeoutMs, signal: controller.signal })
    parentPort.postMessage({ id, health })
  } catch (error) {
    parentPort.postMessage({
      id,
      health: {
        ok: false,
        status: 0,
        error: String(error.message || error).slice(0, 300),
        code: error.code || 'worker_unavailable',
      },
    })
  } finally {
    controllers.delete(id)
  }
})
