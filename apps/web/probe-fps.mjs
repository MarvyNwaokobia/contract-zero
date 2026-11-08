// Frame rate on each level at a few standing positions, three 4 s samples each.
// Usage: node probe-fps.mjs [webUrl]
import { chromium } from 'playwright'
const WEB = process.argv[2] ?? 'http://localhost:3000'
const SPOTS = { DUSTLINE: [[0, 14, 0], [16, -20, 0.5], [-16, -30, 0]], REDYARD: [[0, 14, 0], [-16, -30, 0]], BLACKSITE: [[0, 19, 0], [0, 0, 0], [0, -34, 3.1]] }
const browser = await chromium.launch({ channel: 'chrome' })
const out = {}
for (const zone of Object.keys(SPOTS)) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage()
  await page.goto(`${WEB}/dev/level?zone=${zone}&defense=3&seed=4`, { waitUntil: 'networkidle', timeout: 180_000 })
  await page.waitForFunction(() => typeof window.__czWarp === 'function', null, { timeout: 120_000 })
  await page.evaluate(() => window.__czSkipBriefing?.())
  await page.waitForTimeout(3000)
  out[zone] = []
  for (const [x, z, y] of SPOTS[zone]) {
    await page.evaluate(([x, z, y]) => { window.__czWarp(x, z); window.__czLook(y, -0.02) }, [x, z, y])
    const s = []
    for (let i = 0; i < 3; i++) s.push(await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 4000) requestAnimationFrame(f); else res(Math.round(n / ((performance.now() - t0) / 1000))) }; requestAnimationFrame(f) })))
    out[zone].push({ at: [x, z], fps: s })
  }
  await page.close()
}
console.log(JSON.stringify(out))
await browser.close()
