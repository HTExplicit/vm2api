import assert from 'node:assert/strict'
import * as camoufox from 'camoufox'
import { launchPath } from 'camoufox/dist/pkgman.js'
import { getEnvVars, getPrefEnvVars } from 'camoufox/dist/utils.js'
import { isModelInstalled } from 'camoufox/dist/fpgen/index.js'
import { PlatformAdapter } from '../src/lib/openai-api/platform-adapter.mjs'
import { createPlatformBrowserSession, PLATFORM_BROWSER_BUILD } from '../src/lib/openai-api/platform-browser.mjs'

const EMAIL = 'fixture@example.test'
const ORGANIZATION_ID = 'org-fixture'
const PROJECT_ID = 'proj_fixture'
const KEY_NAME = 'vm2api-offline-fixture'
const FAKE_KEY = 'sk-proj-offline-abcdefghijklmnopqrstuvwxyz0123456789'

function fixturePage({ delay = 0, duplicate = false, existing = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Offline Platform fixture</title>
  <style>
    body { margin: 0; font: 16px sans-serif; }
    main { box-sizing: border-box; width: 781px; max-width: 100%; padding: 24px; }
    button { padding: 8px; }
    .zero-size { width: 0; height: 0; padding: 0; border: 0; overflow: hidden; }
    dialog > div { margin: 12px; }
  </style></head><body><main>
  <h1>API keys</h1>
  <button class="zero-size" onclick="document.body.dataset.hiddenClicks=String(Number(document.body.dataset.hiddenClicks)+1)">Create new secret key</button>
  <button id="create" style="display:none" onclick="openKeyDialog()">Create new secret key</button>
  ${duplicate ? '<button onclick="openKeyDialog()">Create new secret key</button>' : ''}
  <table><tbody>${existing ? `<tr><td>${KEY_NAME}</td></tr>` : ''}</tbody></table>
  <dialog id="key-dialog">
    <div><label>Name (Optional)</label><input type="text"></div>
    <div><label>Project</label><select><option value="${PROJECT_ID}">Default project</option></select></div>
    <button onclick="document.getElementById('expiration-menu').hidden=false">Expiration: Never</button>
    <div id="expiration-menu" hidden><button role="option" onclick="selectNever()">Never</button></div>
    <button onclick="submitKey()">Create secret key</button>
  </dialog>
  </main><script>
    Object.assign(document.body.dataset, { hiddenClicks: '0', opened: '0', submitted: '0', expiration: 'Never' });
    const showCreate = () => {
      document.getElementById('create').style.display = 'inline-block';
    };
    ${delay ? `setTimeout(showCreate, ${delay});` : 'showCreate();'}
    function openKeyDialog() {
      document.body.dataset.opened = String(Number(document.body.dataset.opened) + 1);
      document.getElementById('key-dialog').showModal();
    }
    function selectNever() {
      document.body.dataset.expiration = 'Never';
      document.getElementById('expiration-menu').hidden = true;
    }
    async function submitKey() {
      document.body.dataset.submitted = String(Number(document.body.dataset.submitted) + 1);
      const dialog = document.getElementById('key-dialog');
      await fetch('/dashboard/api_keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        name: dialog.querySelector('input').value,
        project_id: dialog.querySelector('select').value,
        expiration: document.body.dataset.expiration,
      }) });
    }
    void fetch('/dashboard/onboarding');
  </script></body></html>`
}

// Every page request is fulfilled below. A dead loopback proxy is retained as
// the transport boundary, so this smoke cannot contact a real account or site.
const directory = camoufox.findInstalledVersion(PLATFORM_BROWSER_BUILD)
assert.ok(directory && isModelInstalled(), 'the image must already contain the pinned browser and model')
const executable = launchPath(directory)
const browser = await createPlatformBrowserSession(
  { proxyUrl: 'socks5h://127.0.0.1:1' },
  {
    runtime: async () => ({
      ...camoufox,
      executable,
      getEnvVars,
      getPrefEnvVars,
      // A fresh test identity uses the launcher's coherent desktop window
      // sizing. Production identities and viewport:null remain untouched.
      launchOptions: (options) => camoufox.launchOptions({ ...options, window: [781, 816] }),
    }),
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
let scenario = {}
const submissions = []
const unhandled = []
try {
  await browser.context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== 'https://platform.openai.com') {
      unhandled.push(url.origin)
      return route.abort()
    }
    if (url.pathname === '/fixture' || url.pathname === '/api-keys')
      return route.fulfill({ status: 200, contentType: 'text/html', body: fixturePage(scenario) })
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 })
    if (url.pathname === '/dashboard/onboarding')
      return route.fulfill({
        status: 200,
        json: {
          organization_id: ORGANIZATION_ID,
          user: {
            email: EMAIL,
            orgs: {
              data: [
                {
                  id: ORGANIZATION_ID,
                  title: 'Fixture organization',
                  projects: { data: [{ id: PROJECT_ID, title: 'Default project', is_initial: true }] },
                },
              ],
            },
          },
        },
      })
    if (url.pathname === '/dashboard/api_keys' && request.method() === 'POST') {
      submissions.push(request.postDataJSON())
      return route.fulfill({ status: 200, json: { api_key: { id: 'key_fixture', secret: FAKE_KEY } } })
    }
    unhandled.push(url.pathname)
    return route.abort()
  })

  async function adapterFor(options) {
    scenario = options
    const adapter = new PlatformAdapter({
      page,
      context: browser.context,
      email: EMAIL,
      organizationId: ORGANIZATION_ID,
    })
    const observed = page.waitForResponse((response) => new URL(response.url()).pathname === '/dashboard/onboarding')
    await page.goto('https://platform.openai.com/fixture', { waitUntil: 'domcontentloaded' })
    await observed
    await adapter.settled()
    assert.equal((await adapter.inspect()).authenticated, true)
    return adapter
  }

  let adapter = await adapterFor({ delay: 16_000 })
  const saved = []
  let delayedSetupElapsedMs
  try {
    const startedAt = Date.now()
    const configured = await adapter.configure({ keyName: KEY_NAME, onKey: (key) => saved.push(key) })
    delayedSetupElapsedMs = Date.now() - startedAt
    assert.equal(configured.projectId, PROJECT_ID)
    assert.equal(configured.apiKey, FAKE_KEY)
    assert.equal(saved.length, 1)
    const state = await page.locator('body').evaluate((body) => ({ ...body.dataset }))
    assert.ok(delayedSetupElapsedMs >= 15_000, 'the fixture must appear after the former 15 second deadline')
    assert.equal(state.hiddenClicks, '0')
    assert.equal(state.opened, '1')
    assert.equal(state.submitted, '1')
    assert.deepEqual(submissions, [{ name: KEY_NAME, project_id: PROJECT_ID, expiration: 'Never' }])
  } finally {
    adapter.dispose()
  }

  adapter = await adapterFor({ duplicate: true })
  try {
    await assert.rejects(adapter.configure({ keyName: KEY_NAME }), { code: 'platform_page_changed' })
    assert.equal(await page.locator('body').getAttribute('data-opened'), '0')
    assert.equal(submissions.length, 1, 'ambiguous entry must not submit another key')
  } finally {
    adapter.dispose()
  }

  adapter = await adapterFor({ existing: true })
  try {
    await assert.rejects(adapter.configure({ keyName: KEY_NAME }), { code: 'platform_key_already_exists' })
    assert.equal(await page.locator('body').getAttribute('data-opened'), '0')
    assert.equal(submissions.length, 1, 'a pre-existing remote key must not be created again')
  } finally {
    adapter.dispose()
  }

  const dimensions = await page.evaluate(() => ({ outerWidth, innerWidth }))
  assert.equal(dimensions.outerWidth, 781)
  assert.ok(dimensions.innerWidth > 0 && dimensions.innerWidth <= 781)
  assert.deepEqual(unhandled, [])
  console.log(
    JSON.stringify({
      offline: true,
      ...dimensions,
      delayedEntryMs: 16_000,
      delayedSetupElapsedMs,
      hiddenEntryIgnored: true,
      ambiguousEntryStopped: true,
      existingKeyStopped: true,
      fixtureKeySubmissions: submissions.length,
    }),
  )
} finally {
  await browser.close()
}
