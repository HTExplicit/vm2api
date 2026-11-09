import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { api } from '@/lib/api'
import { PelicanRuns } from './runs'
import {
  clearPelicanBatches,
  loadPelicanBatches,
  savePelicanBatch,
} from './storage'
import type { PelicanResult } from './types'

const runners = new Map<string, PelicanRuns>()

export function usePelicanRuns(scope: string) {
  const runs = useMemo(() => {
    const existing = runners.get(scope)
    if (existing) return existing
    const created = new PelicanRuns(
      (vmId, model, effort) =>
        api<PelicanResult>(
          `/api/panel/vms/${encodeURIComponent(vmId)}/pelican-test`,
          {
            method: 'POST',
            body: JSON.stringify({ model, reasoning_effort: effort }),
          }
        ),
      {
        load: () => loadPelicanBatches(scope),
        save: (batch) => savePelicanBatch(scope, batch),
        clear: () => clearPelicanBatches(scope),
      }
    )
    runners.set(scope, created)
    return created
  }, [scope])
  const state = useSyncExternalStore(runs.subscribe, runs.snapshot)
  useEffect(() => {
    void runs.load()
  }, [runs])
  return {
    ...state,
    start: runs.start,
    retry: runs.retry,
    clear: runs.clear,
  }
}
