import assert from 'node:assert/strict'
import { createPlatformBrowserSession } from '../src/lib/openai-api/platform-browser.mjs'

// Build-time offline launch check. No real account, website or proxy is used.
const options = { proxyUrl: 'socks5h://127.0.0.1:1' }
const deps = {
  proxyLocation: async () => ({
    ip: '198.51.100.10',
    country_code: 'US',
    timezone: 'America/New_York',
    latitude: 40.71,
    longitude: -74.01,
  }),
}
let fingerprint
for (let attempt = 0; attempt < 2; attempt++) {
  const session = await createPlatformBrowserSession(
    {
      ...options,
      fingerprint,
      onFingerprint: (value) => {
        if (fingerprint) assert.deepEqual(value, fingerprint)
        fingerprint = value
      },
    },
    deps,
  )
  try {
    await session.page.goto('data:text/html,<title>vm2api browser smoke</title><p>ready</p>')
    const identity = await session.page.evaluate(() => ({
      userAgent: navigator.userAgent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }))
    assert.match(identity.userAgent, /Firefox/)
    assert.equal(identity.timezone, 'America/New_York')
    assert.ok(await session.page.screenshot({ type: 'jpeg' }))
  } finally {
    await session.close()
  }
}
console.log('Camoufox launch, saved identity restore and screenshot passed')
