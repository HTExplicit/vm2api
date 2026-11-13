import { createRequire, builtinModules } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const root = dirname(scriptsDir)
const require = createRequire(join(scriptsDir, 'shard-helper', 'package.json'))
const { build } = require('esbuild')
const sdkRoot = dirname(dirname(require.resolve('@proxyshard/shardx')))
const pkg = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'))
if (pkg.version !== '2.1.6') throw new Error(`Expected Shard SDK 2.1.6, got ${pkg.version}`)
const sourceHashes = {
  'runtime.js': 'ad21a72334c1a478ed08300888f894f56d45f68729c3e628fc016233f460a8be',
  'profile.js': '61971667dba77d6dbcceb302508105554f81463493938f0b8516a1ec1fa3f956',
  'randomize.js': 'e2ef8e2a311f02d3fa946517a482efff0fbfa06edd8ad058da092daf606308d1',
  'host.js': '2a888480f520e7f3994afb0b81b378cdf1a33124d2fae7e2182dc69e02fbaade',
  'screen.js': 'f44aa3991cc3aebed4c5b62224e18991e24fe44a5c593c5cf7ec06fe03548727',
  'browser.js': '4658f9c3b473afa640b6185f880d7c602a092d96c0d6869a7db537dca1404281',
}
for (const [name, expected] of Object.entries(sourceHashes)) {
  const actual = createHash('sha256')
    .update(await readFile(join(sdkRoot, 'dist', name)))
    .digest('hex')
  if (actual !== expected) throw new Error(`Pinned Shard source mismatch: ${name}`)
}
// The fixed upstream helper is private; extract its unchanged functions without
// importing the browser launcher, which would pull in Patchright.
const browserSource = await readFile(join(sdkRoot, 'dist', 'browser.js'), 'utf8')
const start = browserSource.indexOf('const noiseDefault =')
const end = browserSource.indexOf('export function closeOverCdp')
if (start < 0 || end <= start) throw new Error('Pinned Shard noise helper boundaries absent')
const noiseSource = `${browserSource.slice(start, end)}\nexport { applyNoiseSeeds };\n`
const out = join(root, 'generated', 'shardbrowser')
await mkdir(out, { recursive: true })
const result = await build({
  absWorkingDir: root,
  entryPoints: [join(scriptsDir, 'shard-helper-entry.mjs')],
  outfile: join(out, 'helper.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  metafile: true,
  legalComments: 'inline',
  plugins: [
    {
      name: 'fixed-shard-modules',
      setup(builder) {
        builder.onResolve({ filter: /^@vendor\/shardx\// }, (args) => {
          const name = args.path.split('/').at(-1)
          if (name === 'noise') return { path: 'noise', namespace: 'fixed-noise' }
          if (!['runtime', 'profile', 'randomize', 'screen'].includes(name))
            throw new Error(`Unexpected Shard module: ${name}`)
          return { path: join(sdkRoot, 'dist', `${name}.js`) }
        })
        builder.onLoad({ filter: /.*/, namespace: 'fixed-noise' }, () => ({ contents: noiseSource, loader: 'js' }))
      },
    },
  ],
})
const inputs = Object.keys(result.metafile.inputs)
const imports = Object.values(result.metafile.outputs).flatMap((entry) => entry.imports)
if (
  inputs.some((name) => /(?:playwright|patchright)/i.test(name)) ||
  imports.some((entry) => !entry.path.startsWith('node:') && !builtinModules.includes(entry.path))
)
  throw new Error('Shard helper must bundle its dependencies and exclude Playwright/Patchright')
await writeFile(
  join(out, 'build-manifest.json'),
  JSON.stringify(
    {
      sdk: pkg.name,
      version: pkg.version,
      upstreamCommit: '99e780e2e685e5b3b5357c5baee8796e10b3ce1e',
      sourceHashes,
      inputs,
      imports,
      bundleSha256: createHash('sha256')
        .update(await readFile(join(out, 'helper.cjs')))
        .digest('hex'),
      noPlaywrightOrPatchright: true,
    },
    null,
    2,
  ) + '\n',
)
await writeFile(join(out, 'metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n')
await copyFile(join(scriptsDir, 'shard-helper-NOTICE'), join(out, 'NOTICE'))
const sdkRequire = createRequire(join(sdkRoot, 'package.json'))
await copyFile(join(dirname(sdkRequire.resolve('adm-zip')), 'LICENSE'), join(out, 'LICENSE.adm-zip'))
console.log(`Built ${relative(root, out)} without Playwright/Patchright`)
