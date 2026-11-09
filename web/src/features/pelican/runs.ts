import type {
  PelicanAccount,
  PelicanBatch,
  PelicanItem,
  PelicanResult,
} from './types'

type RunState = {
  batches: PelicanBatch[]
  ready: boolean
  running: boolean
  storageError: string | null
}

type History = {
  load: () => Promise<PelicanBatch[]>
  save: (batch: PelicanBatch) => Promise<void>
  clear: () => Promise<void>
}

type Request = (
  vmId: string,
  model: string,
  effort: string
) => Promise<PelicanResult>

/** A page-local batch runner. Only the history, never requests, survives reload. */
export class PelicanRuns {
  private state: RunState = {
    batches: [],
    ready: false,
    running: false,
    storageError: null,
  }
  private listeners = new Set<() => void>()
  private loading?: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private request: Request,
    private history: History
  ) {}

  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(patch: Partial<RunState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  private storageFailure(error: unknown) {
    this.publish({
      storageError: `本地历史保存不可用：${error instanceof Error ? error.message : String(error)}。当前结果仍可查看和下载。`,
    })
  }

  load = () => {
    this.loading ??= this.history
      .load()
      .then((saved) => {
        const batches = saved.map((batch) => ({
          ...batch,
          results: batch.results.map((item): PelicanItem =>
            item.status === 'queued' || item.status === 'running'
              ? { ...item, status: 'interrupted' }
              : item
          ),
        }))
        this.publish({ batches, ready: true })
      })
      .catch((error: unknown) => {
        this.storageFailure(error)
        this.publish({ ready: true })
      })
    return this.loading
  }

  private save(batch: PelicanBatch) {
    this.writes = this.writes
      .then(() => this.history.save(batch))
      .catch((error: unknown) => {
        this.storageFailure(error)
      })
  }

  private update(batchId: string, itemId: string, patch: Partial<PelicanItem>) {
    const batches = this.state.batches.map((batch) =>
      batch.id === batchId
        ? {
            ...batch,
            results: batch.results.map((item) =>
              item.id === itemId ? { ...item, ...patch } : item
            ),
          }
        : batch
    )
    this.publish({ batches })
    this.save(batches.find((batch) => batch.id === batchId)!)
  }

  start = (accounts: PelicanAccount[], model: string, effort: string) => {
    if (!this.state.ready || this.state.running || !accounts.length || !model)
      return
    const batch: PelicanBatch = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      model,
      reasoningEffort: effort,
      results: accounts.map((account) => ({
        ...account,
        id: crypto.randomUUID(),
        status: 'running',
      })),
    }
    this.publish({ batches: [batch, ...this.state.batches], running: true })
    this.save(batch)
    void this.execute(batch, batch.results)
  }

  private async execute(batch: PelicanBatch, items: PelicanItem[]) {
    await Promise.all(
      items.map(async (item) => {
        let result: PelicanResult
        const started = Date.now()
        try {
          result = await this.request(
            item.vmId,
            batch.model,
            batch.reasoningEffort
          )
        } catch (error) {
          result = {
            ok: false,
            vm_id: item.vmId,
            model: batch.model,
            reasoning_effort: batch.reasoningEffort,
            text: null,
            duration_ms: Date.now() - started,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
        this.update(batch.id, item.id, {
          status: result.ok ? 'success' : 'error',
          result,
        })
      })
    )
    this.publish({ running: false })
  }

  retry = (batchId: string, itemId: string) => {
    if (this.state.running) return
    const batch = this.state.batches.find(
      (candidate) => candidate.id === batchId
    )
    const item = batch?.results.find((candidate) => candidate.id === itemId)
    if (
      !batch ||
      !item ||
      !['error', 'cancelled', 'interrupted'].includes(item.status)
    )
      return
    this.publish({ running: true })
    this.update(batchId, itemId, { status: 'running', result: undefined })
    void this.execute(batch, [item])
  }

  clear = async () => {
    if (this.state.running) return
    await this.writes
    try {
      await this.history.clear()
      this.publish({ batches: [], storageError: null })
    } catch (error) {
      this.storageFailure(error)
    }
  }
}
