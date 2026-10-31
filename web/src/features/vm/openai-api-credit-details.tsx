import type { OpenaiApiView } from '@/types/panel-vm'
import { trimDecimalZeros } from '@/lib/decimal-display'
import { fmtExpiresAt } from '@/lib/format'

export function openaiApiCreditDetailRows(
  state?: OpenaiApiView | null
): Array<[string, string]> {
  const rows: Array<[string, string]> = []
  if (state?.paid_balance != null)
    rows.push(['购买余额', `$${trimDecimalZeros(state.paid_balance)}`])
  if (state?.next_expiring_amount != null && state.next_expiring_at) {
    rows.push([
      '最近到期额度',
      `$${trimDecimalZeros(state.next_expiring_amount)}`,
    ])
    rows.push(['到期时间', fmtExpiresAt(state.next_expiring_at)])
  }
  return rows
}

export function OpenaiApiCreditDetails({
  state,
}: {
  state?: OpenaiApiView | null
}) {
  const rows = openaiApiCreditDetailRows(state)
  if (rows.length === 0) return null
  return (
    <dl
      className='grid grid-cols-2 gap-x-4 gap-y-2 text-sm'
      aria-label='API 余额明细'
    >
      {rows.map(([label, value]) => (
        <div key={label} className='contents'>
          <dt className='text-muted-foreground'>{label}</dt>
          <dd className='m-0 text-end tabular-nums'>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
