import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Eye,
  Layers,
  ExternalLink,
} from 'lucide-react'
import { credentialRegistrationOf } from '@/lib/cred-type'
import { fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  fmtHealthPct,
  HEALTH_FG,
  healthSummary,
  healthTone,
  SLOT_BG,
  type SlotState,
} from '@/lib/vm-health'
import {
  claudeTier,
  poolStatus,
  scheduleStateLabel,
  seatTitle,
  type ScheduleStateLabel,
  vmRequestingCount,
} from '@/lib/vm-status'
import {
  vmCostLedger,
  vmTodayStats,
  vmWeekOutcome,
  type VmWeekOutcome,
} from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { CredLaneChip } from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import { VmUsageWindows } from '@/features/vm/usage-windows'
import { VmAccountIdentity } from '@/features/vm/vm-account-identity'
import { VmActionMenu } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { GeminiSlotStatus } from '@/features/vm/vm-rack-blade'
import {
  vmWindows,
  type WindowKey,
  type WindowReadout,
  ZONES,
  zoneOf,
  type VmZone,
} from '@/features/vm/vm-rack-model'
import { VmRowDetail } from '@/features/vm/vm-row-detail'
import { schedulingPriorityTextClass } from '@/features/vm/vm-type-visual'

/** 行内点到这些元素时不切换展开。 */
const ROW_INTERACTIVE =
  'button, a, input, select, textarea, label, [role="switch"], [role="menuitem"], [data-row-stop]'

/** 早期七列结构；读数在各列内分行，窄屏由外层滚动。 */
const GRID: CSSProperties = {
  gridTemplateColumns:
    '34px minmax(190px,1.25fr) 56px minmax(104px,0.65fr) minmax(180px,1.1fr) minmax(190px,1.15fr) minmax(240px,1.5fr) minmax(110px,0.7fr) 56px',
}

/** 悬停才出现的次要信息。 */
const SEC =
  'group-data-[pin=true]/tbl:opacity-100 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 group-aria-expanded:opacity-100 motion-reduce:transition-none'

const TERT = 'text-[color:var(--text-tertiary)]'

const STATE_STYLE: Record<ScheduleStateLabel, string> = {
  开: 'text-[color:var(--status-ok)]',
  受限: 'text-[color:var(--status-warn)]',
  关: TERT,
  不可调度: 'text-[color:var(--status-bad)]',
}

function SchedCell({ vm }: { vm: Vm }) {
  return vm.gemini ? (
    <span className={TERT}>—</span>
  ) : (
    <SchedulableSwitch {...vmSchedulableProps(vm)} />
  )
}

function TypeCell({ vm }: { vm: Vm }) {
  const level = Number(vm.schedule_level)
  const valid = Number.isInteger(level) && level >= 1 && level <= 10
  const manual = vm.schedule_level_mode === 'manual'
  const registration = credentialRegistrationOf(vm)
  return (
    <div className='grid justify-items-start gap-2'>
      {vm.has_token ? (
        <CredLaneChip vm={vm} />
      ) : (
        <span className={TERT}>无凭证</span>
      )}
      <span
        className={cn(
          'rounded border border-border/70 px-1.5 py-0.5 text-xs font-semibold tabular-nums',
          valid ? schedulingPriorityTextClass(level) : TERT,
          valid && manual && 'shadow-[inset_0_0_0_1px_currentColor]'
        )}
        title={
          valid
            ? `${manual ? '手动' : '自动'}调度优先级，数值越大越优先`
            : '没有调度优先级'
        }
      >
        P{valid ? level : '—'}
        {valid && manual ? <span className='ml-1 text-[10px]'>手</span> : null}
      </span>
      {registration !== 'none' ? (
        <span className='text-[11px] text-muted-foreground'>
          注册 <span>{registration}</span>
        </span>
      ) : null}
    </div>
  )
}

function StatusCell({ vm }: { vm: Vm }) {
  if (vm.gemini)
    return (
      <div className='grid min-w-0 justify-items-start gap-1.5'>
        <GeminiSlotStatus vm={vm} />
        <ProxyChip vm={vm} compact className='max-w-full' />
      </div>
    )
  const tone = poolStatus(vm)
  const reason = vm.restriction_text || vm.unschedulable_text
  const requesting = vmRequestingCount(vm)
  const queue = Number(vm.queue_depth) || 0
  return (
    <div className='grid min-w-0 justify-items-start gap-2'>
      <div className='flex flex-wrap items-center gap-2'>
        <StatusMark tone={tone} variant='pill' className='text-xs' />
        {requesting > 0 ? (
          <span
            data-vm-requesting={requesting}
            title={`请求中 ${requesting}`}
            className='inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-[color:var(--tier-pro-solid)] px-1.5 font-mono text-xs font-semibold text-[color:var(--tier-pro-solid-fg)] tabular-nums'
          >
            <span className='sr-only'>请求中 </span>
            {requesting}
          </span>
        ) : null}
        {queue > 0 ? (
          <span className='text-xs text-muted-foreground'>
            排队{' '}
            <b className='font-mono font-medium text-foreground'>{queue}</b>
          </span>
        ) : null}
      </div>
      {reason ? (
        <span
          className={cn(
            'max-w-full text-xs leading-4 break-words',
            STATE_STYLE[scheduleStateLabel(vm)]
          )}
        >
          {reason}
        </span>
      ) : null}
      <div className='flex w-full min-w-0 items-end gap-1.5'>
        <HealthCell vm={vm} />
      </div>
      <ProxyChip vm={vm} compact className='max-w-full' />
    </div>
  )
}

function CountPill({ n, failed = false }: { n: number; failed?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-7 items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums',
        failed
          ? 'bg-[color:var(--status-bad-bg)] text-[color:var(--status-bad)]'
          : 'bg-[color:var(--status-ok-bg)] text-[color:var(--status-ok)]'
      )}
    >
      <span className='sr-only'>{failed ? '失败' : '成功'} </span>
      {fmtNum(n)}
    </span>
  )
}

function RequestCell({ r }: { r: RowData }) {
  return (
    <div className='grid min-w-0 justify-items-start gap-2 text-xs'>
      <div className='grid gap-1'>
        <div className='flex items-baseline gap-2'>
          <span className='w-7 shrink-0 text-muted-foreground'>今日</span>
          <b className='font-mono text-[13px] font-semibold text-[color:var(--status-ok)] tabular-nums'>
            {fmtUsd(r.todayCost, 2)}
          </b>
        </div>
        <span className='font-mono text-muted-foreground tabular-nums'>
          {fmtNum(r.today)} req · {fmtNum(r.todayTokens)} tok
        </span>
      </div>
      <div className='flex items-center gap-1.5' title='7D 成功 / 失败'>
        <span className='mr-0.5 w-7 shrink-0 text-muted-foreground'>7D</span>
        {r.week.known ? (
          <>
            <CountPill n={r.week.success} />
            <CountPill n={r.week.fail} failed />
          </>
        ) : (
          <span className='font-mono text-muted-foreground tabular-nums'>
            {fmtNum(r.week.req)} req · 失败 —
          </span>
        )}
      </div>
      {r.seatsMax != null ? (
        <span
          className='text-[11px] text-muted-foreground'
          title={seatTitle(r.vm)}
        >
          席位 {r.seatsUsed}/{r.seatsMax}
        </span>
      ) : null}
    </div>
  )
}

/** 颜色 + 高度双重编码（越高越糟），不只靠颜色。 */
const SLOT_HEIGHT: Record<SlotState, string> = {
  ok: '55%',
  slow: '78%',
  down: '100%',
  none: '2px',
}

function HealthCell({ vm }: { vm: Vm }) {
  const known = vm.health_24h !== undefined
  const h = healthSummary(vm.health_24h)
  return (
    <>
      <span
        role='img'
        aria-label='近 24 小时 48 格请求健康时间线'
        className='grid h-4 min-w-0 flex-1 auto-cols-fr grid-flow-col items-end gap-px'
      >
        {h.slots.map((s, i) => (
          <i
            key={i}
            className='block'
            style={{ height: SLOT_HEIGHT[s], backgroundColor: SLOT_BG[s] }}
          />
        ))}
      </span>
      {h.req ? (
        <>
          <b
            className={cn(
              'font-mono font-bold tabular-nums',
              HEALTH_FG[h.tone]
            )}
            title='近 24h 成功请求 ÷ 总请求'
          >
            {fmtHealthPct(h.pct)}
          </b>
        </>
      ) : (
        <span className={TERT}>{known ? '24h 无请求' : '24h 未知'}</span>
      )}
    </>
  )
}

/** 一行需要的数字，排序与渲染共用。 */
type RowData = {
  vm: Vm
  health: number | null
  hOk: number
  hReq: number
  win: Partial<Record<WindowKey, WindowReadout>>
  today: number
  todayCost: number
  todayTokens: number
  week: VmWeekOutcome
  seatsUsed: number
  seatsMax: number | null
  queue: number
  inflight: number
  spend: number
  tokens: number
  perReq: number | null
  total: number
}

function rowData(vm: Vm, accounts?: UsageAccountRow[]): RowData {
  const [, d7, total] = vmCostLedger(vm, accounts)
  const week = vmWeekOutcome(vm, accounts)
  const win: RowData['win'] = {}
  for (const w of vmWindows(vm)) win[w.key] = w
  const h = healthSummary(vm.health_24h)
  const today = vmTodayStats(vm, accounts)
  return {
    vm,
    health: h.pct,
    hOk: h.ok,
    hReq: h.req,
    win,
    today: today.req,
    todayCost: today.today,
    todayTokens: today.tok,
    week,
    seatsUsed: Number(vm.seats_used) || 0,
    seatsMax: vm.seats_max == null ? null : Number(vm.seats_max),
    queue: Number(vm.queue_depth) || 0,
    inflight: vmRequestingCount(vm),
    spend: d7.cost,
    tokens: d7.tokens,
    perReq: week.req > 0 && d7.cost ? d7.cost / week.req : null,
    total: total.cost,
  }
}

type SortKey =
  | 'health'
  | '5h'
  | '7d'
  | 'fable'
  | 'today'
  | 'seats'
  | 'queue'
  | 'inflight'
  | 'spend'
  | 'tokens'
  | 'perReq'
  | 'total'

const SORT_VALUE: Record<SortKey, (r: RowData) => number | null> = {
  health: (r) => r.health,
  '5h': (r) => r.win['5h']?.pct ?? null,
  '7d': (r) => r.win['7d']?.pct ?? null,
  fable: (r) => r.win.fable?.pct ?? null,
  today: (r) => r.today,
  seats: (r) => (r.seatsMax ? r.seatsUsed / r.seatsMax : null),
  queue: (r) => r.queue,
  inflight: (r) => r.inflight,
  spend: (r) => r.spend,
  tokens: (r) => r.tokens,
  perReq: (r) => r.perReq,
  total: (r) => r.total,
}

/** 健康默认升序（差的在前），其余默认降序。 */
const ASC_FIRST: ReadonlySet<SortKey> = new Set(['health'])

type Col = {
  label: string
  sort?: SortKey
  sortKeys?: SortKey[]
  num?: boolean
  dim?: boolean
  cell: (r: RowData, now: number) => ReactNode
}

const SORT_LABEL: Record<SortKey, string> = {
  health: '24h 成功率',
  '5h': '5H 用量',
  '7d': '7D 用量',
  fable: 'Fable 用量',
  today: '今日请求',
  seats: '席位占用',
  queue: '排队',
  inflight: '请求中',
  spend: '7D 费用',
  tokens: '7D token',
  perReq: '每请求成本',
  total: '累计费用',
}

const COLS: Col[] = [
  { label: '调度', cell: (r) => <SchedCell vm={r.vm} /> },
  { label: '类型', cell: (r) => <TypeCell vm={r.vm} /> },
  { label: '状态', sort: 'health', cell: (r) => <StatusCell vm={r.vm} /> },
  {
    label: '今日 / 7D 请求',
    sort: 'today',
    sortKeys: ['today', 'seats', 'queue', 'inflight'],
    cell: (r) => <RequestCell r={r} />,
  },
  {
    label: '用量窗口',
    sort: '5h',
    sortKeys: ['5h', '7d', 'fable'],
    cell: (r, now) => (
      <VmUsageWindows vm={r.vm} now={now} quiet summaryOnly quotaActions />
    ),
  },
  {
    label: '成本',
    sort: 'spend',
    sortKeys: ['spend', 'tokens', 'perReq', 'total'],
    cell: (r) => (
      <div className='grid min-w-0 gap-2 text-xs'>
        <div className='flex items-baseline justify-between gap-2'>
          <span className='text-muted-foreground'>7D</span>
          <b className='font-mono font-semibold tabular-nums'>
            {fmtUsd(r.spend, 2)}
          </b>
        </div>
        <div className='flex items-baseline justify-between gap-2'>
          <span className='text-muted-foreground' title='累计费用'>
            Σ
          </span>
          <b className='font-mono font-medium text-muted-foreground tabular-nums'>
            {fmtUsd(r.total, 2)}
          </b>
        </div>
      </div>
    ),
  },
]

function ProdCell({ vm }: { vm: Vm }) {
  return (
    <VmAccountIdentity
      vm={vm}
      showQuotaSample={false}
      compactLabels={false}
      showRegistration={false}
    />
  )
}

type Agg = {
  n: number
  ok: number
  req: number
  today: number
  spend: number
  used: number
  cap: number
  queue: number
  queued: number
  by: Record<VmZone, number>
  top: RowData | null
}

function aggregate(rows: RowData[]): Agg {
  const a: Agg = {
    n: rows.length,
    ok: 0,
    req: 0,
    today: 0,
    spend: 0,
    used: 0,
    cap: 0,
    queue: 0,
    queued: 0,
    by: { pool: 0, restricted: 0, off: 0, none: 0, dead: 0 },
    top: null,
  }
  for (const r of rows) {
    a.ok += r.hOk
    a.req += r.hReq
    a.today += r.today
    a.spend += r.spend
    a.used += r.seatsUsed
    a.cap += r.seatsMax ?? 0
    a.queue += r.queue
    if (r.queue) a.queued++
    a.by[zoneOf(r.vm)]++
    if (r.spend && (!a.top || r.spend > a.top.spend)) a.top = r
  }
  return a
}

const aggPct = (a: Agg) => (a.req ? (a.ok / a.req) * 100 : null)

/** 本机记住的列表开关。 */
function useFlag(key: string, initial: boolean) {
  const [on, setOn] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? initial : raw === '1'
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, on ? '1' : '0')
    } catch {
      /* 隐私模式下写不进去，只影响下次默认值 */
    }
  }, [key, on])
  return [on, setOn] as const
}

function Kpi({
  k,
  v,
  x,
  tone,
}: {
  k: string
  v: ReactNode
  x: ReactNode
  tone?: string
}) {
  return (
    <div className='min-w-0 flex-1 border-l px-3 first:border-l-0'>
      <div className='text-[11px] text-muted-foreground'>{k}</div>
      <div className='flex items-baseline gap-2 whitespace-nowrap'>
        <b className={cn('font-mono text-[15px] tabular-nums', tone)}>{v}</b>
        <span className='truncate text-[11px] text-muted-foreground'>{x}</span>
      </div>
    </div>
  )
}

function SummaryBar({ a }: { a: Agg }) {
  const pct = aggPct(a)
  return (
    <section
      aria-label='全局汇总'
      className='flex flex-wrap gap-y-2 rounded-lg border border-border/60 bg-card py-2'
    >
      <Kpi
        k='在池'
        v={
          <>
            {a.by.pool}
            <span className='text-muted-foreground'>/{a.n}</span>
          </>
        }
        x={`受限 ${a.by.restricted} · 关闭 ${a.by.off} · 未使用 ${a.by.none} · 不可调度 ${a.by.dead}`}
      />
      <Kpi
        k='24h 成功率'
        v={fmtHealthPct(pct)}
        x={`失败 ${fmtNum(a.req - a.ok)}`}
        tone={HEALTH_FG[healthTone(pct)]}
      />
      <Kpi k='24h 请求' v={fmtNum(a.req)} x={`今日 ${fmtNum(a.today)}`} />
      <Kpi
        k='7D 花费'
        v={a.spend ? fmtUsd(a.spend, 2) : '—'}
        x={a.top ? `最高 ${a.top.vm.id} ${fmtUsd(a.top.spend, 0)}` : ''}
      />
      <Kpi
        k='席位占用'
        v={
          <>
            {a.used}
            <span className='text-muted-foreground'>/{a.cap}</span>
          </>
        }
        x={a.cap ? `${Math.round((a.used / a.cap) * 100)}%` : ''}
      />
      <Kpi
        k='排队'
        v={a.queue}
        x={a.queued ? `${a.queued} 台有排队` : '无排队'}
        tone={a.queue ? 'text-[color:var(--status-warn)]' : undefined}
      />
    </section>
  )
}

function ToggleBtn({
  on,
  onClick,
  icon: Icon,
  children,
}: {
  on: boolean
  onClick: () => void
  icon: typeof Eye
  children: ReactNode
}) {
  return (
    <Button
      type='button'
      size='sm'
      variant={on ? 'default' : 'outline'}
      aria-pressed={on}
      className='h-7 gap-1 px-2 text-xs'
      onClick={onClick}
    >
      <Icon className='size-3.5' />
      {children}
    </Button>
  )
}

export function VmTable({
  vms,
  accounts,
  zoom = 100,
  onZoomChange,
}: {
  vms: Vm[]
  accounts?: UsageAccountRow[]
  /** 列表放大，100–200。100 为原尺寸。 */
  zoom?: number
  onZoomChange?: (zoom: number) => void
}) {
  const actions = useVmActions()
  const now = useNow()
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [grouped, setGrouped] = useFlag('kin.vm.list-group', false)
  const [pinSec, setPinSec] = useFlag('kin.vm.list-pin-sec', false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<VmZone>>(
    () => new Set<VmZone>(['off', 'none', 'dead'])
  )
  const toggleGroup = (k: VmZone) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const rows = useMemo(() => {
    const list = vms.map((vm) => rowData(vm, accounts))
    if (!sort) return list
    const f = SORT_VALUE[sort.key]
    // 无数据永远排在最后，不随方向翻转。
    return list
      .map((r, i) => ({ r, i, v: f(r) }))
      .sort((a, b) => {
        if (a.v == null || b.v == null)
          return a.v == null && b.v == null ? a.i - b.i : a.v == null ? 1 : -1
        return sort.dir * (a.v - b.v) || a.i - b.i
      })
      .map((x) => x.r)
  }, [vms, accounts, sort])

  const total = useMemo(() => aggregate(rows), [rows])
  const sections = grouped
    ? ZONES.map(({ key: k }) => {
        const list = rows.filter((r) => zoneOf(r.vm) === k)
        return { key: k, rows: list, agg: aggregate(list), head: true }
      }).filter((g) => g.rows.length)
    : [{ key: 'all' as const, rows, agg: total, head: false }]

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev?.key === key
        ? prev.dir === (ASC_FIRST.has(key) ? 1 : -1)
          ? { key, dir: ASC_FIRST.has(key) ? -1 : 1 }
          : null
        : { key, dir: ASC_FIRST.has(key) ? 1 : -1 }
    )

  const setOpen = (id: string, open: boolean) =>
    setExpanded((prev) => {
      if (prev.has(id) === open) return prev
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  const toggle = (id: string) => setOpen(id, !expanded.has(id))
  const onRowClick = (e: MouseEvent<HTMLDivElement>, vm: Vm) => {
    if ((e.target as HTMLElement).closest(ROW_INTERACTIVE)) return
    if (String(window.getSelection?.() ?? '')) return
    toggle(vm.id)
  }
  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, vm: Vm) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      actions.openDetail(vm)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle(vm.id)
    } else if (e.key === 'Escape') {
      setOpen(vm.id, false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = [
        ...(e.currentTarget
          .closest('[data-vm-table]')
          ?.querySelectorAll<HTMLElement>('[data-vm-row]') ?? []),
      ]
      const next =
        list[list.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]
      if (next) {
        e.preventDefault()
        next.focus()
      }
    }
  }

  const stickyLeft = 'sticky z-[2] bg-[var(--row-bg)]'
  return (
    <div className='space-y-2'>
      <SummaryBar a={total} />
      <div className='flex justify-end'>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='h-8 gap-1.5'
            >
              <Eye className='size-3.5' />
              显示
            </Button>
          </PopoverTrigger>
          <PopoverContent align='end' className='w-72 space-y-3'>
            <p className='text-sm font-semibold'>列表显示</p>
            <div className='flex flex-wrap gap-2'>
              <ToggleBtn
                on={grouped}
                icon={Layers}
                onClick={() => setGrouped(!grouped)}
              >
                按状态分组
              </ToggleBtn>
              <ToggleBtn
                on={pinSec}
                icon={Eye}
                onClick={() => setPinSec(!pinSec)}
              >
                次要信息常显
              </ToggleBtn>
            </div>
            <div className='grid gap-2 border-t pt-3'>
              <label className='text-xs' htmlFor='vm-list-metric-sort'>
                排序指标
              </label>
              <div className='flex gap-2'>
                <Select
                  value={sort?.key ?? 'default'}
                  onValueChange={(key) =>
                    setSort(
                      key === 'default'
                        ? null
                        : {
                            key: key as SortKey,
                            dir: ASC_FIRST.has(key as SortKey) ? 1 : -1,
                          }
                    )
                  }
                >
                  <SelectTrigger
                    id='vm-list-metric-sort'
                    className='h-8 flex-1'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='default'>跟随上方排序</SelectItem>
                    {Object.entries(SORT_LABEL).map(([key, label]) => (
                      <SelectItem key={key} value={key}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type='button'
                  variant='outline'
                  size='icon'
                  className='size-8'
                  disabled={!sort}
                  aria-label={sort?.dir === 1 ? '改为降序' : '改为升序'}
                  onClick={() =>
                    setSort(
                      sort ? { ...sort, dir: sort.dir === 1 ? -1 : 1 } : null
                    )
                  }
                >
                  {sort?.dir === 1 ? (
                    <ArrowUp className='size-3.5' />
                  ) : (
                    <ArrowDown className='size-3.5' />
                  )}
                </Button>
              </div>
            </div>
            {onZoomChange ? (
              <div className='grid gap-2 border-t pt-3'>
                <div className='flex items-center justify-between text-xs'>
                  <span>列表放大</span>
                  <span className='font-mono tabular-nums'>{zoom}%</span>
                </div>
                <Slider
                  min={100}
                  max={200}
                  step={10}
                  value={[zoom]}
                  aria-label='列表放大'
                  onValueChange={(value) => onZoomChange(value[0] ?? 100)}
                />
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>
      <span className='sr-only' role='status'>
        {sort
          ? `按${SORT_LABEL[sort.key]}${sort.dir === 1 ? '升序' : '降序'}排列`
          : '跟随上方排序'}
      </span>
      <div
        data-vm-table
        data-pin={pinSec}
        role='region'
        aria-label='槽位列表横向滚动区域'
        tabIndex={0}
        className='group/tbl overflow-x-auto rounded-lg border border-border/60 bg-card text-[13px]'
      >
        <div
          className='min-w-[1180px]'
          role='table'
          aria-label='槽位列表'
          style={zoom === 100 ? undefined : { zoom: zoom / 100 }}
        >
          <div
            role='row'
            className='sticky top-0 z-[6] grid h-8 border-b bg-muted/40 text-[11.5px] text-muted-foreground [--row-bg:var(--card)]'
            style={GRID}
          >
            <div role='columnheader' className={cn(stickyLeft, 'left-0')}>
              <span className='sr-only'>详情页</span>
            </div>
            <div
              role='columnheader'
              className={cn(stickyLeft, 'left-[34px] flex items-center px-2')}
            >
              账号
            </div>
            {COLS.map((c) => {
              const active =
                sort &&
                (c.sortKeys ?? (c.sort ? [c.sort] : [])).includes(sort.key)
              return (
                <div
                  key={c.label}
                  role='columnheader'
                  aria-sort={
                    active
                      ? sort.dir > 0
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className={cn(
                    'flex min-w-0 items-center px-2 whitespace-nowrap',
                    c.num && 'justify-end',
                    active && 'font-semibold text-foreground'
                  )}
                >
                  {c.sort ? (
                    <button
                      type='button'
                      className='inline-flex min-h-6 items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                      title='点击排序'
                      onClick={() => onSort(c.sort!)}
                    >
                      {c.label}
                      {active ? (
                        sort.dir > 0 ? (
                          <ArrowUp className='size-2.5' />
                        ) : (
                          <ArrowDown className='size-2.5' />
                        )
                      ) : null}
                    </button>
                  ) : (
                    c.label
                  )}
                </div>
              )
            })}
            <div role='columnheader'>
              <span className='sr-only'>操作</span>
            </div>
          </div>
          {sections.map((sec) => {
            const isCol = sec.head && collapsed.has(sec.key as VmZone)
            const pct = aggPct(sec.agg)
            return (
              <Fragment key={sec.key}>
                {sec.head ? (
                  <div className='border-b bg-muted/50'>
                    <div className='sticky left-0 flex h-8 w-max items-center gap-4 px-2.5 text-[11.5px] whitespace-nowrap text-muted-foreground'>
                      <button
                        type='button'
                        aria-expanded={!isCol}
                        className='inline-flex items-center gap-1.5 rounded-sm font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                        onClick={() => toggleGroup(sec.key as VmZone)}
                      >
                        <ChevronRight
                          className={cn(
                            'size-3 transition-transform motion-reduce:transition-none',
                            !isCol && 'rotate-90'
                          )}
                        />
                        {ZONES.find((z) => z.key === sec.key)?.label}
                        <span className='font-mono font-normal text-muted-foreground'>
                          {sec.rows.length} 台
                        </span>
                      </button>
                      <span>
                        成功率{' '}
                        <b className='font-mono text-foreground'>
                          {fmtHealthPct(pct)}
                        </b>
                      </span>
                      <span>
                        24h 请求{' '}
                        <b className='font-mono text-foreground'>
                          {fmtNum(sec.agg.req)}
                        </b>
                      </span>
                      <span>
                        7D 花费{' '}
                        <b className='font-mono text-foreground'>
                          {sec.agg.spend ? fmtUsd(sec.agg.spend, 2) : '—'}
                        </b>
                      </span>
                      <span>
                        席位{' '}
                        <b className='font-mono text-foreground'>
                          {sec.agg.used}/{sec.agg.cap}
                        </b>
                      </span>
                      {isCol ? (
                        <span className='text-[color:var(--text-tertiary)]'>
                          已折叠
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {isCol
                  ? null
                  : sec.rows.map((r) => {
                      const vm = r.vm
                      const open = expanded.has(vm.id)
                      const label = scheduleStateLabel(vm)
                      const dim = label === '关'
                      const detailId = `vm-row-detail-${vm.id}`
                      const max = claudeTier(vm).key === 'max'
                      return (
                        <div key={vm.id} role='rowgroup'>
                          <div
                            data-vm-row
                            role='row'
                            tabIndex={0}
                            aria-expanded={open}
                            aria-label={`${vm.id}，${label}。Enter 展开明细，Shift+Enter 打开详情`}
                            className={cn(
                              'group relative grid cursor-pointer items-start border-b border-[color:var(--hairline)] bg-[var(--row-bg)] py-3.5 outline-none [--row-bg:var(--card)] hover:[--row-bg:color-mix(in_oklab,var(--muted)_55%,var(--card))] focus-visible:after:pointer-events-none focus-visible:after:absolute focus-visible:after:inset-0 focus-visible:after:z-[4] focus-visible:after:border-2 focus-visible:after:border-ring',
                              open &&
                                '[--row-bg:color-mix(in_oklab,var(--muted)_75%,var(--card))]'
                            )}
                            style={GRID}
                            onClick={(e) => onRowClick(e, vm)}
                            onKeyDown={(e) => onRowKey(e, vm)}
                          >
                            <div
                              role='cell'
                              className={cn(
                                stickyLeft,
                                'left-0 flex h-full items-start justify-center pt-0.5',
                                max &&
                                  'shadow-[inset_2px_0_0_var(--tier-max-border)]'
                              )}
                            >
                              <Button
                                type='button'
                                size='icon'
                                variant='ghost'
                                className='size-6 text-muted-foreground hover:text-foreground'
                                title='打开详情页（Shift+Enter）'
                                aria-label={`打开 ${vm.id} 详情页`}
                                onClick={() => actions.openDetail(vm)}
                              >
                                <ExternalLink className='size-3.5' />
                              </Button>
                            </div>
                            <div
                              role='cell'
                              className={cn(
                                stickyLeft,
                                'left-[34px] flex h-full min-w-0 items-start overflow-hidden px-2',
                                dim && 'opacity-50'
                              )}
                            >
                              <ProdCell vm={vm} />
                            </div>
                            {COLS.map((c, i) => (
                              <div
                                key={c.label}
                                role='cell'
                                className={cn(
                                  'min-w-0 px-2',
                                  c.dim && 'text-muted-foreground',
                                  // 调度列（第一列）保持可读，其余在关闭时淡出。
                                  dim &&
                                    i > 0 &&
                                    c.label !== '状态' &&
                                    'opacity-50'
                                )}
                              >
                                {vm.gemini && c.label !== '状态' ? (
                                  <span className={TERT}>—</span>
                                ) : (
                                  c.cell(r, now)
                                )}
                              </div>
                            ))}
                            <div
                              role='cell'
                              className='flex items-center justify-end gap-px pr-1'
                            >
                              <Button
                                type='button'
                                size='icon'
                                variant='ghost'
                                className='size-6 text-muted-foreground'
                                aria-expanded={open}
                                aria-controls={detailId}
                                aria-label={`${open ? '收起' : '展开'} ${vm.id} 明细`}
                                title='展开明细（Enter）'
                                onClick={() => toggle(vm.id)}
                              >
                                <ChevronDown
                                  className={cn(
                                    'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
                                    open && 'rotate-180'
                                  )}
                                />
                              </Button>
                              <span className={SEC}>
                                <VmActionMenu vm={vm} />
                              </span>
                            </div>
                          </div>
                          {open && vm.gemini ? (
                            <div
                              id={detailId}
                              className='flex items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground'
                            >
                              <span>{vm.email || '未提供邮箱'}</span>
                              <span>
                                {vm.gemini.account?.plan || '未提供订阅'}
                              </span>
                              <ProxyChip vm={vm} compact />
                              <Button
                                type='button'
                                size='sm'
                                variant='ghost'
                                onClick={() => actions.openDetail(vm)}
                              >
                                管理 Gemini 凭证
                              </Button>
                            </div>
                          ) : open ? (
                            <VmRowDetail
                              id={detailId}
                              vm={vm}
                              accounts={accounts}
                              now={now}
                              onOpenDetail={() => actions.openDetail(vm)}
                            />
                          ) : null}
                        </div>
                      )
                    })}
              </Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}
