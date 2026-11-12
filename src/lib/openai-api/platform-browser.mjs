import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createProxyAgent } from '../vm/proxy-agent.mjs'
import { createBrowserTempCleanup } from '../browser/temp-cleanup.mjs'
import { createHeadedDisplay } from '../browser/headed-display.mjs'

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

/** Chromium talks to a credential-free loopback proxy; every tunnel uses the
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

async function runtime(cacheDir) {
  process.env.CLOAKBROWSER_CACHE_DIR = cacheDir
  process.env.CLOAKBROWSER_AUTO_UPDATE = 'false'
  const cloak = await import('cloakbrowser')
  const installed = cloak.binaryInfo()
  if (!installed.installed || !installed.binaryPath) {
    throw problem('browser_not_installed', '账号浏览器尚未安装，请在设置 → OpenAI 中安装。')
  }
  return {
    executable: installed.binaryPath,
    version: installed.version,
    async launchPersistentContext(options) {
      // The free launcher may ignore version pins. An explicit cached binary
      // bypasses ensureBinary, so opening an account never installs an update.
      const previous = process.env.CLOAKBROWSER_BINARY_PATH
      process.env.CLOAKBROWSER_BINARY_PATH = installed.binaryPath
      try {
        return await cloak.launchPersistentContext(options)
      } finally {
        if (previous === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH
        else process.env.CLOAKBROWSER_BINARY_PATH = previous
      }
    },
  }
}

export async function createPlatformBrowserSession(
  { profileDir, storageState, proxyUrl, licenseKey, cacheDir, signal },
  overrides = {},
) {
  const proxy = boundProxy(proxyUrl)
  if (!licenseKey?.trim()) throw problem('browser_key_required', '请先在设置 → OpenAI 中保存 CloakBrowser 授权 Key。')
  if (!profileDir || !path.isAbsolute(profileDir) || !cacheDir || !path.isAbsolute(cacheDir)) {
    throw problem('browser_path_required', '账号浏览器目录未配置。')
  }
  signal?.throwIfAborted()
  const resources = await (overrides.runtime || runtime)(cacheDir)
  signal?.throwIfAborted()
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  const temporary = overrides.tempCleanup || createBrowserTempCleanup({ executablePath: resources.executable })
  const recovered = await temporary.cleanup()
  let warning = recovered.warning || null
  let relay
  let display
  let context
  let closing
  let contextClosed = false
  let relayClosed = false
  let displayClosed = false
  let temporaryCleared = false
  let beforeLaunch
  let temporaryPaths
  const captureTemporaryPaths = () => {
    if (beforeLaunch && !temporaryPaths) temporaryPaths = temporary.createdSince(beforeLaunch)
  }
  const close = () => {
    if (closing) return closing
    closing = (async () => {
      if (!contextClosed) {
        try {
          await context?.close()
          contextClosed = true
        } catch {
          throw problem('browser_close_failed', '浏览器退出未完成，请重试关闭。')
        }
      }
      if (!relayClosed) {
        try {
          await relay?.close()
          relayClosed = true
        } catch {
          throw problem('browser_close_failed', '浏览器代理连接关闭未完成，请重试关闭。')
        }
      }
      if (!displayClosed) {
        await display?.close()
        displayClosed = true
      }
      if (!temporaryCleared) {
        captureTemporaryPaths()
        const report = await temporary.cleanup({ paths: temporaryPaths || [] })
        if (temporary.enabled && (report.failed.length || report.skipped.length)) {
          throw problem('browser_temp_cleanup_failed', report.warning || '浏览器临时文件清理未完成，请重试关闭。')
        }
        if (report.warning) warning = [warning, report.warning].filter(Boolean).join(' ')
        temporaryCleared = true
      }
    })().finally(() => {
      closing = null
    })
    return closing
  }
  try {
    relay = await (overrides.createRelay || createBoundProxyRelay)(proxy)
    signal?.throwIfAborted()
    display = await (overrides.createDisplay || createHeadedDisplay)({ signal })
    signal?.throwIfAborted()
    beforeLaunch = temporary.snapshot()
    try {
      context = await resources.launchPersistentContext({
        userDataDir: profileDir,
        licenseKey,
        headless: false,
        geoip: true,
        proxy: relay.url,
        launchOptions: { env: display.env },
      })
    } catch {
      throw problem('browser_start_failed', '账号浏览器启动失败，请检查浏览器安装和授权。')
    }
    captureTemporaryPaths()
    signal?.throwIfAborted()
    // Only HTTP updates waiting to reach this profile replace its cookies.
    // Ordinary DB snapshots can be older after a crash or a failed save.
    if (storageState?.cookies_pending === true && Array.isArray(storageState.cookies)) {
      const now = (overrides.now || Date.now)() / 1000
      const cookies = storageState.cookies.filter(
        (cookie) => cookie.expires == null || cookie.expires < 0 || cookie.expires > now,
      )
      await context.clearCookies()
      if (cookies.length) await context.addCookies(cookies)
    }
    signal?.throwIfAborted()
    const page = context.pages()[0] || (await context.newPage())
    return {
      context,
      page,
      version: resources.version,
      get warning() {
        return warning
      },
      storageState: () => context.storageState({ indexedDB: true }),
      close,
    }
  } catch (error) {
    display ||= error.pendingDisplay
    try {
      await close()
    } catch (closeError) {
      closeError.pendingSession = {
        close,
        get warning() {
          return warning
        },
      }
      closeError.startupError = error
      throw closeError
    }
    throw error
  }
}
