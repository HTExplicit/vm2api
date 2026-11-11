#!/usr/bin/env node
/**
 * Post-upgrade slot refresh, run inside the control-plane container. The work
 * goes through the running server: only that process holds the cluster SSH
 * links, so a standalone runFleetUpdate fails every node slot with
 * cluster_unavailable.
 *
 *   1. wait until every node that hosts a slot has a ready link
 *   2. update the trusted CRAG package, then install changed wrap slots once
 *      through the server's drain/restart transaction; sync other payloads
 *   3. telemetry: publish the saved policy to supported Claude slots and await its acknowledgment
 */
import fs from 'node:fs/promises'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyCragV2Tree } from '../src/lib/vm/wrap-cli-runtime.mjs'
import { updateCrag } from './update-crag.mjs'

const root = String(process.argv[2] || process.env.KIN_PROJECT_ROOT || '/opt/vm2api').replace(/\/+$/, '')
const concurrency = Number(process.argv[3] || 4)
const cragTag = String(process.argv[4] || '')
const port = String(process.env.PORT || '8787')
const base = String(process.env.KIN_AUTO_SYNC_BASE || `http://127.0.0.1:${port}`).replace(/\/+$/, '')
const envKey = String(process.env.VM2API_API_KEY || process.env.KIN_API_KEY || '').trim()
const linkWaitMs = Number(process.env.KIN_FLEET_LINK_WAIT_MS || 120_000)
const pollMs = Number(process.env.KIN_FLEET_POLL_MS || 2_000)
// Node image builds stream the payload over SSH; fetch would give up after undici's 300 s header timeout.
const SYNC_TIMEOUT_MS = 30 * 60_000

async function apiKey() {
  if (envKey) return envKey
  try {
    const text = await fs.readFile(`${root}/.env`, 'utf8')
    const line = text.split(/\r?\n/).find((entry) => /^(?:VM2API_API_KEY|KIN_API_KEY)=/.test(entry))
    return line
      ? line
          .slice(line.indexOf('=') + 1)
          .replace(/^['"]|['"]$/g, '')
          .trim()
      : ''
  } catch {
    return ''
  }
}

function call(key, method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const headers = { Authorization: `Bearer ${key}` }
    if (payload !== null) headers['content-type'] = 'application/json'
    const req = http.request(new URL(pathname, base), { method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => {
        clearTimeout(timer)
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, json })
      })
      res.on('error', reject)
    })
    const timer = setTimeout(() => req.destroy(new Error(`${pathname}: timed out`)), timeoutMs)
    req.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    req.end(payload)
  })
}

async function healthReady() {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

/** Panel data from a JSON response; a body without data is the request's own failure. */
function dataOf(pathname, response) {
  const data = response.json?.data
  if (data && typeof data === 'object') return data
  throw new Error(`${pathname}: ${response.json?.error?.message || `HTTP ${response.status}`}`)
}

async function fleetSlots(key) {
  const data = dataOf('/api/panel/vms', await call(key, 'GET', '/api/panel/vms', undefined, 15_000))
  const vms = Array.isArray(data) ? data : data.items
  if (!Array.isArray(vms)) throw new Error('/api/panel/vms: invalid slot list')
  return vms
}

/** Keep the node inventory used by the link wait so native hosts can be excluded from telemetry. */
async function waitNodeLinks(key, nodeIds) {
  const deadline = Date.now() + linkWaitMs
  let pending = nodeIds
  let nodes = []
  for (;;) {
    try {
      const data = dataOf(
        '/api/panel/cluster/nodes',
        await call(key, 'GET', '/api/panel/cluster/nodes', undefined, 15_000),
      )
      nodes = data.items || []
      const ready = new Set(nodes.filter((node) => node.link?.state === 'ready').map((node) => node.id))
      pending = nodeIds.filter((id) => !ready.has(id))
    } catch (error) {
      console.warn(`[fleet-services] node link check failed: ${error?.message || error}`)
    }
    if (!pending.length || Date.now() >= deadline) return { offline: pending, nodes }
    await delay(pollMs)
  }
}

function summarizeKernelSync(report) {
  return {
    ok: report.ok === true,
    total: report.total || 0,
    ok_count: report.ok_count || 0,
    failed_count: report.failed_count || 0,
    changed_count: report.changed_count || 0,
    items: (report.items || []).map((item) => ({
      id: item.id,
      node_id: item.node_id || null,
      ok: item.ok === true,
      kernel_changed: item.kernel_changed === true,
      ...(item.ok ? {} : { code: item.code || null, error: item.error || null }),
    })),
  }
}

/** One post-upgrade pass; the installer owns each changed wrap slot's restart. */
export async function refreshFleetKernels(projectRoot, vms, { api, cragUpdate = updateCrag, cragVersion = '' } = {}) {
  const factory = path.join(projectRoot, 'share/crag/kernels/v2', process.arch === 'arm64' ? 'arm64' : 'amd64')
  let crag = null
  let hasFactory = false
  try {
    await fs.access(path.join(factory, 'manifest.json'))
    hasFactory = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (hasFactory) {
    const verified = verifyCragV2Tree(factory)
    if (!verified.ok) throw new Error(`CRAG factory invalid: ${verified.code}`)
    crag = await cragUpdate(projectRoot, { tag: cragVersion, api: (endpoint, body) => api('POST', endpoint, body) })
  }
  const wrap = vms.filter(
    (vm) =>
      vm.family === 'claude' &&
      vm.node_platform !== 'darwin' &&
      (vm.resolved_dataplane || vm.dataplane || 'wrap') === 'wrap',
  )
  let checked = { ok: true, items: [] }
  let installed = { ok: true, items: [] }
  if (wrap.length) {
    const version = await api('GET', '/api/panel/version')
    if (!version.current_tag) throw new Error('running release tag is unavailable')
    await api('POST', '/api/panel/kernels/pull', { kernel: 'cli-node', tag: version.current_tag })
    checked = await api('POST', '/api/panel/wrap-cli/sync', { ids: wrap.map((vm) => vm.id), restart: false })
    if (checked.ok !== true || checked.failed_count) throw new Error('wrap kernel inspection failed')
    const targets = checked.items
      .filter((item) => item.kernel_changed)
      .map((item) => ({ id: item.id, kernel: 'cli-node' }))
    if (targets.length) {
      installed = await api('POST', '/api/panel/kernels/install', { targets })
      if (installed.ok !== true || installed.failed_count) throw new Error('wrap kernel installation failed')
    }
  }
  const managed = new Set(wrap.map((vm) => vm.id))
  const rest = vms.filter((vm) => !managed.has(vm.id) && (vm.resolved_dataplane || vm.dataplane) !== 'crag')
  const legacy = rest.length
    ? await api('POST', '/api/panel/wrap-cli/sync', { ids: rest.map((vm) => vm.id), restart: true })
    : { ok: true, items: [] }
  const installedById = new Map(installed.items.map((item) => [item.id, item]))
  const items = [...checked.items.map((item) => ({ ...item, ...installedById.get(item.id) })), ...legacy.items]
  const failed_count = items.filter((item) => !item.ok).length
  return {
    ok: legacy.ok === true && failed_count === 0,
    total: items.length,
    ok_count: items.length - failed_count,
    failed_count,
    changed_count: items.filter((item) => item.kernel_changed).length,
    items,
    crag,
  }
}

async function main() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (await healthReady()) break
    await delay(pollMs)
  }

  const key = await apiKey()
  if (!key) {
    console.error('[fleet-services] API key is unavailable; slot refresh skipped')
    process.exit(1)
  }

  try {
    const vms = await fleetSlots(key)
    const nodeIds = [...new Set(vms.map((vm) => vm.node_id).filter(Boolean))]
    let nodes = []
    if (nodeIds.length) {
      const links = await waitNodeLinks(key, nodeIds)
      nodes = links.nodes
      // Slots on these nodes fail below with node_not_ready; the rest still update.
      if (links.offline.length) console.warn(`[fleet-services] node link not ready: ${links.offline.join(', ')}`)
    }
    const refreshed = await refreshFleetKernels(
      root,
      vms.map((vm) => ({
        ...vm,
        node_platform: vm.node_platform || nodes.find((node) => node.id === vm.node_id)?.platform,
      })),
      {
        api: async (method, endpoint, body) =>
          dataOf(endpoint, await call(key, method, endpoint, body, SYNC_TIMEOUT_MS)),
        cragVersion: cragTag,
      },
    )
    const kernels = summarizeKernelSync(refreshed)
    const nativeNodes = new Set(nodes.filter((node) => node.platform === 'darwin').map((node) => node.id))
    const ids = vms.filter((vm) => vm.family === 'claude' && !nativeNodes.has(vm.node_id)).map((vm) => vm.id)
    // An empty ids list means all slots to the API, so do not submit an empty telemetry job.
    const report = ids.length
      ? dataOf(
          '/api/panel/vms/fleet-update',
          await call(
            key,
            'POST',
            '/api/panel/vms/fleet-update',
            { action: 'telemetry', concurrency, ids },
            SYNC_TIMEOUT_MS,
          ),
        )
      : { action: 'telemetry', concurrency, total: 0, ok_count: 0, skipped_count: 0, failed_count: 0, items: [] }
    console.log(
      JSON.stringify({
        ...report,
        skipped_not_applicable: vms.length - ids.length,
        kernel_sync: kernels,
        crag: refreshed.crag,
      }),
    )
    if (report.skipped_count) {
      for (const item of report.items || []) {
        if (!item.skipped) continue
        const container = item.telemetry?.container || item.id
        console.warn(`[fleet-services] skipped ${item.id}: container unavailable (${container})`)
      }
    }
    if (!kernels.ok || report.failed_count) process.exit(1)
  } catch (error) {
    console.error(`[fleet-services] ${error?.message || error}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
