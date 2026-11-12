import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { createHeadedDisplay } from '../src/lib/browser/headed-display.mjs'

/** Stock Chromium for offline fixtures. This never downloads or starts CloakBrowser. */
export async function createBrowserFixture({
  profileDir,
  viewport = null,
  executablePath = process.env.UI_BROWSER_EXE,
} = {}) {
  const temporary = !profileDir
  const directory = profileDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'vm2api-browser-fixture-')))
  const display = process.platform === 'linux' ? await createHeadedDisplay() : null
  let context
  const close = async () => {
    await context?.close()
    await display?.close()
    if (temporary) await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    context = await chromium.launchPersistentContext(directory, {
      ...(executablePath ? { executablePath } : {}),
      headless: process.platform !== 'linux',
      env: display?.env || process.env,
      viewport,
      timezoneId: 'America/New_York',
      proxy: { server: 'http://127.0.0.1:1' },
      args: ['--no-sandbox', '--start-maximized'],
    })
    // Scenario-specific handlers override this catch-all. The dead proxy also
    // prevents unmatched requests from reaching a real account or website.
    await context.route('**/*', (route) => route.abort())
    const page = context.pages()[0] || (await context.newPage())
    // Persistent-context launch can resolve before the headed window has
    // presented a frame, especially when restoring a maximized profile.
    await page.bringToFront()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    return {
      context,
      page,
      version: context.browser().version(),
      storageState: () => context.storageState({ indexedDB: true }),
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
