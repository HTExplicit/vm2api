import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { createPlatformBrowserSession } from '../src/lib/openai-api/platform-browser.mjs'

/** The production session, using an installed Shard cache in release CI.
 * UI-only development tests may explicitly supply an ordinary Chromium binary. */
export async function createBrowserFixture({
  profileDir,
  viewport = null,
  executablePath = process.env.UI_BROWSER_EXE,
  cacheDir = process.env.SHARD_BROWSER_CACHE_DIR,
} = {}) {
  if (!cacheDir && !executablePath) throw new Error('Set SHARD_BROWSER_CACHE_DIR to an installed test runtime')
  const temporary = !profileDir
  const directory = profileDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'vm2api-browser-fixture-')))
  let session
  const close = async () => {
    await session?.close()
    if (temporary) await fs.rm(directory, { recursive: true, force: true })
  }
  try {
    session = await createPlatformBrowserSession(
      {
        profileDir: directory,
        cacheDir: cacheDir || directory,
        timezone: 'America/New_York',
        proxyUrl: 'http://127.0.0.1:1',
      },
      {
        ...(process.platform === 'linux'
          ? {}
          : { createDisplay: async () => ({ env: process.env, close: async () => {} }) }),
        ...(executablePath
          ? {
              prepareProfile: async () => ({
                executablePath,
                fingerprintPath: path.join(directory, 'unused-test-fingerprint.json'),
                version: 'explicit-test-browser',
              }),
              launch: (options) => puppeteer.launch({ ...options, headless: process.platform !== 'linux' }),
            }
          : {}),
      },
    )
    if (viewport) await session.page.setViewport(viewport)
    if (executablePath) await session.page.emulateTimezone('America/New_York')
    // Scenario handlers own interception. The dead proxy prevents unmatched
    // fixture requests from reaching an external site or account.
    await session.page.bringToFront()
    await session.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    return {
      ...session,
      get warning() {
        return session.warning
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
