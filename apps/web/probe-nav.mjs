// Do guards reach a player standing inside a building? Wake everyone, stand at the
// cargo point, and track distance to the player over 14 s.
import { chromium } from 'playwright'
const WEB = process.argv[2] ?? 'http://localhost:3000'
const CARGO = { DUSTLINE: [-16, -28.5], BLACKSITE: [0, -35.5] }
const browser = await chromium.launch({ channel: 'chrome' })
const out = {}
for (const zone of Object.keys(CARGO)) {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 600 } })).newPage()
  await page.goto(`${WEB}/dev/level?zone=${zone}&defense=3&seed=4`, { waitUntil: 'networkidle', timeout: 180_000 })
  await page.waitForFunction(() => typeof window.__czWakeAll === 'function', null, { timeout: 120_000 })
  await page.evaluate(() => window.__czSkipBriefing?.())
  await page.waitForTimeout(2500)
  const [cx, cz] = CARGO[zone]
  await page.evaluate(([x, z]) => window.__czWarp(x, z), [cx, cz])
  await page.waitForTimeout(500) // let the sim record where the player now is
  await page.evaluate(() => window.__czWakeAll())
  const dist = () => page.evaluate(([x, z]) => window.__czState().enemies.filter((e) => e.alive).map((e) => Math.round(Math.hypot(e.x - x, e.z - z))), [cx, cz])
  const d0 = await dist()
  await page.evaluate(() => { const s = window.__czState(); window.__czGod = true })
  await page.waitForTimeout(14000)
  const d1 = await dist()
  out[zone] = { before: d0, after: d1, within_15m_before: d0.filter((d) => d <= 15).length, within_15m_after: d1.filter((d) => d <= 15).length, player_alive: await page.evaluate(() => window.__czState().playerAlive) }
  await page.close()
}
console.log(JSON.stringify(out, null, 1))
await browser.close()
