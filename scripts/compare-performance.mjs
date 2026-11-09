/** Same-host offline admission A/B and billing thread-isolation acceptance. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    'baseline-root': { type: 'string' },
    'output-dir': { type: 'string', default: 'performance-results' },
  },
})
assert.ok(values['baseline-root'], '--baseline-root is required')
const root = fileURLToPath(new URL('../', import.meta.url))
const baseline = path.resolve(values['baseline-root'])
const output = path.resolve(values['output-dir'])
fs.mkdirSync(output, { recursive: true })
const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]
const rounded = (value) => Math.round(value * 1000) / 1000
const reduction = (before, after) => rounded((1 - after / before) * 100)

function run(script, args, name) {
  const report = path.join(output, `${name}.json`)
  const child = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args, '--output', report], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`${name} failed (${child.status}): ${child.stdout.slice(-3000)}`)
  return JSON.parse(fs.readFileSync(report, 'utf8'))
}

const cases = []
for (const slots of [21, 60]) {
  for (const pool of ['healthy', 'limited']) {
    for (const clients of [2, 50]) {
      const name = `${slots}-${pool}-${clients}`
      const args = ['--slots', String(slots), '--pool', pool, '--clients', String(clients)]
      const results = {}
      // Alternate ordering across cases; both checkouts receive identical warmup.
      for (const mode of cases.length % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        console.error(`Running ${name}/${mode}`)
        results[mode] = run(
          'benchmark-codex-admission.mjs',
          ['--root', mode === 'baseline' ? baseline : root, ...args],
          `codex-${name}-${mode}`,
        ).cases[0]
      }
      const before = results.baseline.summary
      const after = results.candidate.summary
      const improvement = {
        cpu_pct: reduction(before.cpu_ms_per_completed, after.cpu_ms_per_completed),
        event_loop_p99_pct: reduction(before.event_loop_p99_ms, after.event_loop_p99_ms),
        throughput_pct: rounded((after.throughput_rps / before.throughput_rps - 1) * 100),
      }
      cases.push({ slots, pool, clients, baseline: before, candidate: after, improvement })
      console.error(`${name}: ${JSON.stringify(improvement)}`)
    }
  }
}
const admission = {
  cases,
  median_improvement: {
    cpu_pct: median(cases.map((item) => item.improvement.cpu_pct)),
    event_loop_p99_pct: median(cases.map((item) => item.improvement.event_loop_p99_pct)),
    throughput_pct: median(cases.map((item) => item.improvement.throughput_pct)),
  },
}
admission.target_met =
  Math.max(admission.median_improvement.cpu_pct, admission.median_improvement.event_loop_p99_pct) >= 10 &&
  cases.every((item) => Object.values(item.improvement).every((value) => value >= -5))
fs.writeFileSync(path.join(output, 'admission-comparison.json'), `${JSON.stringify(admission, null, 2)}\n`)

const billing = run('benchmark-billing-worker.mjs', ['--root', root], 'billing-isolation')
const report = {
  baseline_root: baseline,
  candidate_root: root,
  admission,
  billing: {
    complete_results_equal: billing.complete_results_equal,
    main_thread_gap_reduction_pct: billing.main_thread_gap_reduction_pct,
    target_met: billing.target_met,
    median: billing.median,
  },
  target_met: admission.target_met && billing.target_met && billing.complete_results_equal,
  real_model_calls: 0,
  production_writes: 0,
}
fs.writeFileSync(path.join(output, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
assert.ok(report.target_met, 'offline performance acceptance thresholds were not met; inspect raw results')
