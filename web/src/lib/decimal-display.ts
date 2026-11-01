/** Trim display-only decimal zeroes without converting precise balances to a float. */
export function trimDecimalZeros(value: string | number): string {
  const text = String(value).trim()
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return text
  const trimmed = text.includes('.')
    ? text.replace(/0+$/, '').replace(/\.$/, '')
    : text
  return /^[+-]?0+$/.test(trimmed) ? '0' : trimmed
}

/** Display balances with at most two decimal places, truncating without floats. */
export function formatBalanceAmount(value: string | number): string {
  const text = String(value).trim()
  const match = text.match(/^([+-]?\d+)(?:\.(\d+))?$/)
  if (!match) return text
  const fraction = match[2]?.slice(0, 2)
  return trimDecimalZeros(`${match[1]}${fraction ? `.${fraction}` : ''}`)
}
