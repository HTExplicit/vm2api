import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { useVmColumnOrder } from './use-vm-column-order'

afterEach(() => vi.unstubAllGlobals())

it('removes the old priority column without moving other saved columns', () => {
  vi.stubGlobal('localStorage', {
    getItem: () =>
      JSON.stringify(['cost', 'type', 'usage', 'vm', 'sched', 'req', 'status']),
  })
  function Columns() {
    return <output>{useVmColumnOrder().order.join(',')}</output>
  }
  expect(renderToStaticMarkup(<Columns />)).toBe(
    '<output>cost,usage,vm,sched,req,status</output>'
  )
})
