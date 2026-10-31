import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { createProxyAgent } from '../vm/proxy-agent.mjs'

// The launcher and browser are paired by the pinned npm release. Resolve an
// installed build explicitly: account work must never start a browser download.
export const PLATFORM_BROWSER_BUILD = 'official/156.0.1-beta.36'

function problem(code, message) {
  return Object.assign(new Error(message), { code })
}

function boundProxy(value) {
  if (!value) throw problem('proxy_required', '账号未绑定代理')
  const url = new URL(String(value).replace(/^socks5:/i, 'socks5h:'))
  if (!['socks5h:', 'http:', 'https:'].includes(url.protocol)) {
    throw problem('proxy_unsupported', '账号代理协议不受支持')
  }
  return url.href
}

/** Firefox talks to a credential-free loopback proxy; every tunnel uses the
 * selected account's authenticated upstream proxy, including remote DNS. */
export async function createBoundProxyRelay(proxyUrl) {
  const agent = createProxyAgent(boundProxy(proxyUrl))
  const shutdown = new AbortController()
  // SOCKS' own handshake timer closes a non-answering peer. HTTP proxy sockets
  // are created before connect() returns, so abort them when this relay closes.
  agent.timeout = 15_000
  if (agent.connectOpts) agent.connectOpts.signal = shutdown.signal
  const sockets = new Set()
  const track = (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    return socket
  }
  const server = http.createServer((req, res) => {
    let target
    try {
      target = new URL(req.url)
      if (target.protocol !== 'http:') throw new Error('absolute HTTP URL required')
    } catch {
      res.writeHead(400).end()
      return
    }
    const headers = { ...req.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const upstream = http.request(target, { method: req.method, headers, agent }, (response) => {
      res.writeHead(response.statusCode, response.headers)
      response.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.once('aborted', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connection', track)
  server.on('connect', async (req, socket, head) => {
    let upstream
    try {
      const target = new URL(`http://${req.url}`)
      const host = target.hostname.replace(/^\[|\]$/g, '')
      const port = Number(target.port || 443)
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid target')
      let rejected = false
      req.once('proxyConnect', (response) => {
        rejected = response.statusCode !== 200
      })
      upstream = track(await agent.connect(req, { host, port, secureEndpoint: false }))
      if (rejected || socket.destroyed) {
        upstream.destroy()
        socket.destroy()
        return
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
      socket.once('close', () => upstream.destroy())
      upstream.once('close', () => socket.destroy())
    } catch {
      upstream?.destroy()
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      shutdown.abort()
      for (const socket of sockets) socket.destroy()
      agent.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Store only the concrete browser identity, never the launch environment,
 * current proxy credentials, or machine-specific executable/font paths. */
export function fingerprintFromLaunch(options) {
  const json = Object.entries(options.env || {})
    .filter(([key]) => /^CAMOU_CONFIG_\d+$/.test(key))
    .sort(([a], [b]) => Number(a.slice(13)) - Number(b.slice(13)))
    .map(([, value]) => value)
    .join('')
  const config = JSON.parse(json)
  delete config.addons
  return { config, firefoxUserPrefs: { ...(options.firefoxUserPrefs || {}) } }
}

function localeForLocation(location, previous, requested) {
  const country = location.country_code
  for (const candidate of [requested, previous]) {
    if (!candidate) continue
    try {
      if (new Intl.Locale(candidate).maximize().region === country) return candidate
    } catch {}
  }
  return new Intl.Locale(`und-${country}`).maximize().toString()
}

/** Hardware identity remains fixed; location follows a deliberate proxy change. */
export function fingerprintAtLocation(fingerprint, location, locale) {
  const result = structuredClone(fingerprint)
  const config = result.config
  const previousLocale = [config['locale:language'], config['locale:region']].filter(Boolean).join('-')
  const targetLocale = new Intl.Locale(localeForLocation(location, previousLocale, locale))
  const language = targetLocale.language
  const region = targetLocale.region || location.country_code
  const languageTag = `${language}-${region}`
  config.timezone = location.timezone
  config['locale:language'] = language
  config['locale:region'] = region
  if (targetLocale.script) config['locale:script'] = targetLocale.script
  else delete config['locale:script']
  config['locale:all'] = languageTag
  config['navigator.language'] = languageTag
  config['navigator.languages'] = [languageTag, language]
  config['headers.Accept-Language'] = `${languageTag},${language};q=0.9`
  config['geolocation:latitude'] = location.latitude
  config['geolocation:longitude'] = location.longitude
  delete config['webrtc:ipv4']
  delete config['webrtc:ipv6']
  config[net.isIPv6(location.ip) ? 'webrtc:ipv6' : 'webrtc:ipv4'] = location.ip
  Object.assign(result.firefoxUserPrefs, {
    'intl.locale.requested': languageTag,
    'network.proxy.socks_remote_dns': true,
    'network.dns.disableIPv6': !net.isIPv6(location.ip),
    'media.peerconnection.ice.proxy_only_if_behind_proxy': true,
    'permissions.default.geo': 1,
  })
  return result
}

async function proxyLocation(proxyUrl) {
  const { default: fetch } = await import('node-fetch')
  const { getMmdbPath } = await import('camoufox/dist/geolocation.js')
  const { default: maxmind } = await import('maxmind')
  const agent = createProxyAgent(proxyUrl)
  let ip
  try {
    const response = await fetch('https://api.ipify.org?format=json', {
      agent,
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error('exit lookup failed')
    ip = (await response.json()).ip
  } finally {
    agent.destroy()
  }
  if (!net.isIP(ip)) throw problem('proxy_exit_unavailable', '无法核对账号代理出口')
  // Read the image's GeoIP database directly. The launcher's geoip:true option
  // auto-updates stale databases using its own downloader during account work.
  const file = getMmdbPath(net.isIPv6(ip) ? 'ipv6' : 'ipv4')
  if (!fs.existsSync(file)) throw problem('browser_geoip_missing', '镜像缺少浏览器地理数据库')
  const geo = new maxmind.Reader(fs.readFileSync(file)).get(ip)
  const result = {
    ip,
    country_code: geo?.country?.iso_code,
    timezone: geo?.location?.time_zone,
    latitude: geo?.location?.latitude,
    longitude: geo?.location?.longitude,
  }
  if (
    !result.country_code ||
    !result.timezone ||
    !Number.isFinite(result.latitude) ||
    !Number.isFinite(result.longitude)
  ) {
    throw problem('proxy_geo_unavailable', '无法核对账号代理地理信息')
  }
  return result
}

async function runtime() {
  const camoufox = await import('camoufox')
  const { launchPath } = await import('camoufox/dist/pkgman.js')
  const { getEnvVars, getPrefEnvVars } = await import('camoufox/dist/utils.js')
  const { isModelInstalled } = await import('camoufox/dist/fpgen/index.js')
  const directory = camoufox.findInstalledVersion(PLATFORM_BROWSER_BUILD)
  if (!directory || !isModelInstalled()) {
    throw problem('browser_not_installed', '镜像缺少配套指纹浏览器或指纹模型')
  }
  return { ...camoufox, getEnvVars, getPrefEnvVars, executable: launchPath(directory) }
}

export async function createPlatformBrowserSession(
  { fingerprint, storageState, proxyUrl, locale, onFingerprint },
  overrides = {},
) {
  const proxy = boundProxy(proxyUrl)
  const resources = await (overrides.runtime || runtime)()
  const location = await (overrides.proxyLocation || proxyLocation)(proxy)
  const relay = await (overrides.createRelay || createBoundProxyRelay)(proxy)
  let browser
  try {
    const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]
    let saved = fingerprint
    if (!saved) {
      const options = await resources.launchOptions({
        executable_path: resources.executable,
        os,
        headless: true,
        exclude_addons: ['UBO'],
        locale: localeForLocation(location, null, locale),
      })
      saved = fingerprintFromLaunch(options)
    }
    saved = fingerprintAtLocation(saved, location, locale)
    // Persist before opening any authenticated website. A failed save must not
    // leave a new, unrecorded identity behind for this account.
    await onFingerprint?.(saved)
    const uaOs = saved.config['navigator.userAgent']?.includes('Windows')
      ? 'win'
      : saved.config['navigator.userAgent']?.includes('Macintosh')
        ? 'mac'
        : 'lin'
    browser = await resources.Camoufox({
      from_options: {
        executablePath: resources.executable,
        args: [],
        headless: true,
        env: {
          ...process.env,
          ...resources.getEnvVars(saved.config, uaOs, resources.executable),
          ...resources.getPrefEnvVars(saved.firefoxUserPrefs),
        },
        firefoxUserPrefs: saved.firefoxUserPrefs,
        proxy: { server: relay.url },
      },
    })
    const context = await browser.newContext({ viewport: null, ...(storageState ? { storageState } : {}) })
    const page = await context.newPage()
    let closed = false
    return {
      browser,
      context,
      page,
      fingerprint: saved,
      storageState: () => context.storageState({ indexedDB: true }),
      async close() {
        if (closed) return
        closed = true
        try {
          await browser.close()
        } finally {
          await relay.close()
        }
      },
    }
  } catch (error) {
    try {
      await browser?.close()
    } finally {
      await relay.close()
    }
    throw error
  }
}
