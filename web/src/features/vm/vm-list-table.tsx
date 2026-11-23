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
  ChartNoAxesColumnIncreasing,
  ChevronDown,
  ChevronRight,
  Settings2,
} from 'lucide-react'
import {
  expiresAtToMs,
  fmtResetClock,
  FABLE_MAX_ONLY_TEXT,
  fableState,
  resetCountdown,
} from '@/lib/fable-status'
import { fmtNum, fmtUsd } from '@/lib/format'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import {
  fmtHealthPct,
  HEALTH_FG,
  healthSummary,
  healthTone,
  SLOT_BG,
} from '@/lib/vm-health'
import { isCodexVm } from '@/lib/vm-kind'
import {
  credentialStatus,
  poolStatus,
  scheduleStateLabel,
  vmRequestingCount,
  seatTitle,
} from '@/lib/vm-status'
import { vmCostLedger, vmTodayStats, vmWeekOutcome } from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { CredLaneChip, PlatformChip } from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import { riskFg, RISK_SOLID, riskLevel } from '@/features/vm/usage-meter'
import { VmActionMenu } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { GeminiSlotStatus } from '@/features/vm/vm-rack-blade'
import {
  emptyZoneCounts,
  GEMINI_EVIDENCE_ZONES,
  vmWindows,
  type WindowKey,
  type WindowReadout,
  ZONES,
  zoneOf,
  type VmZone,
} from '@/features/vm/vm-rack-model'
import { VmRowDetail } from '@/features/vm/vm-row-detail'
import { sortVms, type VmSortKey } from '@/features/vm/vm-table'
import { schedulingPriorityTextClass } from '@/features/vm/vm-type-visual'
import { NodeChip } from './node-chip'
import { OpenaiPlanBadge } from './openai-plan-badge'
import { VmColumnPicker } from './vm-column-picker'
import {
  COLUMNS,
  METRIC_COLUMNS,
  useListColumns,
  type ColumnKey,
  type MetricKey,
} from './vm-list-columns'
import './vm-list-table.css'

/** 行内点到这些元素时不切换展开。 */
const ROW_INTERACTIVE =
  'button, a, input, select, textarea, label, [role="switch"], [role="menuitem"], [data-row-stop], [role="button"]'

function Quota({
  w,
  now,
  cost,
}: {
  w: WindowReadout
  now: number
  cost?: number
}) {
  const pct = w.pct
  const reset = expiresAtToMs(w.reset)
  const full = pct != null && pct >= 100
  const eta =
    reset > now ? resetCountdown(w.reset, now) : reset ? '已过重置' : '—'
  return (
    <div
      className='classic-window'
      data-window-readout={w.key}
      title={reset ? `重置于 ${fmtResetClock(w.reset)}` : undefined}
    >
      <span>{w.label}</span>
      {w.note || pct == null ? (
        <span className='classic-window-note'>{w.note || '未探测'}</span>
      ) : (
        <>
          <span className='classic-meter' aria-hidden>
            <i
              style={{
                width: `${Math.min(100, Math.max(0, pct))}%`,
                background: RISK_SOLID[riskLevel(pct)],
              }}
            />
          </span>
          <b className={cn('text-end', pct >= 70 && riskFg(pct))}>
            {Math.round(pct)}%
          </b>
        </>
      )}
      <span className='text-end text-muted-foreground'>
        {cost ? fmtUsd(cost, 2) : ''}
      </span>
      <span
        className={cn(
          'text-end',
          full ? 'text-[color:var(--status-bad)]' : 'text-muted-foreground'
        )}
      >
        {full ? `已满 · ${reset > now ? eta : '待更新'}` : eta}
      </span>
    </div>
  )
}

/** 一行需要的数字，排序与渲染共用。 */
type RowData = {
  vm: Vm
  health: number | null
  hOk: number
  hReq: number
  healthSlots: ReturnType<typeof healthSummary>['slots']
  todayStats: ReturnType<typeof vmTodayStats>
  week: ReturnType<typeof vmWeekOutcome>
  fiveCost: number
  win: Partial<Record<WindowKey, WindowReadout>>
  today: number
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
  const [five, d7, total] = vmCostLedger(vm, accounts)
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
    healthSlots: h.slots,
    todayStats: today,
    week,
    fiveCost: five.cost,
    win,
    today: today.req,
    seatsUsed: Number(vm.seats_used) || 0,
    seatsMax: vm.seats_max == null ? null : Number(vm.seats_max),
    queue: Number(vm.queue_depth) || 0,
    inflight: vmRequestingCount(vm),
    spend: d7.cost,
    tokens: d7.tokens,
    perReq: week.req > 0 ? d7.cost / week.req : null,
    total: total.cost,
  }
}

const SORT_VALUE: Record<MetricKey, (r: RowData) => number | null> = {
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

const PAGE_SORT = {
  name: 'name',
  status: 'status',
  todayCost: 'today',
  cache: 'cache',
} as const satisfies Record<string, VmSortKey>
type SortKey = MetricKey | keyof typeof PAGE_SORT | 'remain'
const ASC_FIRST: ReadonlySet<SortKey> = new Set(['health', 'status', 'name'])

const SORT_LABEL: Record<SortKey, string> = {
  status: '调度状态',
  name: '账号名称',
  remain: '5H 剩余',
  todayCost: '今日费用',
  cache: '缓存命中',
  health: '24h 成功率',
  '5h': '5H 用量',
  '7d': '7D 用量',
  fable: 'Fable 用量',
  today: '今日请求数',
  seats: '席位占用',
  queue: '排队',
  inflight: '请求中',
  spend: '7 天窗口花费',
  tokens: '7D Token',
  perReq: '每请求费用',
  total: '累计费用',
}

function TierBadge({ vm }: { vm: Vm }) {
  if (isCodexVm(vm)) return <OpenaiPlanBadge vm={vm} size='sm' />
  const skin = tierVisual(vm)
  if (skin.key === 'none') {
    return null
  }
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-none font-bold tracking-[0.03em] uppercase',
        skin.badge
      )}
    >
      {skin.label}
    </span>
  )
}

function AccountCell({
  r,
  showMeta,
  open,
  detailId,
  toggle,
  openDetail,
}: {
  r: RowData
  showMeta: boolean
  open: boolean
  detailId: string
  toggle: () => void
  openDetail: () => void
}) {
  const { vm, inflight } = r
  const name =
    (vm.name?.trim() && vm.name.trim() !== vm.id
      ? vm.name.trim()
      : vm.email?.trim()) || vm.id
  return (
    <div className='classic-account'>
      <div className='classic-name-line'>
        <PlatformChip
          vm={vm}
          kind={vm.gemini ? 'gemini' : undefined}
          className='text-[11px]'
        />
        <button
          type='button'
          className='classic-name'
          title={name}
          aria-label={`打开 ${name} 详情页`}
          onClick={openDetail}
        >
          {name}
        </button>
        {!vm.gemini && inflight > 0 ? (
          <span
            className='classic-live'
            data-vm-requesting={inflight}
            aria-label={`请求中 ${inflight}`}
            title={`请求中 ${inflight}`}
          >
            <span>请求中 </span>
            {inflight}
          </span>
        ) : null}
      </div>
      <div className='classic-account-meta'>
        {vm.gemini ? (
          <span>{vm.gemini.account?.plan || '宿主机'}</span>
        ) : (
          <TierBadge vm={vm} />
        )}
        <NodeChip nodeId={vm.node_id} className='max-w-24 text-[11px]' />
        <span className='truncate' title={vm.id}>
          {vm.id}
        </span>
        <button
          type='button'
          className='classic-disclosure'
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
          aria-label={`${open ? '收起' : '展开'} ${vm.id} 明细`}
          title={open ? '收起明细' : '展开明细'}
          onClick={toggle}
        >
          <ChevronDown
            aria-hidden
            className={cn('size-3.5', open && 'rotate-180')}
          />
        </button>
      </div>
      {showMeta && vm.email && vm.email !== name ? (
        <div className='text-xs wrap-anywhere text-muted-foreground'>
          {vm.email}
        </div>
      ) : null}
    </div>
  )
}

function TypeCell({ vm }: { vm: Vm }) {
  if (vm.gemini) return <span>宿主机 · CRAGAnti</span>
  const level = vm.schedule_level
  const valid =
    typeof level === 'number' &&
    Number.isInteger(level) &&
    level >= 1 &&
    level <= 10
  const manual = vm.schedule_level_mode === 'manual'
  return (
    <div className='classic-stack items-start'>
      {vm.has_token ? (
        <CredLaneChip vm={vm} className='text-[11px]' />
      ) : (
        <span className='text-muted-foreground'>无凭证</span>
      )}
      <span
        title={
          valid
            ? manual
              ? '手动指定优先级'
              : '自动分配优先级'
            : '没有调度优先级'
        }
        className={cn(
          'classic-priority',
          valid && schedulingPriorityTextClass(level)
        )}
      >
        P{valid ? level : '—'}
        {valid && manual ? ' 手' : ''}
      </span>
    </div>
  )
}

function StatusCell({ r }: { r: RowData }) {
  const { vm } = r
  if (vm.gemini)
    return (
      <div className='classic-stack items-start'>
        <GeminiSlotStatus vm={vm} />
        <ProxyChip vm={vm} compact />
      </div>
    )
  const tone = poolStatus(vm)
  const credential = credentialStatus(vm)
  const label = scheduleStateLabel(vm)
  const reason =
    label === '受限' || label === '不可调度'
      ? vm.restriction_text || vm.unschedulable_text
      : null
  return (
    <div className='classic-stack items-start'>
      <div className='classic-status-line'>
        <StatusMark tone={tone} variant='pill' className='text-xs' />
        <span
          className={cn(
            'classic-health-rate',
            r.health != null && HEALTH_FG[healthTone(r.health)]
          )}
          title={`24h 成功 ${fmtNum(r.hOk)} / 总数 ${fmtNum(r.hReq)}`}
        >
          {r.health == null
            ? vm.health_24h === undefined
              ? '24h 未知'
              : '24h 无请求'
            : `24h ${fmtHealthPct(r.health)}`}
        </span>
      </div>
      <div
        className='classic-availability'
        title={`凭证可用性：${credential.text}`}
      >
        <span aria-hidden data-tone={credential.cls} />
        <small>{credential.text}</small>
      </div>
      <div className='classic-status-line'>
        <ProxyChip vm={vm} compact />
        {r.queue > 0 ? (
          <span className='classic-alert'>排队 {fmtNum(r.queue)}</span>
        ) : null}
      </div>
      {reason && reason !== tone.text ? (
        <span className='classic-alert'>{reason}</span>
      ) : null}
    </div>
  )
}

function RequestCell({ r }: { r: RowData }) {
  const s = r.todayStats,
    w = r.week
  return (
    <div className='classic-stack'>
      <div
        className='classic-stats-line'
        title={`入 ${fmtNum(s.inn)} · 出 ${fmtNum(s.out)} · 缓存 ${fmtNum(s.read)}/${fmtNum(s.write)}`}
      >
        <small>今日</small>
        <b className='text-[color:var(--status-ok)]'>{fmtUsd(s.today, 2)}</b>
      </div>
      <div className='text-muted-foreground'>
        {fmtNum(s.req)} 请求 · {fmtNum(s.tok)} tok
      </div>
      <div className='classic-stats-line'>
        <small>7D</small>
        {w.known ? (
          <>
            <span
              title='7D 成功请求'
              className='classic-outcome'
              data-outcome='ok'
            >
              {fmtNum(w.success)}
            </span>
            <span
              title='7D 失败请求'
              className='classic-outcome'
              data-outcome='bad'
            >
              {fmtNum(w.fail)}
            </span>
          </>
        ) : (
          <span className='text-muted-foreground'>
            {fmtNum(w.req)} 请求 · 成败未知
          </span>
        )}
      </div>
    </div>
  )
}

function cellValue(
  key: Exclude<ColumnKey, 'vm'>,
  r: RowData,
  now: number
): ReactNode {
  const { vm } = r
  if (key === 'type') return <TypeCell vm={vm} />
  if (key === 'status') return <StatusCell r={r} />
  if (vm.gemini) return '—'
  switch (key) {
    case 'sched':
      return <SchedulableSwitch {...vmSchedulableProps(vm)} />
    case 'req':
      return <RequestCell r={r} />
    case 'cost':
      return (
        <div className='classic-stack'>
          <b>7D {fmtUsd(r.spend, 2)}</b>
          <span className='text-muted-foreground' title='累计费用'>
            Σ {fmtUsd(r.total, 2)}
          </span>
        </div>
      )
    case 'usage': {
      const f = r.win.fable && fableState(vm)
      const alert =
        f &&
        (f.tone.cls === 'bad' ||
          f.tone.cls === 'warn' ||
          f.tone.text === FABLE_MAX_ONLY_TEXT ||
          (f.usedPct != null && f.usedPct >= 85))
      return (
        <div className='classic-stack'>
          {r.win['5h'] && <Quota w={r.win['5h']} now={now} cost={r.fiveCost} />}
          {r.win['7d'] && <Quota w={r.win['7d']} now={now} cost={r.spend} />}
          {alert ? (
            <span className='classic-alert'>
              Fable{' '}
              {f.usedPct != null && f.usedPct >= 100 ? '已满' : f.tone.text}
            </span>
          ) : null}
        </div>
      )
    }
    case 'health':
      return (
        <div className='classic-stack'>
          <b>
            {r.health == null
              ? vm.health_24h === undefined
                ? '未知'
                : '无请求'
              : fmtHealthPct(r.health)}
          </b>
          <span
            className='classic-history'
            role='img'
            aria-label='近 24 小时请求健康时间线'
          >
            {r.healthSlots.map((state, i) => (
              <i key={i} style={{ background: SLOT_BG[state] }} />
            ))}
          </span>
        </div>
      )
    case '5h':
    case '7d':
    case 'fable': {
      const w = r.win[key]
      return !w
        ? '—'
        : w.note ||
            (w.pct == null ? (
              '未探测'
            ) : (
              <b className={w.pct >= 70 ? riskFg(w.pct) : undefined}>
                {Math.round(w.pct)}%{w.pct >= 100 ? ' · 已满' : ''}
              </b>
            ))
    }
    case 'seats':
      return r.seatsMax == null ? (
        '—'
      ) : (
        <span title={seatTitle(vm)}>
          {r.seatsUsed}/{r.seatsMax}
        </span>
      )
    case 'perReq':
      return r.perReq == null ? '—' : fmtUsd(r.perReq, 3)
    case 'spend':
    case 'total':
      return fmtUsd(r[key], 2)
    case 'queue':
      return (
        <span className={r.queue ? 'classic-alert' : undefined}>
          {fmtNum(r.queue)}
        </span>
      )
    default:
      return fmtNum(r[key])
  }
}

type Agg = {
  n: number
  gemini: number
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
    gemini: 0,
    ok: 0,
    req: 0,
    today: 0,
    spend: 0,
    used: 0,
    cap: 0,
    queue: 0,
    queued: 0,
    by: emptyZoneCounts(),
    top: null,
  }
  for (const r of rows) {
    if (r.vm.gemini) a.gemini++
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
  const geminiZones = GEMINI_EVIDENCE_ZONES.filter((z) => a.by[z.key] > 0)
  return (
    <section
      aria-label='当前列表汇总'
      className='grid grid-cols-2 gap-px rounded-lg border border-border/60 bg-card text-sm @min-[36rem]/vm-summary:grid-cols-3 @min-[64rem]/vm-summary:grid-cols-6'
    >
      <Kpi
        k={a.gemini ? '账号总数' : '在池'}
        v={
          a.gemini ? (
            a.n
          ) : (
            <>
              {a.by.pool}
              <span className='text-muted-foreground'>/{a.n}</span>
            </>
          )
        }
        x={
          a.gemini
            ? `Gemini ${a.gemini} · 普通槽 ${a.n - a.gemini}`
            : `受限 ${a.by.restricted} · 关闭 ${a.by.off} · 未使用 ${a.by.none} · 不可调度 ${a.by.dead}`
        }
      />
      <Kpi
        k={a.gemini ? '普通槽 24h 成功率' : '24h 成功率'}
        v={fmtHealthPct(pct)}
        x={`失败 ${fmtNum(a.req - a.ok)}`}
        tone={HEALTH_FG[healthTone(pct)]}
      />
      <Kpi
        k={a.gemini ? '普通槽近 24h 请求' : '近 24h 请求'}
        v={fmtNum(a.req)}
        x={`北京时间今日 ${fmtNum(a.today)}`}
      />
      <Kpi
        k={a.gemini ? '普通槽 7 天花费' : '7 天窗口花费'}
        v={a.spend ? fmtUsd(a.spend, 2) : '—'}
        x={a.top ? `最高 ${a.top.vm.id} ${fmtUsd(a.top.spend, 0)}` : ''}
      />
      <Kpi
        k={a.gemini ? '普通槽席位占用' : '席位占用'}
        v={
          <>
            {a.used}
            <span className='text-muted-foreground'>/{a.cap}</span>
          </>
        }
        x={a.cap ? `${Math.round((a.used / a.cap) * 100)}%` : ''}
      />
      <Kpi
        k={a.gemini ? '普通槽排队' : '排队'}
        v={a.queue}
        x={a.queued ? `${a.queued} 台有排队` : '无排队'}
        tone={a.queue ? 'text-[color:var(--status-warn)]' : undefined}
      />
      {geminiZones.length > 0 ? (
        <div className='flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 pt-2 text-xs'>
          {geminiZones.map(({ key, label, tone, hint }) => (
            <span
              key={key}
              title={hint}
              className='inline-flex items-center gap-1.5'
            >
              <StatusMark tone={{ key, text: label, cls: tone }} />
              <b className='font-mono tabular-nums'>{a.by[key]}</b>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  )
}

export function VmTable({
  vms,
  accounts,
  zoom = 100,
  fleetCount = vms.length,
  filters,
  viewControls,
  zoomControl,
  emptyState,
}: {
  vms: Vm[]
  accounts?: UsageAccountRow[]
  /** 列表放大，100–200。100 为原尺寸。 */
  zoom?: number
  fleetCount?: number
  filters?: ReactNode
  viewControls?: ReactNode
  zoomControl?: ReactNode
  emptyState?: ReactNode
}) {
  const actions = useVmActions()
  const columns = useListColumns()
  const [dragging, setDragging] = useState<ColumnKey | null>(null)
  const sortId = useId()
  const summaryId = useId()
  const [showSummary, setShowSummary] = useState(false)
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
    const key = sort?.key ?? 'status'
    const direction = sort?.dir ?? 1
    if (key in PAGE_SORT) {
      return sortVms(
        vms,
        PAGE_SORT[key as keyof typeof PAGE_SORT],
        direction === 1 ? 'asc' : 'desc',
        accounts
      ).map((vm) => rowData(vm, accounts))
    }
    const f =
      key === 'remain'
        ? (r: RowData) => {
            const pct = r.win['5h']?.pct
            return pct == null ? null : 100 - pct
          }
        : SORT_VALUE[key as MetricKey]
    // 无数据永远排在最后，不随方向翻转。
    return vms
      .map((vm) => rowData(vm, accounts))
      .map((r, i) => ({ r, i, v: r.vm.gemini ? null : f(r) }))
      .sort((a, b) => {
        if (a.v == null || b.v == null)
          return a.v == null && b.v == null ? a.i - b.i : a.v == null ? 1 : -1
        return direction * (a.v - b.v) || a.i - b.i
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

  const onSort = (key: SortKey) => {
    const first = ASC_FIRST.has(key) ? 1 : -1
    setSort((previous) => {
      const current = previous ?? { key: 'status', dir: 1 }
      if (current.key !== key) return { key, dir: first }
      return current.dir === first ? { key, dir: first === 1 ? -1 : 1 } : null
    })
  }

  const setOpen = (id: string, open: boolean) =>
    setExpanded((prev) => {
      if (prev.has(id) === open) return prev
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  const toggle = (id: string) => setOpen(id, !expanded.has(id))
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, vm: Vm) => {
    if ((e.target as HTMLElement).closest(ROW_INTERACTIVE)) return
    if (String(window.getSelection?.() ?? '')) return
    toggle(vm.id)
  }
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, vm: Vm) => {
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

  const activeKey = sort?.key ?? 'status'
  const direction = sort?.dir ?? 1
  const visible = columns.visible
  const sortKeyFor = (key: ColumnKey): SortKey | undefined => {
    if (METRIC_COLUMNS.some((k) => k === key)) return key as MetricKey
    return (
      {
        vm: 'name',
        status: 'status',
        req: 'today',
        usage: '5h',
        cost: 'spend',
      } as Partial<Record<ColumnKey, SortKey>>
    )[key]
  }
  // Prefer the dedicated metric header if its classic group sorts by the same value.
  const sortedColumn =
    visible.find((k) => k === activeKey) ??
    visible.find((k) => sortKeyFor(k) === activeKey)
  const width = visible.reduce(
    (sum, k) => sum + (k === 'vm' ? 0 : COLUMNS[k].width),
    2.65
  )
  // Give surplus width to data columns; the pinned identity must keep its own width.
  const flexible = visible.filter(
    (key) => key === 'status' || key === 'req' || key === 'usage'
  )
  const stretch: ColumnKey[] = flexible.length
    ? flexible
    : visible.filter((key) => key !== 'vm')
  function columnWidth(key: ColumnKey) {
    if (key === 'vm') return 'var(--account-width)'
    const base = `${COLUMNS[key].width}rem`
    if (!stretch.includes(key)) return base
    return `calc(${base} + (100% - var(--account-width) - ${width}rem) / ${stretch.length})`
  }
  return (
    <div className='@container/vm-summary min-w-0'>
      <div className='classic-tools'>
        {filters}
        <div className='classic-tools-end'>
          <label htmlFor={sortId} className='sr-only'>
            排序指标
          </label>
          <select
            id={sortId}
            className='classic-sort'
            value={activeKey}
            onChange={(e) => {
              const key = e.target.value as SortKey
              setSort({ key, dir: ASC_FIRST.has(key) ? 1 : -1 })
            }}
          >
            {Object.entries(SORT_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <Button
            type='button'
            variant='outline'
            size='icon'
            className='size-8'
            aria-label={direction === 1 ? '改为降序' : '改为升序'}
            onClick={() =>
              setSort({ key: activeKey, dir: direction === 1 ? -1 : 1 })
            }
          >
            {direction === 1 ? <ArrowUp /> : <ArrowDown />}
          </Button>
          <VmColumnPicker columns={columns} />
          <Button
            type='button'
            variant={showSummary ? 'secondary' : 'outline'}
            size='sm'
            aria-expanded={showSummary}
            aria-controls={showSummary ? summaryId : undefined}
            onClick={() => setShowSummary(!showSummary)}
          >
            <ChartNoAxesColumnIncreasing />
            列表统计
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type='button'
                variant='outline'
                size='icon'
                className='size-8'
                title='列表选项'
                aria-label='列表选项'
              >
                <Settings2 />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align='end'
              aria-label='列表选项'
              className='grid w-60 gap-2 text-sm'
            >
              <label className='flex items-center gap-2'>
                <input
                  type='checkbox'
                  checked={grouped}
                  onChange={() => setGrouped(!grouped)}
                />
                按状态分组
              </label>
              <label className='flex items-center gap-2'>
                <input
                  type='checkbox'
                  checked={pinSec}
                  onChange={() => setPinSec(!pinSec)}
                />
                次要信息常显
              </label>
              {zoomControl}
            </PopoverContent>
          </Popover>
          {viewControls}
        </div>
      </div>
      {showSummary ? (
        <section
          id={summaryId}
          aria-label='列表统计'
          className='mb-3 grid gap-2'
        >
          <h3 className='text-xs font-semibold'>
            当前列表 {total.n} / 当前平台 {fleetCount}
          </h3>
          <SummaryBar a={total} />
        </section>
      ) : null}
      <span role='status' className='sr-only'>
        按{SORT_LABEL[activeKey]}
        {direction === 1 ? '升序' : '降序'}排列
      </span>
      {!rows.length && emptyState ? (
        emptyState
      ) : (
        <div
          data-vm-table
          data-pin={pinSec}
          className='classic-frame'
          style={zoom === 100 ? undefined : { zoom: zoom / 100 }}
        >
          <div
            className='classic-scroll'
            role='region'
            aria-label='账号列表横向滚动'
            tabIndex={0}
          >
            <table
              className='classic-table'
              aria-label='槽位列表'
              style={{ minWidth: `calc(var(--account-width) + ${width}rem)` }}
            >
              <colgroup>
                {visible.map((key) => (
                  <col key={key} style={{ width: columnWidth(key) }} />
                ))}
                <col
                  style={{ width: stretch.length ? '2.65rem' : undefined }}
                />
              </colgroup>
              <thead>
                <tr>
                  {visible.map((key) => {
                    const sortKey = sortKeyFor(key),
                      active = sortedColumn === key
                    const label =
                      key === 'status' && total.gemini > 0 && total.gemini === total.n
                        ? 'Gemini 状态'
                        : COLUMNS[key].label
                    return (
                      <th
                        key={key}
                        scope='col'
                        data-column={key}
                        aria-sort={
                          active
                            ? direction === 1
                              ? 'ascending'
                              : 'descending'
                            : undefined
                        }
                        draggable={key !== 'vm'}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData('text/plain', key)
                          setDragging(key)
                        }}
                        onDragEnd={() => setDragging(null)}
                        onDragOver={(e) => {
                          if (dragging && key !== 'vm') e.preventDefault()
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          if (dragging) columns.move(dragging, key)
                          setDragging(null)
                        }}
                        onKeyDown={(e) => {
                          if (
                            !e.altKey ||
                            key === 'vm' ||
                            !['ArrowLeft', 'ArrowRight'].includes(e.key)
                          )
                            return
                          e.preventDefault()
                          const next =
                            visible[
                              visible.indexOf(key) +
                                (e.key === 'ArrowLeft' ? -1 : 1)
                            ]
                          if (next) columns.move(key, next)
                        }}
                        tabIndex={!sortKey && key !== 'vm' ? 0 : undefined}
                      >
                        {sortKey ? (
                          <button type='button' onClick={() => onSort(sortKey)}>
                            {label}
                            {active ? (
                              direction === 1 ? (
                                <ArrowUp aria-hidden />
                              ) : (
                                <ArrowDown aria-hidden />
                              )
                            ) : null}
                          </button>
                        ) : (
                          label
                        )}
                      </th>
                    )
                  })}
                  <th scope='col' className='classic-actions'>
                    <span className='sr-only'>操作</span>
                  </th>
                </tr>
              </thead>
              {sections.map((sec) => {
                const zone = sec.head
                  ? ZONES.find((z) => z.key === sec.key)
                  : undefined
                const isCollapsed = zone && collapsed.has(zone.key)
                return (
                  <tbody key={sec.key} role='rowgroup'>
                    {zone ? (
                      <tr role='row'>
                        <td
                          colSpan={visible.length + 1}
                          role='cell'
                          className='classic-group'
                        >
                          <button
                            type='button'
                            aria-expanded={!isCollapsed}
                            onClick={() => toggleGroup(zone.key)}
                          >
                            <ChevronRight
                              aria-hidden
                              className={cn(
                                'size-3',
                                !isCollapsed && 'rotate-90'
                              )}
                            />
                            {zone.label} · {sec.rows.length} 台
                          </button>
                          <span>成功率 {fmtHealthPct(aggPct(sec.agg))}</span>
                          <span>近 24h 请求 {fmtNum(sec.agg.req)}</span>
                          <span>7 天窗口花费 {fmtUsd(sec.agg.spend, 2)}</span>
                          <span>
                            席位 {sec.agg.used}/{sec.agg.cap}
                          </span>
                        </td>
                      </tr>
                    ) : null}
                    {!isCollapsed &&
                      sec.rows.map((r) => {
                        const { vm } = r
                        const open = expanded.has(vm.id)
                        const detailId = `vm-row-detail-${vm.id}`
                        return (
                          <Fragment key={vm.id}>
                            <tr
                              data-vm-row
                              role='row'
                              tabIndex={0}
                              aria-expanded={open}
                              aria-label={`${vm.id}，${vm.gemini ? poolStatus(vm).text : scheduleStateLabel(vm)}。Enter 展开明细，Shift+Enter 打开详情`}
                              className={cn(
                                'classic-data-row',
                                open && 'classic-open'
                              )}
                              onClick={(e) => onRowClick(e, vm)}
                              onKeyDown={(e) => onRowKey(e, vm)}
                            >
                              {visible.map((key) =>
                                key === 'vm' ? (
                                  <th
                                    scope='row'
                                    data-vm-cell='account'
                                    key={key}
                                    className={cn(
                                      'classic-pinned',
                                      tierVisual(vm).row
                                    )}
                                  >
                                    <AccountCell
                                      r={r}
                                      showMeta={pinSec}
                                      open={open}
                                      detailId={detailId}
                                      toggle={() => toggle(vm.id)}
                                      openDetail={() => actions.openDetail(vm)}
                                    />
                                  </th>
                                ) : (
                                  <td key={key} data-vm-cell={key}>
                                    {cellValue(key, r, now)}
                                  </td>
                                )
                              )}
                              <td className='classic-actions'>
                                <VmActionMenu vm={vm} />
                              </td>
                            </tr>
                            {open ? (
                              <tr role='row'>
                                <td
                                  role='cell'
                                  colSpan={visible.length + 1}
                                  className='classic-expanded'
                                >
                                  <div className='classic-detail-width'>
                                    {vm.gemini ? (
                                      <div
                                        id={detailId}
                                        role='region'
                                        aria-label={`${vm.id} 明细`}
                                        className='flex flex-wrap items-center gap-3 border-b p-3 text-xs'
                                      >
                                        <span>{vm.email || '未提供邮箱'}</span>
                                        <span>
                                          {vm.gemini.account?.plan ||
                                            '未提供订阅'}
                                        </span>
                                        <span>宿主机 · CRAGAnti</span>
                                        <ProxyChip vm={vm} compact />
                                        <Button
                                          size='sm'
                                          variant='ghost'
                                          onClick={() => actions.openDetail(vm)}
                                        >
                                          管理 Gemini 凭证
                                        </Button>
                                      </div>
                                    ) : (
                                      <VmRowDetail
                                        id={detailId}
                                        vm={vm}
                                        accounts={accounts}
                                        now={now}
                                        onOpenDetail={() =>
                                          actions.openDetail(vm)
                                        }
                                      />
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        )
                      })}
                  </tbody>
                )
              })}
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
