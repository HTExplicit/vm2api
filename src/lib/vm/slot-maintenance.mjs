import { clearRustHealthCache } from '../transport/kernel-router.mjs'

/** Caller owns the VM lifecycle lock. Keep the watchdog off the cutover; scheduling is untouched. */
export async function withSlotMaintenance({ id, watchdog, poolScheduler, operation }) {
  try {
    await watchdog?.hold?.(id)
    return await operation()
  } finally {
    clearRustHealthCache(id)
    poolScheduler?.healthCache?.delete?.(id)
    watchdog?.release?.(id)
  }
}
