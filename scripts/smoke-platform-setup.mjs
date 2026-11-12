import assert from 'node:assert/strict'
import { PlatformAdapter } from '../src/lib/openai-api/platform-adapter.mjs'
import { createBrowserFixture } from './browser-fixture.mjs'

const EMAIL = 'fixture@example.test'
const ORGANIZATION_ID = 'org-fixture'
const PROJECT_ID = 'proj_fixture'
const KEY_NAME = 'vm2api-offline-fixture'
const FAKE_KEY = 'sk-proj-offline-abcdefghijklmnopqrstuvwxyz0123456789'
const KEY_CREATE_PATH = `/dashboard/organizations/${ORGANIZATION_ID}/projects/${PROJECT_ID}/api_keys`

function fixturePage({ delay = 0, duplicate = false, existing = [] } = {}) {
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
  <table><tbody>${existing.map((status) => `<tr data-existing-key><td>${KEY_NAME}</td><td>${status}</td></tr>`).join('')}</tbody></table>
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
      await fetch('${KEY_CREATE_PATH}', { method: 'POST', headers: {
        'content-type': 'application/json', 'openai-organization': '${ORGANIZATION_ID}',
      }, body: JSON.stringify({
        action: 'create',
        name: dialog.querySelector('input').value,
        scopes: ['api.all'],
        admin_key: false,
        creation_source: 'default',
      }) });
    }
    void fetch('/dashboard/onboarding');
  </script></body></html>`
}

function generalFixturePage(delay) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Offline organization General</title></head>
  <body><h1>Organization settings</h1><main id="general-fields"></main>
  <button onclick="void fetch('/fixture/menu-click')">Personal Organization</button>
  <script>
    void fetch('/dashboard/onboarding').then(() => setTimeout(() => {
      const input = document.createElement('input');
      input.setAttribute('aria-label', 'Organization ID');
      input.readOnly = true;
      input.value = '${ORGANIZATION_ID}';
      document.getElementById('general-fields').append(input);
    }, ${delay}));
  </script></body></html>`
}

// Every page request is fulfilled below. A dead loopback proxy is retained as
// the transport boundary, so this smoke cannot contact a real account or site.
const browser = await createBrowserFixture({ viewport: { width: 781, height: 816 } })

const page = browser.page
let scenario = {}
const submissions = []
const unhandled = []
let organizationMenuClicks = 0
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
    if (url.pathname === '/settings/organization/general')
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: generalFixturePage(scenario.generalOrganizationDelay),
      })
    if (url.pathname === '/fixture/menu-click') {
      organizationMenuClicks++
      return route.fulfill({ status: 204 })
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 })
    if (url.pathname === '/dashboard/onboarding')
      return route.fulfill({
        status: 200,
        json: {
          ...(scenario.currentOrganization === false ? {} : { organization_id: ORGANIZATION_ID }),
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
    if (url.pathname === KEY_CREATE_PATH && request.method() === 'POST') {
      const body = request.postDataJSON()
      assert.equal(request.headers()['openai-organization'], ORGANIZATION_ID)
      assert.equal(Object.hasOwn(body, 'project_id'), false, 'the project scope comes from the official URL')
      submissions.push(body)
      return route.fulfill({
        status: 200,
        json: {
          result: 'success',
          key: {
            id: 'key_fixture',
            sensitive_id: FAKE_KEY,
            name: body.name,
            organization: ORGANIZATION_ID,
            project: PROJECT_ID,
          },
        },
      })
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
    await page.goto(
      'https://platform.openai.com' +
        (options.generalOrganizationDelay ? '/settings/organization/general' : '/fixture'),
      { waitUntil: 'domcontentloaded' },
    )
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
    assert.deepEqual(submissions, [
      { action: 'create', name: KEY_NAME, scopes: ['api.all'], admin_key: false, creation_source: 'default' },
    ])
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

  for (const existing of [['Active'], ['Revoked'], ['Unknown'], ['Active', 'Revoked']]) {
    adapter = await adapterFor({ existing })
    try {
      const before = submissions.length
      const savedExisting = []
      const configured = await adapter.configure({ keyName: KEY_NAME, onKey: (key) => savedExisting.push(key) })
      assert.equal(configured.apiKey, FAKE_KEY)
      assert.equal(savedExisting.length, 1, 'the new complete secret must be saved exactly once')
      assert.equal(await page.locator('body').getAttribute('data-opened'), '1')
      assert.equal(await page.locator('body').getAttribute('data-submitted'), '1')
      assert.equal(submissions.length, before + 1, 'existing remote records must not block one new creation')
      assert.deepEqual(
        await page.locator('[data-existing-key] td:nth-child(2)').allTextContents(),
        existing,
        'the original remote records remain untouched',
      )
    } finally {
      adapter.dispose()
    }
  }

  adapter = await adapterFor({ generalOrganizationDelay: 500, currentOrganization: false })
  let delayedOrganizationElapsedMs
  try {
    assert.equal(adapter.identity.organizationId, null, 'profile identity precedes the current organization field')
    assert.equal(
      adapter.identity.organizations.some((organization) => organization.id === ORGANIZATION_ID),
      true,
    )
    const before = submissions.length
    const savedGeneral = []
    const startedAt = Date.now()
    const configured = await adapter.configure({
      keyName: KEY_NAME,
      signal: new AbortController().signal,
      onKey: (key) => savedGeneral.push(key),
    })
    delayedOrganizationElapsedMs = Date.now() - startedAt
    assert.ok(delayedOrganizationElapsedMs >= 250, 'configuration waits for the General page to hydrate')
    assert.equal(configured.organizationId, ORGANIZATION_ID)
    assert.equal(configured.apiKey, FAKE_KEY)
    assert.equal(savedGeneral.length, 1)
    assert.equal(submissions.length, before + 1, 'the hydrated organization permits one real fixture creation')
    assert.equal(organizationMenuClicks, 0, 'the Personal menu is never mistaken for an organization switcher')
  } finally {
    adapter.dispose()
  }

  const dimensions = await page.evaluate(() => ({ outerWidth, innerWidth }))
  assert.equal(dimensions.innerWidth, 781, 'the fixture exercises the narrow content viewport')
  assert.deepEqual(unhandled, [])
  console.log(
    JSON.stringify({
      offline: true,
      testBrowser: `stock-chromium/${browser.version}`,
      ...dimensions,
      delayedEntryMs: 16_000,
      delayedSetupElapsedMs,
      hiddenEntryIgnored: true,
      ambiguousEntryStopped: true,
      existingKeysPermitNewCreation: true,
      existingRemoteRecordsPreserved: true,
      officialScopedCreateContract: true,
      delayedOrganizationElapsedMs,
      generalOrganizationHydrationObserved: true,
      organizationMenuClicks,
      fixtureKeySubmissions: submissions.length,
    }),
  )
} finally {
  await browser.close()
}
