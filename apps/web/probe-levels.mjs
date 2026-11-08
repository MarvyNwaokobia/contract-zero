// Browser probe for Milestone 2: the two levels in real Chrome.
//  - screenshots from player positions across each level
//  - frame rate while standing in each level (rAF count over 4 s)
//  - navigation: wake the inner guard, stand at the cargo point, and check the
//    guards actually travel (through doorways) rather than pinning to walls
// Usage: node probe-levels.mjs [webUrl] [outDir]
import { chromium } from 'playwright'

const WEB = process.argv[2] ?? 'http://localhost:3000'
const OUT = process.argv[3] ?? '.'
const out = { levels: {}, errors: [] }

const VIEWS = {
  DUSTLINE: [['gate', 0, 14, 0], ['motor-pool', -3, 3, 0.5], ['container-wall', 1, -12, 0], ['warehouse', -16, -25.5, 0], ['yard', 16, -20, 0.5]],
  BLACKSITE: [['gate', 0, 19, 0], ['courtyard', 0, 11, 0.25], ['corridor', 0, 0, 0], ['lab', -9, -3, 1.2], ['vault', 0, -31.5, 0]],
}

const browser = await chromium.launch({ channel: 'chrome' })
for (const zone of ['DUSTLINE', 'BLACKSITE']) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage()
  page.on('pageerror', (e) => out.errors.push(`${zone}: ${e.message}`))
  await page.goto(`${WEB}/dev/level?zone=${zone}&defense=3&seed=4`, { waitUntil: 'networkidle', timeout: 180_000 })
  await page.waitForSelector('canvas', { timeout: 120_000 })
  await page.waitForFunction(() => typeof window.__czWarp === 'function', null, { timeout: 120_000 })
  await page.evaluate(() => window.__czSkipBriefing?.())
  await page.waitForTimeout(3500)
  const r = { shots: [], fps: null, nav: null }
  for (const [name, x, z, yaw] of VIEWS[zone]) {
    await page.evaluate(([x, z, y]) => { window.__czWarp(x, z); window.__czLook(y, -0.02) }, [x, z, yaw])
    await page.waitForTimeout(900)
    const file = `${OUT}/m2-${zone.toLowerCase()}-${name}.png`
    await page.screenshot({ path: file })
    r.shots.push(file)
  }
  // Frame rate at the start view.
  await page.evaluate(([x, z]) => { window.__czWarp(x, z); window.__czLook(0, -0.02) }, VIEWS[zone][0].slice(1, 3))
  r.fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 4000) requestAnimationFrame(f); else res(Math.round(n / ((performance.now() - t0) / 1000))) }; requestAnimationFrame(f) }))
  // Navigation: trip the inner threshold, then stand at the cargo point.
  const pts = zone === 'BLACKSITE' ? { push: [0, 3.5], cargo: [0, -35.5] } : { push: [0, -17.5], cargo: [-16, -28.5] }
  await page.evaluate(([x, z]) => window.__czWarp(x, z), pts.push)
  await page.waitForTimeout(2500)
  await page.evaluate(([x, z]) => window.__czWarp(x, z), pts.cargo)
  const snap = () => page.evaluate(() => window.__czState().enemies.filter((e) => e.alive).map((e) => ({ id: e.id, x: e.x, z: e.z, active: e.active })))
  const a = await snap()
  await page.waitForTimeout(9000)
  const b = await snap()
  const moved = b.filter((e) => { const p = a.find((q) => q.id === e.id); return p && Math.hypot(e.x - p.x, e.z - p.z) > 2 })
  const toward = b.filter((e) => { const p = a.find((q) => q.id === e.id); return p && Math.hypot(e.x - pts.cargo[0], e.z - pts.cargo[1]) < Math.hypot(p.x - pts.cargo[0], p.z - pts.cargo[1]) - 2 })
  r.nav = { alive: b.length, active: b.filter((e) => e.active).length, moved_over_2m: moved.length, closed_in_over_2m: toward.length, player_alive: await page.evaluate(() => window.__czState().playerAlive) }
  out.levels[zone] = r
  await page.close()
}
console.log(JSON.stringify(out, null, 1))
await browser.close()
