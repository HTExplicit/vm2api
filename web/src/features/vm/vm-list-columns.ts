import { useState } from 'react'

export const CLASSIC_COLUMNS = [
  'vm',
  'sched',
  'type',
  'status',
  'req',
  'usage',
  'cost',
] as const
export const METRIC_COLUMNS = [
  'health',
  '5h',
  '7d',
  'fable',
  'today',
  'seats',
  'queue',
  'inflight',
  'spend',
  'tokens',
  'perReq',
  'total',
] as const
export type MetricKey = (typeof METRIC_COLUMNS)[number]
export type ColumnKey = (typeof CLASSIC_COLUMNS)[number] | MetricKey
const ALL_COLUMNS = [...CLASSIC_COLUMNS, ...METRIC_COLUMNS]
const KEY = 'kin.vm.list-columns.v1'
const LEGACY_KEY = 'kin.vm.column-order'

/** Minimum readable widths in rem. The pinned identity adapts to the scroll viewport. */
export const COLUMNS: Record<ColumnKey, { label: string; width: number }> = {
  vm: { label: '账号', width: 14 },
  sched: { label: '调度', width: 3.6 },
  type: { label: '类型', width: 6.4 },
  status: { label: '状态', width: 10.3 },
  req: { label: '今日 / 7D 请求', width: 10.5 },
  usage: { label: '用量窗口', width: 15 },
  cost: { label: '成本', width: 6.2 },
  health: { label: '24h 健康', width: 9 },
  '5h': { label: '5H 已用', width: 7 },
  '7d': { label: '7D 已用', width: 7 },
  fable: { label: 'Fable 用量', width: 7.5 },
  today: { label: '今日请求', width: 6 },
  seats: { label: '席位占用', width: 6 },
  queue: { label: '排队', width: 4.5 },
  inflight: { label: '请求中', width: 5 },
  spend: { label: '7D 费用', width: 7 },
  tokens: { label: '7D Token', width: 7 },
  perReq: { label: '每请求费用', width: 7 },
  total: { label: '累计费用', width: 7 },
}

type Preferences = { order: ColumnKey[]; visible: ColumnKey[] }
const known = (key: unknown): key is ColumnKey =>
  ALL_COLUMNS.some((k) => k === key)
export function normalizeColumns(
  order: unknown,
  visible: unknown
): Preferences {
  const saved = Array.isArray(order) ? order.filter(known) : []
  const selected = Array.isArray(visible)
    ? visible.filter(known)
    : [...CLASSIC_COLUMNS]
  return {
    order: [...new Set<ColumnKey>(['vm', ...saved, ...ALL_COLUMNS])],
    visible: [...new Set<ColumnKey>(['vm', ...selected])],
  }
}
function read(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (saved && Array.isArray(saved.order) && Array.isArray(saved.visible))
      return normalizeColumns(saved.order, saved.visible)
  } catch {
    /* Fall back to the original seven-column preference. */
  }
  try {
    return normalizeColumns(
      JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'),
      null
    )
  } catch {
    return normalizeColumns(null, null)
  }
}

export function useListColumns() {
  const [prefs, setPrefs] = useState(read)
  const visible = prefs.order.filter((k) => prefs.visible.includes(k))
  const save = (next: Preferences) => {
    setPrefs(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* Current-tab preference remains usable. */
    }
  }
  function toggle(key: ColumnKey) {
    if (key === 'vm') return
    save({
      ...prefs,
      visible: prefs.visible.includes(key)
        ? prefs.visible.filter((k) => k !== key)
        : [...prefs.visible, key],
    })
  }
  function move(from: ColumnKey, to: ColumnKey) {
    if (from === 'vm' || to === 'vm' || from === to) return
    const order = prefs.order.filter((k) => k !== from)
    order.splice(prefs.order.indexOf(to), 0, from)
    save({ ...prefs, order })
  }
  return {
    visible,
    toggle,
    move,
    reset: () => save(normalizeColumns(null, null)),
  }
}
