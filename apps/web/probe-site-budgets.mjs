// Per-site render load, measured in the running game: draw calls, triangles and colliders at the
// player's start, for each site, in daylight and at night. These are hardware-independent
// proxies (what the GPU is asked to do), so they hold in a headless browser; frame time is not
// measured here, because a software renderer says nothing about a real device.
//   node probe-site-budgets.mjs [web]   (default http://localhost:3000)
// Exits non-zero if a site goes over its budget.
import { chromium } from 'playwright'

const WEB = process.argv[2] ?? 'http://localhost:3000'
// Budgets are ceilings with headroom over what each site measured after the Phase 6 set dressing
// (calls counted across every pass incl. post-processing, in a software renderer):
//   dustline-depot 164/181 calls, 33k tris · blacksite 180/197 calls, 98k tris · cinder-yard 219/236 calls, 54k tris (day/night)
// Before it: 158/175, 178/193, 201/218 calls and 32k, 97-111k, 50k triangles.
const CEIL = { calls: 270, triangles: 125_000 }
const BUDGET = { 'dustline-depot': CEIL, blacksite: CEIL, 'cinder-yard': CEIL }
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
let failed = 0
for (const site of Object.keys(BUDGET)) for (const phase of ['day', 'night']) {
  const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.addInitScript(() => { try { localStorage.setItem('cz_welcome_seen', '1'); localStorage.setItem('cz_settings', JSON.stringify({ quality: 'high' })) } catch {} })
  await page.goto(`${WEB}/dev/level?site=${site}&kind=raid&phase=${phase}&defense=2&seed=4`, { timeout: 180000, waitUntil: 'domcontentloaded' })
  await page.waitForSelector('canvas', { timeout: 180000 })
  for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__czDrawStats && !!window.__czSkipBriefing)); i++) await page.waitForTimeout(500)
  await page.mouse.click(640, 360); await page.evaluate(() => window.__czSkipBriefing()); await page.waitForTimeout(2500)
  const s = await page.evaluate(async () => ({ stats: await window.__czDrawStats(20), colliders: window.__czColliders().length }))
  const st = s.stats
  const calls = st.calls ?? st.drawCalls ?? st.avgCalls, tris = st.triangles ?? st.avgTriangles
  const ok = calls <= BUDGET[site].calls && tris <= BUDGET[site].triangles
  if (!ok) failed++
  console.log(ok ? 'PASS' : 'FAIL', `${site} ${phase}`, JSON.stringify({ ...st, colliders: s.colliders }))
  await page.context().close()
}
await b.close()
process.exit(failed ? 1 : 0)
