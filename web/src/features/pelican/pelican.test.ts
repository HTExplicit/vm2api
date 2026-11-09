import { describe, expect, it, vi } from 'vitest'
import { extractPelicanHtml } from './output'
import { PelicanRuns } from './runs'
import type { PelicanBatch, PelicanResult } from './types'

const success = (vmId: string): PelicanResult => ({
  ok: true,
  vm_id: vmId,
  model: 'gpt-test',
  reasoning_effort: 'medium',
  text: '<html><body>pelican</body></html>',
  duration_ms: 12,
})

describe('pelican results', () => {
  it('extracts full documents and SVG without treating prose as a preview', () => {
    const html = '<!doctype html><html><body><svg></svg></body></html>'
    expect(extractPelicanHtml(`作品：\n\n\`\`\`html\n${html}\n\`\`\``)).toBe(
      html
    )
    expect(extractPelicanHtml(html)).toBe(html)
    expect(
      extractPelicanHtml('```svg\n<svg viewBox="0 0 960 600"></svg>\n```')
    ).toContain('<html>')
    expect(extractPelicanHtml('没有生成代码')).toBeNull()
  })

  it('dispatches every selected account immediately and keeps failures independent', async () => {
    const pending: {
      resolve: (result: PelicanResult) => void
      reject: (error: Error) => void
    }[] = []
    const request = vi.fn(
      (vmId: string) =>
        new Promise<PelicanResult>((resolve, reject) => {
          pending.push({
            resolve: (result) => resolve({ ...result, vm_id: vmId }),
            reject,
          })
        })
    )
    const runner = new PelicanRuns(request, {
      load: async () => [],
      save: async () => {},
      clear: async () => {},
    })
    await runner.load()
    runner.start(
      ['a', 'b', 'c', 'd'].map((vmId) => ({ vmId, vmName: vmId })),
      'gpt-test',
      'medium'
    )
    expect(request.mock.calls.map(([vmId]) => vmId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
    expect(
      runner
        .snapshot()
        .batches[0].results.every((item) => item.status === 'running')
    ).toBe(true)
    pending[0].reject(new Error('受限'))
    pending[3].resolve(success('d'))
    await vi.waitFor(() =>
      expect(
        runner.snapshot().batches[0].results.map((item) => item.status)
      ).toEqual(['error', 'running', 'running', 'success'])
    )
    pending[1].resolve(success('b'))
    pending[2].resolve(success('c'))
    await vi.waitFor(() => expect(runner.snapshot().running).toBe(false))
    expect(
      runner
        .snapshot()
        .batches[0].results.map((item) => [item.vmId, item.status])
    ).toEqual([
      ['a', 'error'],
      ['b', 'success'],
      ['c', 'success'],
      ['d', 'success'],
    ])
    const failed = runner.snapshot().batches[0]
    runner.retry(failed.id, failed.results[0].id)
    expect(request).toHaveBeenCalledTimes(5)
    pending[4].resolve(success('a'))
    await vi.waitFor(() => expect(runner.snapshot().running).toBe(false))
    expect(
      runner
        .snapshot()
        .batches[0].results.every((item) => item.status === 'success')
    ).toBe(true)
  })

  it('restores legacy unfinished records without sending requests and clears persisted history', async () => {
    let saved: PelicanBatch[] = [
      {
        id: 'old-batch',
        createdAt: 1,
        model: 'gpt-test',
        reasoningEffort: 'high',
        results: [
          { id: 'a', vmId: 'a', vmName: 'a', status: 'running' },
          { id: 'b', vmId: 'b', vmName: 'b', status: 'queued' },
          { id: 'c', vmId: 'c', vmName: 'c', status: 'cancelled' },
          {
            id: 'd',
            vmId: 'd',
            vmName: 'd',
            status: 'success',
            result: success('d'),
          },
        ],
      },
    ]
    const request = vi.fn(async (vmId: string) => success(vmId))
    const history = {
      load: async () => saved,
      save: async (batch: PelicanBatch) => {
        saved = [structuredClone(batch)]
      },
      clear: vi.fn(async () => {
        saved = []
      }),
    }
    const restored = new PelicanRuns(request, history)
    await restored.load()
    expect(
      restored.snapshot().batches[0].results.map((item) => item.status)
    ).toEqual(['interrupted', 'interrupted', 'cancelled', 'success'])
    expect(request).not.toHaveBeenCalled()
    await restored.clear()
    expect(history.clear).toHaveBeenCalledOnce()
    expect(restored.snapshot().batches).toEqual([])
    expect(saved).toEqual([])
  })
})
