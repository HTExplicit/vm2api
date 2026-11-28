/**
 * Panel live stream: PoolScheduler 'change' events become throttled
 * `event: seats` frames (seats, queues, live requests per VM) and ProxyPool
 * 'change' events become `event: proxy` frames (SOCKS5 health per bound VM).
 * The web client reads it with fetch + ReadableStream because EventSource
 * cannot send the panel Bearer token.
 */

export const SEAT_STREAM_THROTTLE_MS = 250
export const SEAT_STREAM_PING_MS = 15_000

/**
 * @param {object} opts
 * @param {() => import('../pool/pool-scheduler.mjs').PoolScheduler | null} opts.getScheduler
 *   Read on every ping: initPoolRuntime() may swap the scheduler instance.
 * @param {import('../vm/proxy-pool.mjs').ProxyPool | null} [opts.proxyPool]
 * @param {(() => Set<string>) | null} [opts.visibleVmIds] Null = every VM (admin / super).
 */
export function servePoolSeatStream({
  req,
  res,
  getScheduler,
  proxyPool = null,
  writeSSEHeaders,
  visibleVmIds = null,
  throttleMs = SEAT_STREAM_THROTTLE_MS,
  pingMs = SEAT_STREAM_PING_MS,
}) {
  writeSSEHeaders(res)
  let scheduler = null
  let seatTimer = null
  let proxyTimer = null
  let closed = false

  const scope = (byVm, visible = visibleVmIds ? visibleVmIds() : null) => {
    return visible ? Object.fromEntries(Object.entries(byVm).filter(([id]) => visible.has(id))) : byVm
  }

  const sendSeats = () => {
    seatTimer = null
    if (closed) return
    const snap = scheduler?.seatSnapshot?.() || {}
    const visible = visibleVmIds ? visibleVmIds() : null
    const frame = {
      seats: scope(snap.seats || {}, visible),
      codex_inflight: scope(snap.codex_inflight || {}, visible),
      global_queue_depth: Number(snap.global_queue_depth) || 0,
      queue_max: Number(snap.queue_max) || 0,
      ts: Date.now(),
    }
    res.write(`event: seats\ndata: ${JSON.stringify(frame)}\n\n`)
  }
  const sendProxies = () => {
    proxyTimer = null
    if (closed || !proxyPool) return
    const frame = { proxies: scope(proxyPool.liveStatusByVm?.() || {}), ts: Date.now() }
    res.write(`event: proxy\ndata: ${JSON.stringify(frame)}\n\n`)
  }
  // Both run inside acquire/release and probe paths: only arm a timer, never throw.
  const onSeatChange = () => {
    if (seatTimer || closed) return
    seatTimer = setTimeout(sendSeats, throttleMs)
  }
  const onProxyChange = () => {
    if (proxyTimer || closed) return
    proxyTimer = setTimeout(sendProxies, throttleMs)
  }
  const bind = () => {
    const next = getScheduler() || null
    if (next === scheduler) return false
    scheduler?.off?.('change', onSeatChange)
    scheduler = next
    scheduler?.on?.('change', onSeatChange)
    return true
  }

  bind()
  proxyPool?.on?.('change', onProxyChange)
  sendSeats()
  sendProxies()
  const ping = setInterval(() => {
    if (closed) return
    if (bind()) onSeatChange()
    res.write(': ping\n\n')
  }, pingMs)

  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(seatTimer)
    clearTimeout(proxyTimer)
    clearInterval(ping)
    scheduler?.off?.('change', onSeatChange)
    proxyPool?.off?.('change', onProxyChange)
  }
  req.on('close', close)
  res.on('close', close)
  res.on('error', close)
}
