import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { createPlatformBrowserSession } from '../src/lib/openai-api/platform-browser.mjs'

/** Stock Chromium with the production session's storage/close path; never starts CloakBrowser. */
export async function createBrowserFixture({
  profileDir,
  viewport = null,
  executablePath = process.env.UI_BROWSER_EXE,
} = {}) {
  const temporary = !profileDir
  const directory = profileDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'vm2api-browser-fixture-')))
  let session
  const close = async () => {
    await session?.close()
    if (temporary) await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    let launched
    session = await createPlatformBrowserSession(
      {
        profileDir: directory,
        cacheDir: directory,
        licenseKey: 'offline-stock-fixture',
        proxyUrl: 'http://127.0.0.1:1',
      },
      {
        ...(process.platform === 'linux'
          ? {}
          : { createDisplay: async () => ({ env: process.env, close: async () => {} }) }),
        runtime: async () => ({
          executable: executablePath || chromium.executablePath(),
          get version() {
            return launched.browser().version()
          },
          async launchPersistentContext(options) {
            launched = await chromium.launchPersistentContext(options.userDataDir, {
              ...(executablePath ? { executablePath } : {}),
              headless: process.platform !== 'linux',
              env: options.launchOptions.env,
              viewport,
              timezoneId: 'America/New_York',
              proxy: { server: options.proxy },
              args: ['--no-sandbox', '--start-maximized'],
            })
            return launched
          },
        }),
      },
    )
    const { context, page } = session
    // Scenario-specific handlers override this catch-all. The dead proxy also
    // prevents unmatched requests from reaching a real account or website.
    await context.route('**/*', (route) => route.abort())
    // Persistent-context launch can resolve before the headed window has
    // presented a frame, especially when restoring a maximized profile.
    await page.bringToFront()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    return {
      ...session,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
