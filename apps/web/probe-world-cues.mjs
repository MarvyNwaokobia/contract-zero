// The economy made visible in the fight, on the dev bench (/dev/level), with and without cues:
//   - a line that is down: the flame is out, the steam vents are gone, the pumps and stack are
//     silent (Environment level beside the pump drops), an offline marker stands at the line;
//   - a delivery landing: amber beacons on the trucks, the engines louder.
// Screenshots go to the folder given. It measures levels and shows images; it cannot hear.
// Usage: node probe-world-cues.mjs [webUrl] [outDir]
import { chromium } from 'playwright'
const WEB = process.argv[2] ?? 'http://localhost:3000'
const OUT = process.argv[3] ?? '.'
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const report = {}

async function open(query) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${WEB}/dev/level?${query}`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
  await page.waitForFunction(() => !!window.__czAudio && typeof window.__czWarp === 'function', null, { timeout: 120_000 })
  await page.evaluate(() => window.__czSkipBriefing?.())
  await page.mouse.click(640, 380)
  await page.waitForFunction(() => !!window.__czAudio?.soundscape, null, { timeout: 30_000 })
  await page.waitForTimeout(3500)
  await page.evaluate(() => window.__czAudio.levels()); await page.waitForTimeout(300)
  return { page, errors }
}
// A place to stand with a clear line to `target`, found from the level's real colliders: not inside
// or against any box, inside the level, `dist` metres away, and nothing tall in between.
const vantage = (page, target, dist, height) => page.evaluate(([t, dist, h]) => {
  const cols = window.__czColliders(), b = window.__czAudio.currentLevel.bounds
  const blocked = (ax, az, bx, bz) => cols.some((c) => {
    if ((c.h ?? 3) < 1.6) return false
    const x0 = c.x - c.w / 2, x1 = c.x + c.w / 2, z0 = c.z - c.d / 2, z1 = c.z + c.d / 2
    let t0 = 0, t1 = 1; const dx = bx - ax, dz = bz - az
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dz, az - z0], [dz, z1 - az]]) { if (p === 0) { if (q < 0) return false; continue } const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r } else { if (r < t0) return false; if (r < t1) t1 = r } }
    return true
  })
  const inside = (x, z) => cols.some((c) => Math.abs(x - c.x) < c.w / 2 + 1.2 && Math.abs(z - c.z) < c.d / 2 + 1.2)
  for (const r of [dist, dist * 0.8, dist * 1.2, dist * 0.6, dist * 1.5]) for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2, x = t[0] + Math.cos(a) * r, z = t[1] + Math.sin(a) * r
    if (x < b.minX + 1 || x > b.maxX - 1 || z < b.minZ + 1 || z > b.maxZ - 1 || inside(x, z) || blocked(x, z, t[0], t[1])) continue
    return { x, z, pitch: Math.atan2(h, r) }
  }
  return null
}, [target, dist, height])
const lookAt = async (page, target, dist, height) => {
  const v = await vantage(page, target, dist, height)
  if (!v) return false
  await page.evaluate(([v, t]) => { window.__czWarp(v.x, v.z); window.__czLook(Math.atan2(-(t[0] - v.x), -(t[1] - v.z)), v.pitch) }, [v, target])
  return true
}
const env = async (page, ms = 1600) => { await page.evaluate(() => window.__czAudio.levels()); await page.waitForTimeout(ms); return page.evaluate(() => window.__czAudio.levels().environment) }

for (const [label, query] of [['cinder-running', 'site=cinder-yard&phase=day&defense=1&seed=4'], ['cinder-line-down', 'site=cinder-yard&phase=day&defense=1&seed=4&linesDown=fuel']]) {
  const { page, errors } = await open(query)
  const info = await page.evaluate(() => {
    const a = window.__czAudio, l = a.currentLevel
    const pumps = [...l.walls, ...l.cover].filter((b) => b.kind === 'pump')
    const stack = l.art.find((x) => x.kind === 'stack')
    const steam = l.art.filter((x) => x.kind === 'steam')
    const kinds = {}; for (const e of a.soundscape.list) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
    return { pump: pumps[0] ? [pumps[0].x, pumps[0].z] : null, stack: stack ? [stack.x, stack.z] : null, steamCount: steam.length, emitterKinds: kinds }
  })
  // the stack's top (the flame), and the line's centre where the offline marker stands
  const centre = await page.evaluate(() => { const l = window.__czAudio.currentLevel; const ps = [...[...l.walls, ...l.cover].filter((b) => b.kind === 'pump'), ...l.art.filter((a) => a.kind === 'steam' || a.kind === 'stack')]; return [ps.reduce((s, p) => s + p.x, 0) / ps.length, ps.reduce((s, p) => s + p.z, 0) / ps.length] })
  const okStack = await lookAt(page, info.stack, 26, 18)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/cues-${label}-stack.png` })
  const okLine = await lookAt(page, centre, 12, 1.5)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/cues-${label}-line.png` })
  info.framed = { okStack, okLine }
  // environment level 1.5 m from the first pump
  await page.evaluate(([x, z]) => window.__czWarp(x + 1.5, z), info.pump)
  report[label] = { errors, framed: info.framed, emitterKinds: info.emitterKinds, envBesidePump: await env(page) }
  await page.close()
}

for (const [label, query] of [['dustline-quiet', 'site=dustline-depot&phase=day&defense=1&seed=4'], ['dustline-delivery', 'site=dustline-depot&phase=day&defense=1&seed=4&delivering=1']]) {
  const { page, errors } = await open(query)
  const info = await page.evaluate(() => {
    const l = window.__czAudio.currentLevel
    const t = [...l.walls, ...l.cover].find((b) => b.kind === 'truck')
    const e = window.__czAudio.soundscape.list.filter((x) => x.kind === 'engine')
    return { truck: [t.x, t.z], boosts: e.map((x) => x.boost ?? 1) }
  })
  const okTruck = await lookAt(page, info.truck, 9, 2.6)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/cues-${label}.png` })
  info.okTruck = okTruck
  await page.evaluate(([x, z]) => window.__czWarp(x + 2, z), info.truck)
  report[label] = { errors, engineBoosts: info.boosts, envBesideTruck: await env(page) }
  await page.close()
}
console.log(JSON.stringify(report, null, 1))
await browser.close()
