// Runs every Living World probe in turn and prints a summary. Desktop and phone-size runs are
// inside the probes themselves (standards, hub layout, texture tiers, site performance).
//   node probe-all.mjs [web] [api]     (defaults http://localhost:3000, http://localhost:8080)
// The web app and an API with AUTH_DEV_LOGIN=1 must be running. site-perf only reports.
import { spawnSync } from 'node:child_process'

const WEB = process.argv[2] ?? 'http://localhost:3000'
const API = process.argv[3] ?? 'http://localhost:8080'
const RUNS = [
  ['hub layout (desktop sizes and phone)', ['probe-hub-layout.mjs'], { WEB_URL: WEB, API_URL: API }],
  ['standards: axe, keyboard, reduced motion, touch (desktop and phone)', ['probe-standards.mjs', WEB, API]],
  ['subtitles in a fight', ['probe-subtitles.mjs', WEB]],
  ['hidden tab: hangar stops, fight pauses', ['probe-hidden.mjs', WEB]],
  ['graphics presets and Auto quality', ['probe-presets.mjs', WEB]],
  ['texture tiers (high, low, touch)', ['probe-texture-tiers.mjs', WEB]],
  ['per-site draw-call and triangle budgets', ['probe-site-budgets.mjs', WEB]],
  ['Cinder Yard catwalk, walked for real', ['probe-catwalk.mjs', WEB]],
  ['settlement guarantees without a chain', ['../../scripts/guarantees-e2e.mjs', API]],
  ['extracted run, consequence and aftermath', ['../../scripts/consequence-e2e.mjs', API]],
]
const rows = []
for (const [name, args, env] of RUNS) {
  const t = Date.now()
  const r = spawnSync('node', args, { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const lines = (r.stdout + r.stderr).split('\n')
  const pass = lines.filter((l) => l.startsWith('PASS')).length, fail = lines.filter((l) => l.startsWith('FAIL')).length
  rows.push({ name, ok: r.status === 0, pass, fail, secs: Math.round((Date.now() - t) / 1000) })
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'}  ${name}  (${pass} passed, ${fail} failed, ${Math.round((Date.now() - t) / 1000)} s)`)
  if (r.status !== 0) console.log(lines.filter((l) => l.startsWith('FAIL')).slice(0, 6).map((l) => '      ' + l.slice(0, 200)).join('\n'))
}
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} probe groups passed; ${rows.reduce((a, r) => a + r.pass, 0)} checks passed, ${rows.reduce((a, r) => a + r.fail, 0)} failed`)
process.exit(rows.every((r) => r.ok) ? 0 : 1)
