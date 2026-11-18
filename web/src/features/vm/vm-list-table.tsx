import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import {
  ArrowDown,
  ArrowUp,
  Ban,
  ChevronDown,
  ChevronRight,
  Eye,
  Layers,
  CircleCheck,
  CircleOff,
  ExternalLink,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import { credentialRegistrationOf } from '@/lib/cred-type'
import { fmtResetClock, resetCountdown } from '@/lib/fable-status'
import { fmtNum, fmtUsd } from '@/lib/format'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import {
  fmtHealthPct,
  HEALTH_FG,
  healthSummary,
  healthTone,
  SLOT_BG,
  type SlotState,
} from '@/lib/vm-health'
import { platformLabel } from '@/lib/vm-kind'
import {
  claudeTier,
  poolStatus,
  scheduleStateLabel,
  seatTitle,
  type ScheduleStateLabel,
  vmRequestingCount,
} from '@/lib/vm-status'
import { vmCostLedger, vmTodayStats, vmWeekOutcome } from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import { riskFg, RISK_SOLID, riskLevel } from '@/features/vm/usage-meter'
import { PlatformMark } from '@/features/vm/vm-account-identity'
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
import { windowTiming } from '@/features/vm/window-timing'

/** 行内点到这些元素时不切换展开。 */
const ROW_INTERACTIVE =
  'button, a, input, select, textarea, label, [role="switch"], [role="menuitem"], [data-row-stop]'

const COLUMN_GRID =
  '@min-[64rem]/vm-list:grid-cols-[minmax(10rem,1.7fr)_minmax(3.5rem,0.5fr)_minmax(5.75rem,0.9fr)_minmax(8rem,1.15fr)_minmax(6rem,0.85fr)_minmax(10rem,1.45fr)_minmax(6.5rem,0.9fr)]'

const TERT = 'text-[color:var(--text-tertiary)]'

const STATE_STYLE: Record<
  ScheduleStateLabel,
  { cls: string; icon: typeof CircleCheck }
> = {
  开: { cls: 'text-muted-foreground font-medium', icon: CircleCheck },
  受限: { cls: 'text-[color:var(--status-warn)]', icon: TriangleAlert },
  关: { cls: TERT, icon: CircleOff },
  不可调度: { cls: 'text-[color:var(--status-bad)]', icon: Ban },
}

const STATE_ICON_FG: Partial<Record<ScheduleStateLabel, string>> = {
  开: 'text-[color:var(--status-ok)]',
}

function SchedCell({ vm }: { vm: Vm }) {
  return vm.gemini ? (
    <span className={TERT}>—</span>
  ) : (
    <SchedulableSwitch {...vmSchedulableProps(vm)} />
  )
}

function TypeCell({ vm }: { vm: Vm }) {
  const tier = claudeTier(vm)
  const platform = vm.gemini ? 'Gemini' : platformLabel(vm)
  const plan = vm.gemini ? vm.gemini.account?.plan : tier.label
  const crag = (vm.resolved_dataplane ?? vm.dataplane) === 'crag'
  const level = Number(vm.schedule_level)
  const valid = Number.isInteger(level) && level >= 1 && level <= 10
  const manual = vm.schedule_level_mode === 'manual'

  return (
    <div className='grid min-w-0 justify-items-start gap-1.5'>
      <div className='flex flex-wrap items-center gap-x-1.5 gap-y-1'>
        <span className='font-medium'>{platform}</span>
        {plan && plan !== '—' && plan !== platform ? (
          <span
            className={cn(
              'rounded px-1.5 text-xs leading-5 font-semibold',
              tierVisual(vm).badge
            )}
          >
            {plan}
          </span>
        ) : null}
      </div>
      <div className='flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs'>
        <span
          className={cn(
            'rounded px-1.5 leading-5',
            crag
              ? 'bg-orange-200 text-orange-900 dark:bg-orange-400/20 dark:text-orange-300'
              : 'bg-muted text-muted-foreground'
          )}
          title='当前内核'
        >
          {vm.gemini ? 'CRAGAnti' : crag ? 'crag' : '默认'}
        </span>
        {!vm.gemini ? (
          <span
            className={cn(
              'rounded px-1.5 leading-5 font-semibold tabular-nums',
              valid ? schedulingPriorityTextClass(level) : TERT,
              valid && manual ? 'ring-1 ring-current ring-inset' : 'bg-muted'
            )}
            title={
              valid
                ? `${manual ? '手动指定' : '自动分配'}的优先级`
                : '没有调度优先级'
            }
          >
            P{valid ? level : '—'}
            {valid && manual ? <small className='ml-0.5'>手</small> : null}
          </span>
        ) : null}
      </div>
      {vm.gemini ? (
        <span className='text-xs text-muted-foreground'>宿主机</span>
      ) : null}
    </div>
  )
}

function StatusCell({ vm }: { vm: Vm }) {
  const label = scheduleStateLabel(vm)
  const tone = poolStatus(vm)
  const breaker = label === '受限' && tone.key === 'circuit'
  const style = STATE_STYLE[label]
  const Icon = breaker ? Zap : style.icon
  const reason =
    label === '受限' || label === '不可调度'
      ? vm.restriction_text || vm.unschedulable_text || tone.text
      : null
  return (
    <div className='grid min-w-0 justify-items-start gap-1.5'>
      {vm.gemini ? (
        <GeminiSlotStatus vm={vm} />
      ) : (
        <>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 font-semibold',
              breaker ? 'text-[color:var(--status-caution)]' : style.cls
            )}
          >
            <Icon
              className={cn('size-3.5 shrink-0', STATE_ICON_FG[label])}
              aria-hidden
            />
            {label === '开' ? '可调度' : label === '关' ? '调度关闭' : label}
          </span>
          {reason ? (
            <span className='max-w-full text-xs [overflow-wrap:anywhere] text-muted-foreground'>
              {reason}
            </span>
          ) : null}
          <HealthCell vm={vm} />
        </>
      )}
      <ProxyChip vm={vm} className='max-w-full' />
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
  if (vm.health_24h === undefined) return <span className={TERT}>24h 未知</span>
  const h = healthSummary(vm.health_24h)
  if (!h.req) return <span className={TERT}>24h 无请求</span>
  return (
    <div className='w-full min-w-0 space-y-1'>
      <div className='flex items-baseline gap-1.5 text-xs'>
        <span className='text-muted-foreground'>24h</span>
        <b
          className={cn('font-semibold tabular-nums', HEALTH_FG[h.tone])}
          title={`成功 ${fmtNum(h.ok)} / 总数 ${fmtNum(h.req)}`}
        >
          {fmtHealthPct(h.pct)}
        </b>
      </div>
      <span
        role='img'
        aria-label='近 24 小时 48 格请求健康时间线'
        className='grid h-2.5 w-full auto-cols-fr grid-flow-col items-end gap-px'
      >
        {h.slots.map((state, i) => (
          <i
            key={i}
            className='block'
            style={{
              height: SLOT_HEIGHT[state],
              backgroundColor: SLOT_BG[state],
            }}
          />
        ))}
      </span>
    </div>
  )
}

function QuotaWindow({
  vm,
  w,
  now,
}: {
  vm: Vm
  w: WindowReadout
  now: number
}) {
  const t = windowTiming(w, now)
  const pct = w.pct
  const full = pct != null && pct >= 100
  const left = vm.has_token ? resetCountdown(w.reset, now) : null
  const eta =
    full && left && t.resetMs != null && t.resetMs > now
      ? `${left}恢复`
      : left || (full ? '已满' : '重置未知')

  return (
    <div
      data-window-readout={w.key}
      className='grid min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] items-baseline gap-x-1.5 gap-y-1 text-xs'
    >
      <span className='font-medium text-muted-foreground'>{w.label}</span>
      {w.note ? (
        <span className='[overflow-wrap:anywhere] text-[color:var(--status-warn)]'>
          {w.note}
        </span>
      ) : pct == null ? (
        <span className='text-muted-foreground'>未探测</span>
      ) : (
        <>
          <div className='flex min-w-0 flex-wrap items-baseline justify-between gap-x-1.5 tabular-nums'>
            <b className={cn('font-semibold', pct >= 70 && riskFg(pct))}>
              {pct.toFixed(0)}%
            </b>
            <span
              className={cn(
                'text-muted-foreground',
                full && 'font-medium text-[color:var(--status-bad)]'
              )}
            >
              {eta}
            </span>
          </div>
          <span
            aria-hidden
            className='relative col-start-2 h-1.5 rounded-full bg-muted'
            title={
              t.resetMs != null ? `重置于 ${fmtResetClock(w.reset)}` : undefined
            }
          >
            <i
              className='absolute inset-y-0 left-0 rounded-full'
              style={{
                width: `${Math.max(0, Math.min(100, pct))}%`,
                backgroundColor: RISK_SOLID[riskLevel(pct)],
              }}
            />
            {t.elapsedPct != null ? (
              <b
                className='absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full bg-foreground'
                style={{
                  left: `clamp(0px, calc(${t.elapsedPct}% - 1px), calc(100% - 2px))`,
                }}
              />
            ) : null}
          </span>
        </>
      )}
    </div>
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
  week: number
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
  const today = vmTodayStats(vm, accounts)
  const win: RowData['win'] = {}
  for (const w of vmWindows(vm)) win[w.key] = w
  const h = healthSummary(vm.health_24h)
  return {
    vm,
    health: h.pct,
    hOk: h.ok,
    hReq: h.req,
    win,
    today: today.req,
    todayCost: today.today,
    week: week.req,
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
  tokens: '7D Token',
  perReq: '每请求费用',
  total: '累计费用',
}

function Metric({
  label,
  children,
  strong = false,
}: {
  label: string
  children: ReactNode
  strong?: boolean
}) {
  return (
    <div className='flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 text-xs'>
      <span className='text-muted-foreground'>{label}</span>
      <span
        className={cn(
          'tabular-nums',
          strong ? 'font-semibold' : 'font-medium text-muted-foreground'
        )}
      >
        {children}
      </span>
    </div>
  )
}

function RequestCell({ r }: { r: RowData }) {
  return (
    <div className='grid gap-1'>
      <Metric label='今日' strong>
        {fmtNum(r.today)}
      </Metric>
      <Metric label='7 日'>{fmtNum(r.week)}</Metric>
      {r.seatsMax != null ? (
        <div title={seatTitle(r.vm)}>
          <Metric label='席位'>
            {r.seatsUsed}/{r.seatsMax}
          </Metric>
        </div>
      ) : null}
      {r.queue > 0 ? (
        <Metric label='排队'>
          <b className='text-[color:var(--status-warn)]'>{fmtNum(r.queue)}</b>
        </Metric>
      ) : null}
    </div>
  )
}

function CostCell({ r }: { r: RowData }) {
  return (
    <div className='grid gap-1'>
      <Metric label='今日'>{fmtUsd(r.todayCost, 2)}</Metric>
      <Metric label='7 日' strong>
        {fmtUsd(r.spend, 2)}
      </Metric>
      <Metric label='累计'>{fmtUsd(r.total, 2)}</Metric>
    </div>
  )
}

type Col = {
  id: 'schedule' | 'type' | 'status' | 'requests' | 'quota' | 'cost'
  label: string
  sorts?: [SortKey, ...SortKey[]]
  cell: (r: RowData, now: number) => ReactNode
}

const COLS: Col[] = [
  { id: 'schedule', label: '调度', cell: (r) => <SchedCell vm={r.vm} /> },
  { id: 'type', label: '类型', cell: (r) => <TypeCell vm={r.vm} /> },
  {
    id: 'status',
    label: '状态',
    sorts: ['health'],
    cell: (r) => <StatusCell vm={r.vm} />,
  },
  {
    id: 'requests',
    label: '请求量',
    sorts: ['today', 'seats', 'queue', 'inflight'],
    cell: (r) => <RequestCell r={r} />,
  },
  {
    id: 'quota',
    label: '用量窗口',
    sorts: ['5h', '7d', 'fable'],
    cell: (r, now) => (
      <div className='grid min-w-0 gap-2'>
        {Object.values(r.win).map((window) => (
          <QuotaWindow key={window.key} vm={r.vm} w={window} now={now} />
        ))}
      </div>
    ),
  },
  {
    id: 'cost',
    label: '费用',
    sorts: ['spend', 'tokens', 'perReq', 'total'],
    cell: (r) => <CostCell r={r} />,
  },
]

function AccountCell({
  vm,
  inflight,
  showMeta,
}: {
  vm: Vm
  inflight: number
  showMeta: boolean
}) {
  const name = vm.name?.trim()
  const displayName =
    (name && name !== vm.id ? name : vm.email?.trim()) || vm.id
  const registration = credentialRegistrationOf(vm)
  const node = vm.node_name || vm.node_id || (vm.node_id === null ? '本机' : '')
  return (
    <div className='min-w-0'>
      <div className='flex min-w-0 items-start gap-1.5'>
        <span className='mt-0.5 shrink-0'>
          <PlatformMark vm={vm} />
        </span>
        <span
          className='line-clamp-2 min-w-0 text-sm leading-5 font-semibold [overflow-wrap:anywhere]'
          title={displayName}
        >
          {displayName}
        </span>
        {!vm.gemini && inflight > 0 ? (
          <span
            data-vm-requesting={inflight}
            title={`请求中 ${inflight}`}
            className='shrink-0 rounded-full bg-blue-100 px-1.5 py-0.5 text-[11px] leading-4 font-semibold text-blue-800 tabular-nums dark:bg-blue-950 dark:text-blue-200'
          >
            请求中 {inflight}
          </span>
        ) : null}
      </div>
      {showMeta ? (
        <div className='mt-1 space-y-0.5 text-xs [overflow-wrap:anywhere] text-muted-foreground'>
          {vm.email && vm.email !== displayName ? <p>{vm.email}</p> : null}
          <p>
            {[
              vm.gemini ? '宿主机' : vm.runtime_type === 'kvm' ? 'KVM' : 'VM',
              registration === 'none' ? '无凭证' : registration,
              node,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      ) : null}
    </div>
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
    <div className='min-w-0 space-y-1 px-3 py-2'>
      <div className='text-[11px] text-muted-foreground'>{k}</div>
      <div className='min-w-0 space-y-0.5'>
        <b className={cn('font-mono text-[15px] tabular-nums', tone)}>{v}</b>
        <p className='text-xs [overflow-wrap:anywhere] text-muted-foreground'>
          {x}
        </p>
      </div>
    </div>
  )
}

function SummaryBar({ a }: { a: Agg }) {
  const pct = aggPct(a)
  return (
    <section
      aria-label='全局汇总'
      className='grid grid-cols-2 gap-px rounded-lg border border-border/60 bg-card text-sm @min-[36rem]/vm-summary:grid-cols-3 @min-[64rem]/vm-summary:grid-cols-6'
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
}: {
  vms: Vm[]
  accounts?: UsageAccountRow[]
  /** 列表放大，100–200。100 为原尺寸。 */
  zoom?: number
}) {
  const actions = useVmActions()
  const sortId = useId()
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

  return (
    <div className='@container/vm-summary min-w-0 space-y-3'>
      <SummaryBar a={total} />
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <label className='text-xs text-muted-foreground' htmlFor={sortId}>
            排序指标
          </label>
          <select
            id={sortId}
            className='min-h-8 max-w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring'
            value={sort?.key ?? ''}
            onChange={({ target }) => {
              const key = target.value as SortKey | ''
              setSort(key ? { key, dir: ASC_FIRST.has(key) ? 1 : -1 } : null)
            }}
          >
            <option value=''>跟随上方排序</option>
            {Object.entries(SORT_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <Button
            type='button'
            size='icon'
            variant='outline'
            className='size-8'
            disabled={!sort}
            aria-label={sort?.dir === 1 ? '改为降序' : '改为升序'}
            onClick={() =>
              setSort(
                (current) =>
                  current && { ...current, dir: current.dir === 1 ? -1 : 1 }
              )
            }
          >
            {sort?.dir === 1 ? (
              <ArrowUp aria-hidden />
            ) : (
              <ArrowDown aria-hidden />
            )}
          </Button>
        </div>
        <div className='flex flex-wrap items-center gap-1.5'>
          <ToggleBtn
            on={grouped}
            icon={Layers}
            onClick={() => setGrouped(!grouped)}
          >
            按状态分组
          </ToggleBtn>
          <ToggleBtn on={pinSec} icon={Eye} onClick={() => setPinSec(!pinSec)}>
            次要信息常显
          </ToggleBtn>
        </div>
      </div>
      <span role='status' className='sr-only'>
        {sort
          ? `按${SORT_LABEL[sort.key]}${sort.dir === 1 ? '升序' : '降序'}排列`
          : '跟随上方排序'}
      </span>
      <div
        data-vm-table
        data-pin={pinSec}
        className='min-w-0 rounded-lg border border-border/60 bg-card text-[13px]'
      >
        <div
          className='@container/vm-list min-w-0'
          role='table'
          aria-label='槽位列表'
          style={zoom === 100 ? undefined : { zoom: zoom / 100 }}
        >
          <div
            role='row'
            className={cn(
              'sr-only rounded-t-lg border-b bg-muted/55 text-xs font-medium text-muted-foreground @min-[64rem]/vm-list:not-sr-only @min-[64rem]/vm-list:grid',
              COLUMN_GRID
            )}
          >
            <div role='columnheader' className='px-3 py-2'>
              账号
            </div>
            {COLS.map((c) => {
              const active = sort && c.sorts?.includes(sort.key)
              const key = c.sorts?.[0]
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
                    'flex min-w-0 items-center px-3 py-2',
                    active && 'font-semibold text-foreground'
                  )}
                >
                  {key ? (
                    <>
                      <span className='@min-[64rem]/vm-list:hidden'>
                        {c.label}
                      </span>
                      <button
                        type='button'
                        className='hidden min-h-6 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring @min-[64rem]/vm-list:inline-flex'
                        title='点击排序'
                        onClick={() => onSort(key)}
                      >
                        {c.label}
                        {active ? (
                          sort.dir > 0 ? (
                            <ArrowUp aria-hidden className='size-3' />
                          ) : (
                            <ArrowDown aria-hidden className='size-3' />
                          )
                        ) : null}
                      </button>
                    </>
                  ) : (
                    c.label
                  )}
                </div>
              )
            })}
          </div>
          {sections.map((sec) => {
            const isCol = sec.head && collapsed.has(sec.key as VmZone)
            const pct = aggPct(sec.agg)
            return (
              <Fragment key={sec.key}>
                {sec.head ? (
                  <div role='rowgroup'>
                    <div role='row' className='border-b bg-muted/50'>
                      <div
                        role='cell'
                        aria-colspan={7}
                        className='flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs text-muted-foreground'
                      >
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
                  </div>
                ) : null}
                {isCol
                  ? null
                  : sec.rows.map((r) => {
                      const vm = r.vm
                      const open = expanded.has(vm.id)
                      const label = scheduleStateLabel(vm)
                      const detailId = `vm-row-detail-${vm.id}`
                      return (
                        <div key={vm.id} role='rowgroup'>
                          <div
                            data-vm-row
                            role='row'
                            tabIndex={0}
                            aria-expanded={open}
                            aria-label={`${vm.id}，${label}。Enter 展开明细，Shift+Enter 打开详情`}
                            className={cn(
                              'relative grid min-w-0 cursor-pointer grid-cols-1 gap-y-3 border-b border-border/70 px-3 py-3 outline-none hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @min-[20rem]/vm-list:grid-cols-2 @min-[64rem]/vm-list:gap-y-0 @min-[64rem]/vm-list:px-0',
                              COLUMN_GRID,
                              open && 'bg-muted/35'
                            )}
                            onClick={(e) => onRowClick(e, vm)}
                            onKeyDown={(e) => onRowKey(e, vm)}
                          >
                            <div
                              role='cell'
                              data-vm-cell='account'
                              className='min-w-0 @min-[20rem]/vm-list:col-span-2 @min-[64rem]/vm-list:col-span-1 @min-[64rem]/vm-list:px-3'
                            >
                              <AccountCell
                                vm={vm}
                                inflight={r.inflight}
                                showMeta={pinSec}
                              />
                              <div className='mt-1 flex flex-wrap items-center gap-0.5'>
                                <Button
                                  type='button'
                                  size='icon'
                                  variant='ghost'
                                  className='size-7 text-muted-foreground'
                                  aria-expanded={open}
                                  aria-controls={detailId}
                                  aria-label={`${open ? '收起' : '展开'} ${vm.id} 明细`}
                                  title={
                                    open ? '收起明细' : '展开明细（Enter）'
                                  }
                                  onClick={() => toggle(vm.id)}
                                >
                                  <ChevronDown
                                    aria-hidden
                                    className={cn(
                                      'size-4 motion-safe:transition-transform',
                                      open && 'rotate-180'
                                    )}
                                  />
                                </Button>
                                <Button
                                  type='button'
                                  size='icon'
                                  variant='ghost'
                                  className='size-7 text-muted-foreground'
                                  title='打开详情页（Shift+Enter）'
                                  aria-label={`打开 ${vm.id} 详情页`}
                                  onClick={() => actions.openDetail(vm)}
                                >
                                  <ExternalLink
                                    aria-hidden
                                    className='size-3.5'
                                  />
                                </Button>
                                <VmActionMenu vm={vm} />
                              </div>
                            </div>
                            {COLS.map((c) => (
                              <div
                                key={c.id}
                                role='cell'
                                data-vm-cell={c.id}
                                className={cn(
                                  'min-w-0 @min-[20rem]/vm-list:px-2 @min-[64rem]/vm-list:px-3',
                                  (c.id === 'quota' || c.id === 'cost') &&
                                    '@min-[20rem]/vm-list:col-span-2 @min-[64rem]/vm-list:col-span-1'
                                )}
                              >
                                <div
                                  aria-hidden
                                  className='mb-1.5 text-xs font-medium text-muted-foreground @min-[64rem]/vm-list:hidden'
                                >
                                  {c.label}
                                </div>
                                {vm.gemini &&
                                (c.id === 'requests' ||
                                  c.id === 'quota' ||
                                  c.id === 'cost') ? (
                                  <span className={TERT}>—</span>
                                ) : (
                                  c.cell(r, now)
                                )}
                              </div>
                            ))}
                          </div>
                          {open && vm.gemini ? (
                            <div
                              id={detailId}
                              className='flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs [overflow-wrap:anywhere] text-muted-foreground'
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
