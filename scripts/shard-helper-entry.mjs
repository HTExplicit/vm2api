import { Runtime, hostSpec } from '@vendor/shardx/runtime'
import { Profile, FingerprintLibrary, applyEngineVersion, adoptLibraryFields } from '@vendor/shardx/profile'
import { randomizeHardware, randomizePlatformVersion, settlePlatformVersion } from '@vendor/shardx/randomize'
import { applyScreenStrategy } from '@vendor/shardx/screen'
import { applyNoiseSeeds } from '@vendor/shardx/noise'
import { randomInt, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  const contents = JSON.stringify(value, null, 2) + '\n'
  if (existsSync(file) && readFileSync(file, 'utf8') === contents) return
  writeFileSync(`${file}.tmp`, contents, { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

function inspect(cacheDir) {
  const spec = hostSpec()
  const executablePath = join(cacheDir, ...spec.binarySubpath)
  const manifestPath = join(cacheDir, 'manifest.json')
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {}
  const stampPath = join(cacheDir, spec.binarySubpath[0], 'shardx-build')
  const build = (existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : '') || manifest.installed_engine_build
  const fingerprintsDir = join(cacheDir, 'fingerprints')
  return {
    installed: existsSync(executablePath),
    executablePath,
    version: manifest.installed_chromium_version || null,
    build: build || null,
    components: {
      browser: manifest.browser_etag || null,
      fingerprints: manifest.fingerprints_etag || null,
      widevine: manifest.widevine_etag || null,
    },
    metadata: {
      greaseBrand: manifest.installed_grease_brand,
      greaseVersion: manifest.installed_grease_version,
      tls: manifest.installed_tls,
    },
    fingerprintsDir,
    fingerprintCount: existsSync(fingerprintsDir)
      ? readdirSync(fingerprintsDir).filter((name) => name.endsWith('.json')).length
      : 0,
  }
}

function prepareProfile(cacheDir, profileDir, timezone) {
  if (!timezone) throw new Error('Browser timezone is required')
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  const installed = inspect(cacheDir)
  if (!installed.installed || !installed.version) throw new Error('Shard browser is not installed')
  const fingerprintPath = join(profileDir, 'fingerprint.json')
  const metadataPath = join(profileDir, 'shard-profile.json')
  let profile, metadata
  const created = !existsSync(fingerprintPath)
  if (created) {
    const library = new FingerprintLibrary(new Runtime({ cacheDir }))
    const templates = library.ids().filter((id) => library.load(id).claimsLinuxDesktop)
    if (!templates.length) throw new Error('No Linux desktop fingerprint templates are installed')
    const template = templates[randomInt(templates.length)]
    const id = randomUUID().replaceAll('-', '')
    profile = new Profile(library.load(template).config, id)
    metadata = { id, template }
    randomizeHardware(profile.config, id)
    randomizePlatformVersion(profile.config)
    adoptLibraryFields(profile.config, installed.fingerprintsDir)
    settlePlatformVersion(profile.config)
    applyNoiseSeeds(profile.config, id)
    applyScreenStrategy(profile.config, 'use_host')
  } else {
    metadata = readJson(metadataPath)
    profile = new Profile(readJson(fingerprintPath), metadata.id)
  }
  applyEngineVersion(
    profile.config,
    installed.version,
    installed.metadata.greaseBrand,
    installed.metadata.greaseVersion,
    installed.metadata.tls,
  )
  profile.config.timezone = timezone
  profile.config.navigator.language = 'en-US'
  profile.config.navigator.accept_language = 'en-US,en;q=0.9'
  profile.config.navigator.languages = ['en-US', 'en']
  profile.config.icu_locale = 'en-US'
  delete profile.config.geolocation
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  if (created) writeJson(metadataPath, metadata)
  writeJson(fingerprintPath, profile.config)
  return {
    executablePath: installed.executablePath,
    fingerprintPath,
    profileDir,
    version: installed.version,
    created,
    template: metadata.template,
  }
}

async function main() {
  const [command, cacheInput, ...args] = process.argv.slice(2)
  if (!cacheInput) throw new Error('Browser cache directory is required')
  const cacheDir = resolve(cacheInput)
  if (command === 'inspect') return inspect(cacheDir)
  if (command === 'create-profile') {
    if (!args[0]) throw new Error('Browser profile directory is required')
    return prepareProfile(cacheDir, resolve(args[0]), args[1])
  }
  if (command !== 'install') throw new Error('Expected install, inspect or create-profile')
  const manifestPath = join(cacheDir, 'manifest.json')
  // Upstream only refreshes the CDM when the engine changes or its receipt is
  // absent. A component-only update removes that receipt, not the installed CDM.
  if (args.includes('--refresh-widevine') && existsSync(manifestPath)) {
    const manifest = readJson(manifestPath)
    delete manifest.widevine_etag
    writeJson(manifestPath, manifest)
  }
  const shown = new Map()
  const runtime = new Runtime({
    cacheDir,
    progress(label, received, total) {
      const progress = total > 0 ? Math.min(100, Math.floor((received * 100) / total)) : null
      if (shown.get(label) === progress) return
      shown.set(label, progress)
      console.log(JSON.stringify({ type: 'progress', phase: 'downloading', progress, label }))
    },
  })
  await runtime.install({ force: args.includes('--force') })
  return inspect(cacheDir)
}

main().then(
  (result) => console.log(JSON.stringify({ type: 'result', result })),
  (error) => {
    console.error(error.message)
    process.exitCode = 1
  },
)
