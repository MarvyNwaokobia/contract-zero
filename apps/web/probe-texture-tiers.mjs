// The low-memory tiers really hold fewer textures: touch devices and the low desktop preset load
// colour maps only. Counted from the renderer's own memory info in the running game.
//   node probe-texture-tiers.mjs [web]   (default http://localhost:3000)
import { chromium } from 'playwright'

const WEB = process.argv[2] ?? 'http://localhost:3000'
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const count = {}
for (const [name, settings, mobile] of [['high', { quality: 'high' }, false], ['low', { quality: 'low' }, false], ['touch', { quality: 'high' }, true]]) {
  const ctx = await b.newContext(mobile ? { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  await page.addInitScript((st) => { try { localStorage.setItem('cz_welcome_seen', '1'); localStorage.setItem('cz_settings', JSON.stringify(st)) } catch {} }, settings)
  await page.goto(`${WEB}/dev/level?site=cinder-yard&kind=raid&phase=day&defense=2&seed=4`, { timeout: 180000, waitUntil: 'domcontentloaded' })
  await page.waitForSelector('canvas', { timeout: 180000 })
  for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__czPerf && !!window.__czSkipBriefing)); i++) await page.waitForTimeout(500)
  await page.evaluate(() => window.__czSkipBriefing()); await page.waitForTimeout(3000)
  count[name] = (await page.evaluate(() => window.__czPerf())).textures
  await ctx.close()
}
await b.close()
console.log(JSON.stringify(count))
const ok = count.low < count.high - 10 && count.touch < count.high - 10
console.log(ok ? 'PASS' : 'FAIL', 'low and touch tiers hold at least 10 fewer textures than high')
process.exit(ok ? 0 : 1)
