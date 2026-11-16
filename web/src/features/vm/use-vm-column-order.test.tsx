import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeColumnOrder,
  useVmColumnOrder,
  VM_COLUMN_KEYS,
} from './use-vm-column-order'

afterEach(() => vi.unstubAllGlobals())

it('removes retired columns without moving saved columns', () => {
  vi.stubGlobal('localStorage', {
    getItem: () =>
      JSON.stringify(['cost', 'type', 'usage', 'vm', 'sched', 'req', 'status']),
  })
  function Columns() {
    return <output>{useVmColumnOrder().order.join(',')}</output>
  }
  expect(renderToStaticMarkup(<Columns />)).toBe(
    '<output>cost,usage,vm,status</output>'
  )
})

describe('normalizeColumnOrder', () => {
  it('drops retired type / req / sched keys from a stored order and keeps the rest', () => {
    expect(
      normalizeColumnOrder([
        'cost',
        'type',
        'vm',
        'req',
        'status',
        'sched',
        'usage',
      ])
    ).toEqual(['cost', 'vm', 'status', 'usage'])
  })

  it('fills missing keys and survives garbage', () => {
    expect(normalizeColumnOrder(['usage'])).toEqual([
      'usage',
      'vm',
      'status',
      'cost',
    ])
    expect(normalizeColumnOrder('nope')).toEqual([...VM_COLUMN_KEYS])
  })
})
