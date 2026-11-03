import assert from 'node:assert/strict'
import * as camoufox from 'camoufox'
import { launchPath } from 'camoufox/dist/pkgman.js'
import { getEnvVars, getPrefEnvVars } from 'camoufox/dist/utils.js'
import { isModelInstalled } from 'camoufox/dist/fpgen/index.js'
import { PlatformAdapter, BILLING_CREDIT_GRANTS_URL } from '../src/lib/openai-api/platform-adapter.mjs'
import { createPlatformBrowserSession, PLATFORM_BROWSER_BUILD } from '../src/lib/openai-api/platform-browser.mjs'

const EMAIL = 'billing-fixture@example.test'
const ORGANIZATION_ID = 'org-balance-fixture'
const PLATFORM_ORIGIN = 'https://platform.openai.com'
const BILLING_PATH = '/settings/organization/billing/overview'
const DELAY_MS = 16_000
const CREDIT_JSON =
  '{"object":"credit_summary","total_available":31.781779775,"total_paid_available":10.0000001,"grants":{"object":"list","data":[]}}'

function fixturePage(billing, delay) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Offline Billing</title></head>
  <body><main><h1>${billing ? 'Credit grants' : 'Platform fixture'}</h1></main><script>
  void fetch('/dashboard/onboarding').then(() => {
    ${
      billing
        ? `setTimeout(() => void fetch('${BILLING_CREDIT_GRANTS_URL}', {
      headers: {authorization:'Bearer offline-billing-fixture', 'openai-organization':'${ORGANIZATION_ID}'}
    }), ${delay});`
        : ''
    }
  });
  </script></body></html>`
}

// Install-time assets only. A dead bound proxy and a complete route allowlist
// keep this fixture from contacting an account, official key API or model.
const directory = camoufox.findInstalledVersion(PLATFORM_BROWSER_BUILD)
assert.ok(directory && isModelInstalled(), 'the image must already contain the pinned browser and model')
const executable = launchPath(directory)
const browser = await createPlatformBrowserSession(
  { proxyUrl: 'socks5h://127.0.0.1:1' },
  {
    runtime: async () => ({ ...camoufox, executable, getEnvVars, getPrefEnvVars }),
    proxyLocation: async () => ({
      ip: '198.51.100.10',
      country_code: 'US',
      timezone: 'America/New_York',
      latitude: 40.71,
      longitude: -74.01,
    }),
  },
)

const page = browser.page
const originalGoto = page.goto.bind(page)
let delay = DELAY_MS
let billingRequests = 0
const unhandled = []
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
try {
  await browser.context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === PLATFORM_ORIGIN && request.method() === 'GET') {
      if (url.pathname === '/fixture' || url.pathname === BILLING_PATH)
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: fixturePage(url.pathname === BILLING_PATH, delay),
        })
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 })
      if (url.pathname === '/dashboard/onboarding')
        return route.fulfill({
          status: 200,
          json: {
            organization_id: ORGANIZATION_ID,
            user: { email: EMAIL, orgs: { data: [{ id: ORGANIZATION_ID, title: 'Offline Billing organization' }] } },
          },
        })
    }
    if (url.href === BILLING_CREDIT_GRANTS_URL) {
      const cors = {
        'access-control-allow-origin': PLATFORM_ORIGIN,
        'access-control-allow-headers': 'authorization,openai-organization',
      }
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      if (request.method() === 'GET') {
        assert.equal(request.headers()['openai-organization'], ORGANIZATION_ID)
        assert.equal(request.headers().authorization, 'Bearer offline-billing-fixture')
        billingRequests++
        return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: CREDIT_JSON })
      }
    }
    unhandled.push({ origin: url.origin, pathname: url.pathname, method: request.method() })
    return route.abort()
  })

  async function readyAdapter() {
    const adapter = new PlatformAdapter({
      page,
      context: browser.context,
      email: EMAIL,
      organizationId: ORGANIZATION_ID,
    })
    const observed = page.waitForResponse((response) => new URL(response.url()).pathname === '/dashboard/onboarding')
    await originalGoto(PLATFORM_ORIGIN + '/fixture', { waitUntil: 'domcontentloaded' })
    await observed
    await adapter.settled()
    assert.equal((await adapter.inspect()).authenticated, true)
    return adapter
  }

  function verifySummary(adapter, summary) {
    assert.equal(summary.balance, '31.781779775')
    assert.equal(summary.paid_balance, '10.0000001')
    assert.equal(summary.displayName, 'Offline Billing organization')
    const session = adapter.billingSessionFor(ORGANIZATION_ID)
    assert.equal(session.organization_id, ORGANIZATION_ID)
    assert.equal(session.recovery_attempted, false)
    assert.equal(session.headers.authorization, 'Bearer offline-billing-fixture')
  }

  let adapter = await readyAdapter()
  let delayedElapsedMs
  try {
    const startedAt = Date.now()
    verifySummary(adapter, await adapter.readBalance({ signal: new AbortController().signal }))
    delayedElapsedMs = Date.now() - startedAt
    assert.ok(delayedElapsedMs >= 15_000, 'the balance must arrive after the former 15 second observation timeout')
    assert.ok(delayedElapsedMs < 30_000, 'one shared 30 second deadline covers navigation and the fresh balance')
  } finally {
    adapter.dispose()
  }

  delay = 100
  adapter = await readyAdapter()
  let interruptedNavigations = 0
  page.goto = async (url, options) => {
    const result = await originalGoto(url, options)
    if (url === PLATFORM_ORIGIN + BILLING_PATH && interruptedNavigations++ === 0)
      throw new Error('page.goto: NS_BINDING_ABORTED (offline continuation fixture)')
    return result
  }
  try {
    verifySummary(adapter, await adapter.readBalance({ signal: new AbortController().signal }))
    assert.equal(page.url(), PLATFORM_ORIGIN + BILLING_PATH)
    assert.equal(interruptedNavigations, 1)
    assert.equal(browser.page, page, 'the successful continuation reuses the same page')
  } finally {
    page.goto = originalGoto
    adapter.dispose()
  }

  assert.equal(billingRequests, 2)
  assert.deepEqual(unhandled, [])
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      offline: true,
      pinnedBrowser: PLATFORM_BROWSER_BUILD,
      delayedResponseMs: DELAY_MS,
      delayedElapsedMs,
      sharedDeadlineMs: 30_000,
      exactOrganization: true,
      decimalPrecision: true,
      interruptedNavigationRecovered: true,
      samePage: true,
      billingRequests,
      unhandledRequests: unhandled.length,
      pageErrors: errors.length,
      keyCreations: 0,
      modelCalls: 0,
    }),
  )
} finally {
  page.goto = originalGoto
  await browser.close()
}
