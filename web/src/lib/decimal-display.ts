/** Trim display-only decimal zeroes without converting precise balances to a float. */
export function trimDecimalZeros(value: string | number): string {
  const text = String(value).trim()
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return text
  const trimmed = text.includes('.')
    ? text.replace(/0+$/, '').replace(/\.$/, '')
    : text
  return /^[+-]?0+$/.test(trimmed) ? '0' : trimmed
}
