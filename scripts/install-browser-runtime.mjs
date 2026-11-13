import path from 'node:path'
import { AccountBrowserRuntime } from '../src/lib/browser/account-browser-runtime.mjs'

// Same installer used by the panel; no browser page or real account is opened.
const dataDir = process.argv[2]
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Pass an absolute disposable or deployment data directory')
const runtime = new AccountBrowserRuntime({ dataDir })
runtime.install()
await runtime.task
const status = runtime.status()
if (status.last_error) throw new Error(status.last_error.message)
runtime.launchConfig()
console.log(
  JSON.stringify({
    installed_version: status.installed_version,
    installed_build: status.installed_build,
    phase: status.phase,
  }),
)
