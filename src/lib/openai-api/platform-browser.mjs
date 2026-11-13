import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createProxyAgent } from '../vm/proxy-agent.mjs'
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

async function prepareProfile(options) {
  const { prepareShardProfile } = await import('../browser/shard-runtime-helper.mjs')
  return prepareShardProfile(options)
}

async function launch(options) {
  const { default: puppeteer } = await import('puppeteer-core')
  return puppeteer.launch(options)
}

function processExited(child) {
  return child && (child.exitCode !== null || child.signalCode !== null)
}

/** The slot's native profile owns web storage; the DB only carries HTTP Cookie updates. */
export async function createPlatformBrowserSession(
  { profileDir, storageState, proxyUrl, timezone, cacheDir, signal },
  overrides = {},
) {
  const proxy = boundProxy(proxyUrl)
  if (!profileDir || !path.isAbsolute(profileDir) || !cacheDir || !path.isAbsolute(cacheDir)) {
    throw problem('browser_path_required', '账号浏览器目录未配置。')
  }
  if (!timezone) throw problem('browser_timezone_required', '账号代理尚未提供有效时区，请先检测代理位置。')
  signal?.throwIfAborted()
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  let relay
  let display
  let browser
  let context
  let exited
  let closing
  let browserClosed = false
  let relayClosed = false
  let displayClosed = false
  let warning = null
  const close = () => {
    if (closing) return closing
    closing = (async () => {
      if (!browserClosed) {
        if (browser) {
          const child = browser.process()
          if (!processExited(child)) {
            try {
              await browser.close()
            } catch {
              // A disconnected protocol may race the owned process's exit.
              if (!processExited(child)) throw problem('browser_close_failed', '浏览器退出未完成，请重试关闭。')
            }
          }
          if (!processExited(child)) throw problem('browser_close_failed', '浏览器进程仍在运行，请重试关闭。')
          if (child.signalCode || child.exitCode !== 0) warning = '浏览器异常退出，最后的网页状态可能未保存。'
        }
        browserClosed = true
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
    const resources = await (overrides.prepareProfile || prepareProfile)({
      cacheDir,
      profileDir,
      timezone,
      env: display.env,
      signal,
    })
    signal?.throwIfAborted()
    try {
      browser = await (overrides.launch || launch)({
        executablePath: resources.executablePath,
        userDataDir: profileDir,
        headless: false,
        defaultViewport: null,
        env: display.env,
        waitForInitialPage: false,
        timeout: 30_000,
        protocolTimeout: 60_000,
        args: [
          '--no-sandbox',
          '--no-startup-window',
          '--start-maximized',
          '--use-gl=angle',
          '--use-angle=swiftshader',
          `--fingerprint-profile=${resources.fingerprintPath}`,
          `--proxy-server=${relay.url}`,
        ],
      })
    } catch {
      signal?.throwIfAborted()
      throw problem('browser_start_failed', '账号浏览器启动失败，请检查浏览器安装。')
    }
    const child = browser.process()
    exited = processExited(child)
      ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    signal?.throwIfAborted()
    context = browser.defaultBrowserContext()
    // A normal DB snapshot can be older than the native profile after a crash.
    if (storageState?.cookies_pending === true && Array.isArray(storageState.cookies)) {
      const existing = await context.cookies()
      if (existing.length) await context.deleteCookie(...existing)
      const now = (overrides.now || Date.now)() / 1000
      const cookies = storageState.cookies.filter(
        (cookie) => cookie.expires == null || cookie.expires < 0 || cookie.expires > now,
      )
      if (cookies.length) await context.setCookie(...cookies)
    }
    signal?.throwIfAborted()
    const page = await browser.newPage()
    await page.bringToFront()
    signal?.throwIfAborted()
    return {
      browser,
      exited,
      context,
      page,
      version: resources.version,
      get warning() {
        return warning
      },
      async exportCookies() {
        let timer
        try {
          return await Promise.race([
            context.cookies(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(problem('browser_cookie_timeout', '浏览器 Cookie 保存超时。')), 3000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      },
      close,
    }
  } catch (error) {
    display ||= error.pendingDisplay
    try {
      await close()
    } catch (closeError) {
      closeError.pendingSession = {
        close,
        exited,
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
